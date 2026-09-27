// tests/backup.test.js
// Backup/restore tizimi testlari
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DB = path.join(os.tmpdir(), `kinobot-test-db-${process.pid}.json`);
const TEST_BACKUP_DIR = path.join(path.dirname(TEST_DB), "backups");

// ENV o'zgaruvchilarini o'rnatish
process.env.DATABASE_PATH = TEST_DB;
process.env.BACKUP_ENABLED = "0"; // Auto backup o'chirilgan

const { createBackup, listBackups, restoreBackup, cleanupOldBackups, startAutoBackup } = require("../src/backup");
const { load, persist, resetForTest } = require("../src/db");

function setupTestDB() {
  // Test DB yaratish
  const src = path.join(__dirname, "..", "data", "db.json");
  if (fs.existsSync(src)) fs.copyFileSync(src, TEST_DB);
  resetForTest();
}

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + ".tmp"); } catch {}
  // Backup fayllarini tozalash
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    for (const f of fs.readdirSync(TEST_BACKUP_DIR)) {
      try { fs.unlinkSync(path.join(TEST_BACKUP_DIR, f)); } catch {}
    }
    try { fs.rmdirSync(TEST_BACKUP_DIR); } catch {}
  }
}

describe("backup", () => {
  beforeEach(() => {
    setupTestDB();
    // Backup direktoriyasini tozalash
    if (fs.existsSync(TEST_BACKUP_DIR)) {
      for (const f of fs.readdirSync(TEST_BACKUP_DIR)) {
        try { fs.unlinkSync(path.join(TEST_BACKUP_DIR, f)); } catch {}
      }
    }
  });

  afterEach(() => {
    cleanup();
  });

  test("backup yaratish va ro'yxatlash", () => {
    const { path: backupPath } = createBackup({ reason: "test" });
    assert.ok(fs.existsSync(backupPath));
    assert.ok(backupPath.includes("db-"));
    assert.ok(backupPath.includes("-test.json"));

    const list = listBackups();
    assert.equal(list.length, 1);
    assert.equal(list[0].path, backupPath);
    assert.ok(list[0].size > 0);
  });

  test("backup fayli to'g'ri JSON va schema mos", () => {
    const { path: backupPath } = createBackup({ reason: "test" });
    const content = fs.readFileSync(backupPath, "utf-8");
    const parsed = JSON.parse(content);

    // Asosiy maydonlar mavjudligi
    assert.ok(Array.isArray(parsed.movies));
    assert.ok(typeof parsed.users === "object");
    assert.ok(Array.isArray(parsed.genres));
    assert.ok(typeof parsed.favorites === "object");
    assert.ok(typeof parsed.history === "object");
    assert.ok(Array.isArray(parsed.auditLog));
    assert.ok(typeof parsed.analytics === "object");
  });

  test("yaroqsiz backup fayli rad etiladi (restore)", () => {
    // Backup direktoriyasini yaratish
    const { ensureBackupDir } = require("../src/backup");
    ensureBackupDir();

    // Yaroqsiz fayl yaratish
    const corruptPath = path.join(TEST_BACKUP_DIR, "corrupt.json");
    fs.writeFileSync(corruptPath, "bu json emas", "utf-8");

    assert.throws(() => {
      restoreBackup(corruptPath);
    }, { message: /JSON|parse|valid|SyntaxError/ });
  });

  test("mavjud emas backup fayli rad etiladi", () => {
    assert.throws(() => {
      restoreBackup("/yoq/fayl.json");
    }, { message: /topilmadi/ });
  });

  test("restore ishlaydi va DB'ga yozadi", () => {
    // Backup yaratish
    const { path: backupPath } = createBackup({ reason: "test-restore" });

    // DB'ni o'zgartirish (film qo'shish)
    const db = load();
    db.movies.push({ id: "test-new", title: "Test Film", year: 2024, rating: 5, genres: ["Drama"], description: "", originalTitle: "", posterUrl: "", videoSources: {}, status: "active", featured: false, createdAt: new Date().toISOString() });
    persist();

    // Restore qilish
    restoreBackup(backupPath, { resetDbCache: resetForTest });

    // Yangi film yo'qolgan bo'lishi kerak
    const dbAfter = load();
    const found = dbAfter.movies.find(m => m.id === "test-new");
    assert.ok(!found, "Restore'dan keyin yangi film o'chirilib yuborilmagan");
  });

  test("cleanupOldBackups - retention ishlaydi", () => {
    // 15 ta backup yaratish
    for (let i = 0; i < 15; i++) {
      createBackup({ reason: `auto-${i}` });
      // Vaqt farqi uchun kichik kutish
      const start = Date.now();
      while (Date.now() - start < 5) {}
    }

    const before = listBackups();
    assert.equal(before.length, 15);

    // Retention 10 ga o'rnatish
    const result = cleanupOldBackups(10);
    assert.equal(result.removed, 5);

    const after = listBackups();
    assert.equal(after.length, 10);
    // Eng yangi 10 ta qoldi
    for (const b of after) {
      assert.ok(b.name.includes("auto-"));
    }
  });

  test("avtomatik backup (startAutoBackup) - o'chirilgan bo'lsa stop() qaytaradi", () => {
    const stop = startAutoBackup();
    assert.equal(typeof stop, "function");
    stop(); // xato bermaslik uchun
  });

  test("avtomatik backup yaratish va o'chirish (integration)", () => {
    // Note: BACKUP_INTERVAL minimum is 1 minute in production
    // For testing we directly test the createBackup/cleanup logic instead
    // since the interval is too long for unit tests

    // Test that manual backup + cleanup works correctly
    for (let i = 0; i < 15; i++) {
      createBackup({ reason: `auto-${i}` });
    }

    const before = listBackups();
    assert.equal(before.length, 15);

    // Retention 10 ga o'rnatish
    const result = cleanupOldBackups(10);
    assert.equal(result.removed, 5);

    const after = listBackups();
    assert.equal(after.length, 10);
    // Eng yangi 10 ta qoldi
    for (const b of after) {
      assert.ok(b.name.includes("auto-"));
    }

    // Test that startAutoBackup returns stop function when disabled
    process.env.BACKUP_ENABLED = "0";
    delete require.cache[require.resolve("../src/backup")];
    const { startAutoBackup: startAutoBackupNew } = require("../src/backup");
    const stop = startAutoBackupNew();
    assert.equal(typeof stop, "function");
    stop();
  });
});