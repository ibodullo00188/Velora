#!/usr/bin/env node
// scripts/db-backup.js
// Joriy database'dan backup yaratadi (data/backups/ papkasiga).
//
// Ishga tushirish:  npm run db:backup
// Opsiya:            node scripts/db-backup.js --retention=10
//                    (eski backup'larni o'chirish uchun retention)

const { createBackup, cleanupOldBackups, listBackups } = require("../src/backup");
const { resetForTest } = require("../src/db");

async function main() {
  const retentionArg = process.argv.find((a) => a.startsWith("--retention="));
  const retention = retentionArg ? Number(retentionArg.split("=")[1]) : 10;

  // Backend jarayoni cache'ni yuklamasligi uchun db.js'ni haqiqiy yuklash
  // kerak emas — backup faqat diskdagi faylni nusxalaydi.
  const { path: dest } = createBackup({ reason: "manual" });
  const removed = cleanupOldBackups(retention);
  const all = listBackups();

  console.log(`✅ Backup yaratildi: ${dest}`);
  console.log(`   Saqlangan backup'lar: ${all.length} ta`);
  if (removed.removed > 0) console.log(`   ${removed.removed} ta eski backup o'chirildi (retention=${retention})`);
}

main().catch((e) => {
  console.error("Xato:", e.message);
  process.exit(1);
});
