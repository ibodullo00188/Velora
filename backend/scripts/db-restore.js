#!/usr/bin/env node
// scripts/db-restore.js
// Backup'dan database'ni tiklaydi.
//
// Ishga tushirish:
//   npm run db:restore                 — oxirgi backup'dan tiklaydi
//   npm run db:restore -- <fayl-yoli>  — aniq backup faylidan
//   npm run db:restore -- --list       — mavjud backup'larni ko'rsatadi
//
// DIQQAT: Tiklash joriy db.json'ni qayta yozadi. Server ishlab turgan bo'lsa,
// tiklashdan keyin qayta ishga tushiring (cache in-memory da qoladi).

const fs = require("fs");
const { listBackups, restoreBackup } = require("../src/backup");
const { resetForTest, getDbPath } = require("../src/db");

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    const list = listBackups();
    if (list.length === 0) {
      console.log("Backup'lar topilmadi. data/backups/ papkasini tekshiring.");
      return;
    }
    console.log("Mavjud backup'lar:");
    for (const b of list) {
      console.log(`  ${b.name}  (${(b.size / 1024).toFixed(1)} KB, ${b.mtime})`);
    }
    return;
  }

  let backupPath = args[0];
  if (!backupPath) {
    const list = listBackups();
    if (list.length === 0) {
      console.error("Backup topilmadi. Avval npm run db:backup bilan backup qiling.");
      process.exit(1);
    }
    backupPath = list[0].path;
  }

  if (!fs.existsSync(backupPath)) {
    console.error(`Backup fayl topilmadi: ${backupPath}`);
    process.exit(1);
  }

  // Joriy db.json'ni avtomatik zaxiralaymiz (xavfsizlik).
  const { createBackup } = require("../src/backup");
  createBackup({ reason: "pre-restore" });

  restoreBackup(backupPath, { resetDbCache: resetForTest });
  console.log(`✅ Tiklandi: ${backupPath}`);
  console.log(`   Manzil: ${getDbPath()}`);
  console.log("   ⚠️  Server ishlab turgan bo'lsa, uni qayta ishga tushiring.");
}

main();
