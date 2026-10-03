// Logika bersama untuk semua halaman: koneksi Firebase, helper, dan aturan pesanan/stok/antrian.
firebase.initializeApp({
  apiKey: "AIzaSyBLHND286c_gslo_P7y12A-YM8ElL0SnP8",
  authDomain: "cafe-gue.firebaseapp.com",
  projectId: "cafe-gue",
  storageBucket: "cafe-gue.firebasestorage.app",
  messagingSenderId: "1010996323532",
  appId: "1:1010996323532:web:cfd5ce7182944bcb86ce69",
});
const db = firebase.firestore();
const $ = (s) => document.querySelector(s),
  E = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"),
  R = (n) => "Rp." + Math.round(+n || 0).toLocaleString("id-ID");
const two = (n) => String(n).padStart(2, "0"),
  dk = (d = new Date()) =>
    d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
const METODE = ["Tunai", "QRIS", "Transfer", "Debit", "Lainnya"],
  KAT = ["Makanan", "Minuman", "Snack", "Dessert", "Lainnya"],
  KATX = [
    "Bahan Baku",
    "Operasional",
    "Listrik",
    "Air",
    "Internet",
    "Peralatan",
    "Maintenance",
    "Lainnya",
  ],
  MENIPIS = 5;
const WARNA = {
  "Menunggu Pembayaran": "bad",
  "Menunggu Diproses": "warn",
  "Sedang Diproses": "info",
  "Siap Diambil": "ok",
};
const AKTIF = (o) => o.status !== "Selesai" && o.status !== "Dibatalkan",
  SAH = (o) => o.statusBayar === "Dikonfirmasi" && o.status !== "Dibatalkan";
function toast(m) {
  const t = $("#toast");
  t.textContent = m;
  t.className = "on";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), 3500);
}
function modal(h) {
  closeM();
  const d = document.createElement("div");
  d.id = "mo";
  d.innerHTML = "<div class=md>" + h + "</div>";
  d.onclick = (e) => {
    if (e.target === d) closeM();
  };
  document.body.appendChild(d);
}
function closeM() {
  $("#mo")?.remove();
}
function nav(p) {
  $("#side").innerHTML =
    "<b>Cafe Gue</b>" +
    [
      ["admin", "Admin"],
      ["pesan", "Buat Pesanan"],
      ["menu", "Menu & Stok"],
      ["keuangan", "Keuangan"],
    ]
      .map(
        (x) =>
          `<a href="${x[0]}.html" class="${x[0] === p ? "on" : ""}">${x[1]}</a>`,
      )
      .join("") +
    '<a href="tv.html" target=_blank>Layar TV</a>';
}
function dengar(q, f) {
  q.onSnapshot((s) => f(s.docs.map((d) => ({ id: d.id, ...d.data() }))), galat);
}
const statusStok = (m) =>
  !m.aktif
    ? ["Nonaktif", ""]
    : m.stok <= 0
      ? ["🔴 Habis", "bad"]
      : m.stok <= MENIPIS
        ? ["🟡 Stok Menipis", "warn"]
        : ["🟢 Tersedia", "ok"];

// Buat pesanan baru: belum masuk antrian, stok belum berkurang, belum jadi pemasukan.
async function buatPesanan(meja, catatan, items) {
  const tgl = dk(),
    cref = db.doc("counters/" + tgl),
    oref = db.collection("orders").doc();
  const mrefs = items.map((i) => db.doc("menus/" + i.id));
  const noTransaksi = await db.runTransaction(async (t) => {
    const [c, ...menuSnapshots] = await Promise.all([
      t.get(cref),
      ...mrefs.map((r) => t.get(r)),
    ]);
    const orderItems = items.map((item, index) => {
      const menu = menuSnapshots[index].data() || {};
      const harga = Number(item.harga ?? menu.harga ?? 0);
      const hargaModal = Number(menu.hargaModal ?? item.hargaModal ?? 0);
      const keuntungan = Number(
        menu.keuntungan ?? item.keuntungan ?? Math.max(0, harga - hargaModal),
      );
      const pajakPersen = Number(menu.pajakPersen ?? item.pajakPersen ?? 0);
      return {
        ...item,
        harga,
        hargaModal,
        keuntungan,
        pajakPersen,
        pajak: Math.round((harga * pajakPersen) / 100),
      };
    });
    const n = ((c.exists && c.data().trx) || 0) + 1;
    const noTransaksi =
      "TRX-" + tgl.replace(/-/g, "") + "-" + String(n).padStart(3, "0");
    t.set(cref, { trx: n }, { merge: true });
    t.set(oref, {
      noTransaksi,
      meja,
      catatan,
      items: orderItems,
      total: orderItems.reduce((a, i) => a + (i.harga + i.pajak) * i.qty, 0),
      metode: "",
      statusBayar: "Menunggu",
      status: "Menunggu Pembayaran",
      noAntrian: null,
      seq: null,
      tanggal: tgl,
      waktu: Date.now(),
      stokDikurangi: false,
    });
    return noTransaksi;
  });
  return noTransaksi;
}

