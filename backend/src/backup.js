// src/backup.js
// Database backup/recovery tizimi.
//
// ENV:
//   BACKUP_ENABLED  — "1"/"true" bo'lsa avtomatik backup yoqiladi
//   BACKUP_INTERVAL — daqiqalarda (default 60)
//   BACKUP_RETENTION— saqlanadigan backup soni (default 10)
//
// Backup fayllari asosiy db.json'dan alohida papkada saqlanadi
// (data/backups/). Production uchun external backup (S3/R2/rsync)
// tavsiya etiladi — README'da hujjatlashtirilgan.

const fs = require("fs");
const path = require("path");
const { getDbPath, isPostgres, load } = require("./db");

const BACKUP_DIR = path.join(path.dirname(getDbPath()), "backups");

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

// Joriy holatdan backup yaratadi.
//   Fayl-rejim: diskda mavjud db.json'ni nusxalaydi (avvalgidek).
//   Postgres-rejim: db.json fayl endi manba emas (persistToFile() chaqirilmaydi),
//     shuning uchun xotiradagi (Postgresdan yuklangan) joriy holatni JSON
//     qilib shu papkaga yozamiz — lokal disk vaqtinchalik bo'lsa ham
//     (Render restart'da o'chadi), tez qo'lda tekshirish/tushirish uchun foydali.
// return { path } | throws
function createBackup({ reason = "manual" } = {}) {
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `db-${stamp}-${reason}.json`);

  if (isPostgres()) {
    fs.writeFileSync(dest, JSON.stringify(load(), null, 2), "utf-8");
    return { path: dest };
  }

  const src = getDbPath();
  if (!fs.existsSync(src)) {
    throw new Error("db.json topilmadi — backup yaratib bo'lmaydi");
  }
  fs.copyFileSync(src, dest);
  return { path: dest };
}

// Saqlangan backup'lar ro'yxati (eng yangi birinchi).
function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("db-") && f.endsWith(".json"))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

// Backup faylni asosiy db.json'ga tiklaydi.
// NOTE: restore'dan keyin process cache'ini qayta yuklash kerak —
// server ishlab turgan bo'lsa, resetDbCache() chaqirilishi lozim.
// Postgres-rejimda BU FUNKSIYA ISHLATILMAYDI (db.json endi manba emas —
// tiklash uchun `npm run db:migrate-to-postgres -- --force` dan foydalaning,
// u yerga JSON faylni to'g'ridan-to'g'ri Postgres'ga yozadi).
function restoreBackup(backupPath, { resetDbCache } = {}) {
  if (isPostgres()) {
    throw new Error(
      "Postgres-rejimda bu buyruq ishlamaydi (db.json endi manba emas). " +
        "Buning o'rniga: npm run db:migrate-to-postgres -- --force <fayl>"
    );
  }
  if (!backupPath) throw new Error("backupPath majburiy");
  const src = path.resolve(backupPath);
  if (!fs.existsSync(src)) throw new Error(`Backup topilmadi: ${backupPath}`);

  // JSON validligini va schema mosligini tekshirish
  let parsed;
  try {
    const content = fs.readFileSync(src, "utf-8");
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Backup fayli yaroqsiz JSON: ${e.message}`);
  }

  // Asosiy schema maydonlari borligini tekshirish
  const requiredFields = ["movies", "users", "genres", "favorites", "history", "auditLog", "analytics"];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Backup schemada '${field}' maydoni yo'q`);
    }
  }

  const dest = getDbPath();
  fs.copyFileSync(src, dest);
  if (typeof resetDbCache === "function") resetDbCache();
  return { path: src };
}

// Eski backup'larni o'chirish — rotation (BACKUP_RETENTION).
function cleanupOldBackups(retention = 10) {
  const list = listBackups();
  if (list.length <= retention) return { removed: 0 };
  const toRemove = list.slice(retention);
  for (const b of toRemove) {
    try {
      fs.unlinkSync(b.path);
    } catch (e) {
      // e'tiborsiz — fayl band
    }
  }
  return { removed: toRemove.length };
}

// Avtomatik backup rejalashtirish. server.js ishga tushganda chaqiriladi.
// return stop() funksiyasi
function startAutoBackup() {
  const enabled = process.env.BACKUP_ENABLED === "1" || process.env.BACKUP_ENABLED === "true";
  if (!enabled) return () => {};

  const intervalMin = Math.max(1, Number(process.env.BACKUP_INTERVAL) || 60);
  const retention = Math.max(1, Number(process.env.BACKUP_RETENTION) || 10);
  const intervalMs = intervalMin * 60 * 1000;

  const timer = setInterval(() => {
    try {
      createBackup({ reason: "auto" });
      cleanupOldBackups(retention);
    } catch (e) {
      console.error("[backup] Avtomatik backup xatosi:", e.message);
    }
  }, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  restoreBackup,
  cleanupOldBackups,
  startAutoBackup,
  ensureBackupDir,
};
