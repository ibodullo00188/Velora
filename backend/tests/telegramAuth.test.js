// tests/telegramAuth.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { verifyTelegramInitData } = require("../src/telegramAuth");

// Haqiqiy initData'ga o'xshash satr yaratish (test uchun token ishlatamiz)
function buildInitData(token, overrides = {}) {
  const base = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAHd3F0IAAAAAN3cXQjQ",
    user: JSON.stringify({ id: 123456, first_name: "Test", username: "testuser" }),
    ...overrides,
  };
  const dataCheckString = Object.keys(base)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${base[k]}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(base);
  params.set("hash", hash);
  return params.toString();
}

const TOKEN = "123456789:TESTTOKENabcdefghijklmnop";

test("to'g'ri initData tekshiruvdan o'tadi", () => {
  const initData = buildInitData(TOKEN);
  const r = verifyTelegramInitData(initData, TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.user.id, 123456);
  assert.equal(r.user.username, "testuser");
});

test("soxta hash rad etiladi", () => {
  const initData = buildInitData(TOKEN).replace(/hash=.*/, "hash=deadbeef");
  const r = verifyTelegramInitData(initData, TOKEN);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("noto'g'ri token bilan imzo mos kelmaydi", () => {
  const initData = buildInitData(TOKEN);
  const r = verifyTelegramInitData(initData, "other-token");
  assert.equal(r.ok, false);
});

test("bo'sh initData rad etiladi", () => {
  assert.equal(verifyTelegramInitData("", TOKEN).ok, false);
  assert.equal(verifyTelegramInitData(null, TOKEN).ok, false);
});

test("hash yo'q initData rad etiladi", () => {
  const initData = new URLSearchParams({ auth_date: "1", user: "{}" }).toString();
  assert.equal(verifyTelegramInitData(initData, TOKEN).ok, false);
});

test("eskirgan initData (auth_date juda eski) rad etiladi", () => {
  const initData = buildInitData(TOKEN, { auth_date: "1000000" }); // 1970-yillar
  const r = verifyTelegramInitData(initData, TOKEN);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "initData eskirgan");
});

test("user yo'q initData rad etiladi", () => {
  const initData = buildInitData(TOKEN, { user: "{}" });
  const r = verifyTelegramInitData(initData, TOKEN);
  assert.equal(r.ok, false);
});

// -- PHASE 7: hash / user.id qattiqlashtirish --

test("PHASE7: hash qat'iy 64 hex belgidan iborat bo'lishi kerak", () => {
  // 63 belgi — format tekshiruvi rad etadi (imzo tekshiruviga yetmaydi).
  const short = buildInitData(TOKEN).replace(/hash=[0-9a-f]{64}/, "hash=" + "a".repeat(63));
  const r1 = verifyTelegramInitData(short, TOKEN);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "hash formati noto'g'ri");

  // Hex bo'lmagan belgilar ham rad etiladi.
  const nonHex = buildInitData(TOKEN).replace(/hash=[0-9a-f]{64}/, "hash=" + "g".repeat(64));
  const r2 = verifyTelegramInitData(nonHex, TOKEN);
  assert.equal(r2.ok, false);
});

test("PHASE7: user.id musbat butun son bo'lishi kerak", () => {
  const neg = buildInitData(TOKEN, { user: JSON.stringify({ id: -5, first_name: "Test" }) });
  assert.equal(verifyTelegramInitData(neg, TOKEN).ok, false);

  const frac = buildInitData(TOKEN, { user: JSON.stringify({ id: 1.5, first_name: "Test" }) });
  assert.equal(verifyTelegramInitData(frac, TOKEN).ok, false);
});
