#!/usr/bin/env node
// scripts/db-migrate.js
// Database schema migratsiyasi.
//
// Ishga tushirish:
//   npm run db:migrate        — db.json'ni eng yangi schemaga o'tkazadi
//   npm run db:migrate -- --check   — o'zgarishsiz tekshiradi (dry-run)
//   npm run db:migrate -- --backup  — migratsiya oldidan backup qiladi
//
// Bu script eski/yangi schema'larni normalizatsiya qiladi: yangi maydonlar
// (status, featured, positionSeconds, completed, auditLog, analytics) uchun
// default qiymatlar qo'yiladi. Ma'lumot yo'qolmaydi.

const fs = require("fs");
const path = require("path");
const dbMod = require("../src/db");
const { createBackup } = require("../src/backup");

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const doBackup = args.includes("--backup");

  const dbPath = dbMod.getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log("db.json topilmadi — hech narsa qilish shart emas.");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  } catch (e) {
    console.error("Xato: db.json o'qib bo'lmadi (korrupsiya?):", e.message);
    process.exit(1);
  }

  // Avval schema maydonlarini default'lar bilan to'ldiramiz (warnings uchun),
  // so'ng chuqur normalizatsiya qilamiz.
  const { warnings } = dbMod.validateSchema(parsed);
  const normalized = dbMod.normalize(parsed);

  if (warnings.length) {
    console.log("⚠️  Uskuna tuzatishlar (schema):");
    for (const w of warnings) console.log("   -", w);
  } else {
    console.log("✅ Schema allaqachon yangi — tuzatishlar kerak emas.");
  }

  // Yangi maydonlar mavjudligini tekshirish
  const hasNewFields =
    normalized.auditLog !== undefined && normalized.analytics !== undefined &&
    normalized.movies.every((m) => "status" in m && "featured" in m) &&
    Object.values(normalized.history).every((arr) => arr.every((h) => "positionSeconds" in h && "completed" in h));

  if (checkOnly) {
    console.log(hasNewFields ? "\nDry-run: migratsiya kerak emas." : "\nDry-run: migratsiya tavsiya etiladi.");
    return;
  }

  if (doBackup) {
    const { path: bp } = createBackup({ reason: "migrate" });
    console.log(`Backup: ${bp}`);
  }

  // Yangi normalizatsiyalangan holatni yozish
  const json = JSON.stringify(normalized, null, 2);
  const tmp = dbPath + ".tmp";
  fs.writeFileSync(tmp, json, "utf-8");
  fs.renameSync(tmp, dbPath);

  console.log("✅ db.json yangi schemaga o'tkazildi.");
  console.log("   Migratsiya yakunlandi. Serverni qayta ishga tushiring.");
}

main();
