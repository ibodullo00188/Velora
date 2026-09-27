// tests/logger.test.js
// Logger moduli testlari
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Test fayli uchun vaqtinchalik log fayli
const TEST_LOG_FILE = path.join(os.tmpdir(), `kinobot-log-test-${process.pid}.log`);

// Modulni yuklashdan oldin LOG_FILE env o'rnatamiz
process.env.LOG_FILE = TEST_LOG_FILE;
process.env.LOG_LEVEL = "debug";

const { logger, LOG_LEVELS, MIN_LEVEL } = require("../src/logger");

function readLogLines() {
  if (!fs.existsSync(TEST_LOG_FILE)) return [];
  const content = fs.readFileSync(TEST_LOG_FILE, "utf-8");
  return content.trim().split("\n").filter(Boolean).map(JSON.parse);
}

beforeEach(() => {
  // Test faylini tozalash
  try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
});

afterEach(() => {
  try { fs.unlinkSync(TEST_LOG_FILE); } catch {}
});

describe("logger", () => {
  test("logger.info('x') → JSON qator, to'g'ri format", () => {
    logger.info("test message", { userId: "123", action: "login" });
    const lines = readLogLines();
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.ok(entry.time);
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "test message");
    assert.equal(entry.userId, "123");
    assert.equal(entry.action, "login");
    // ISO format vaqt tekshiruvi
    assert.ok(!isNaN(Date.parse(entry.time)));
  });

  test("logger.debug, warn, error ham ishlaydi", () => {
    logger.debug("debug msg");
    logger.warn("warn msg");
    logger.error("error msg");
    const lines = readLogLines();
    assert.equal(lines.length, 3);
    assert.equal(lines[0].level, "debug");
    assert.equal(lines[1].level, "warn");
    assert.equal(lines[2].level, "error");
  });

  test("LOG_LEVEL=error da info chiqmaydi", () => {
    // Yangi modul yuklash uchun cache'ni tozalash
    delete require.cache[require.resolve("../src/logger")];
    process.env.LOG_LEVEL = "error";
    const { logger: loggerError } = require("../src/logger");

    loggerError.info("info msg");
    loggerError.warn("warn msg");
    loggerError.error("error msg");

    const lines = readLogLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "error");
    assert.equal(lines[0].msg, "error msg");

    // Default qaytarish
    process.env.LOG_LEVEL = "debug";
    delete require.cache[require.resolve("../src/logger")];
  });

  test("Xatolik stack'lari chiqadi", () => {
    const err = new Error("Test xatosi");
    logger.error("xato yuz berdi", { err });
    const lines = readLogLines();
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.level, "error");
    assert.ok(entry.err);
    assert.equal(entry.err.message, "Test xatosi");
    assert.ok(entry.err.stack);
    assert.ok(entry.err.stack.includes("Test xatosi"));
  });

  test("requestId va userId extras sifatida yoziladi", () => {
    logger.info("request log", { requestId: "abc123", userId: "user456" });
    const lines = readLogLines();
    assert.equal(lines[0].requestId, "abc123");
    assert.equal(lines[0].userId, "user456");
  });

  test("log fayl yo'q bo'lsa console'ga yozadi (fallback)", () => {
    // LOG_FILE ni o'chirib, console'ga yozishni tekshirish
    delete require.cache[require.resolve("../src/logger")];
    delete process.env.LOG_FILE;
    const { logger: loggerConsole } = require("../src/logger");

    // console.log ni mock qilish
    const originalLog = console.log;
    const logs = [];
    console.log = (msg) => logs.push(msg);

    loggerConsole.info("console test", { foo: "bar" });
    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.msg, "console test");
    assert.equal(entry.foo, "bar");

    console.log = originalLog;
    process.env.LOG_FILE = TEST_LOG_FILE;
    delete require.cache[require.resolve("../src/logger")];
  });

  test("MIN_LEVEL va LOG_LEVELS eksport qilinadi", () => {
    assert.ok(LOG_LEVELS.debug < LOG_LEVELS.info);
    assert.ok(LOG_LEVELS.info < LOG_LEVELS.warn);
    assert.ok(LOG_LEVELS.warn < LOG_LEVELS.error);
    assert.ok(typeof MIN_LEVEL === "number");
  });
});