// Konfirmasi pembayaran: nomor antrian dibuat, stok berkurang, pesanan masuk antrian (satu transaksi, anti-duplikat).
async function konfirmasi(id, metode) {
  await db.runTransaction(async (t) => {
    const or = db.doc("orders/" + id),
      o = (await t.get(or)).data();
    if (o.status !== "Menunggu Pembayaran")
      throw Error("Pesanan ini sudah diproses");
    const cref = db.doc("counters/" + o.tanggal),
      c = await t.get(cref),
      mr = o.items.map((i) => db.doc("menus/" + i.id)),
      ms = await Promise.all(mr.map((r) => t.get(r)));
    ms.forEach((m, k) => {
      if (!m.exists || m.data().stok < o.items[k].qty)
        throw Error(o.items[k].nama + ": stok tidak cukup");
    });
    const q = ((c.exists && c.data().q) || 0) + 1;
    ms.forEach((m, k) =>
      t.update(mr[k], { stok: m.data().stok - o.items[k].qty }),
    );
    t.set(cref, { q }, { merge: true });
    t.update(or, {
      statusBayar: "Dikonfirmasi",
      metode,
      status: "Menunggu Diproses",
      noAntrian: "A" + String(q).padStart(3, "0"),
      seq: q,
      stokDikurangi: true,
      dikonfirmasiAt: Date.now(),
    });
  });
}

// Ubah status; jika dibatalkan setelah stok dikurangi, stok dikembalikan.
async function ubahStatus(id, status) {
  await db.runTransaction(async (t) => {
    const or = db.doc("orders/" + id),
      o = (await t.get(or)).data();
    let ms = [];
    if (status === "Dibatalkan" && o.stokDikurangi)
      ms = await Promise.all(
        o.items.map((i) => t.get(db.doc("menus/" + i.id))),
      );
    ms.forEach((m, k) => {
      if (m.exists) t.update(m.ref, { stok: m.data().stok + o.items[k].qty });
    });
    t.update(or, {
      status,
      ...(status === "Dibatalkan" ? { stokDikurangi: false } : {}),
    });
  });
}

// Panggil nomor antrian: TV membaca dokumen queue/state secara realtime.
const panggil = (no) =>
  db
    .doc("queue/state")
    .set(
      { current: no, calledAt: Date.now(), callId: Date.now() },
      { merge: true },
    );

// Banner galat koneksi: tampil terus (tidak hilang sendiri) agar penyebab masalah terlihat jelas.
function galat(e) {
  const k = e && e.code,
    p = {
      "permission-denied":
        "Aturan Firestore menolak akses. Buka Firebase Console → Firestore → Rules, izinkan read/write (mode uji), lalu Publish.",
      unavailable:
        "Tidak bisa terhubung ke Firestore. Pastikan internet aktif, database Firestore sudah dibuat, dan halaman dibuka dari Firebase Hosting atau localhost (bukan pratinjau di chat).",
      "not-found":
        "Database Firestore belum dibuat di proyek cafe-gue. Buat dulu di Firebase Console → Firestore Database.",
      "failed-precondition":
        "Query butuh indeks. Buka Console browser (F12) dan klik tautan pembuatan indeks pada pesan galat.",
    };
  let b = $("#err");
  if (!b) {
    b = document.createElement("div");
    b.id = "err";
    b.style.cssText =
      "position:fixed;top:0;left:0;right:0;background:#B3412E;color:#fff;padding:12px 16px;z-index:30;font-weight:600";
    document.body.prepend(b);
  }
  b.textContent =
    (p[k] || "Galat Firebase: " + (e && e.message)) + " [" + (k || "?") + "]";
}
db.doc("queue/state").get().catch(galat);
