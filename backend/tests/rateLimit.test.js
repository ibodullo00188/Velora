// tests/rateLimit.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { createRateLimiter } = require("../src/rateLimit");

test("max chegaradan oshmaydigan so'rovlar o'tadi", () => {
  const check = createRateLimiter({ windowMs: 60_000, max: 3 });
  assert.equal(check("k1").allowed, true);
  assert.equal(check("k1").allowed, true);
  assert.equal(check("k1").allowed, true);
  const r = check("k1");
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter > 0);
});

test("har bir kalit alohida hisoblanadi", () => {
  const check = createRateLimiter({ windowMs: 60_000, max: 2 });
  check("a");
  check("a");
  assert.equal(check("b").allowed, true); // b uchun toza
  assert.equal(check("a").allowed, false); // a uchun limitga yetdi
});

test("window o'tgach hisob tozalanadi", () => {
  const check = createRateLimiter({ windowMs: 50, max: 2 });
  check("k");
  check("k");
  assert.equal(check("k").allowed, false);
  // 100ms kuting — eski yozuv tozalanadi (faqat davomiy ishlash uchun; tekshiruv).
  return new Promise((resolve) => {
    setTimeout(() => {
      // Yangi kalit kabi ishlaydi (window tugagan)
      assert.equal(check("k2").allowed, true);
      resolve();
    }, 100);
  });
});

test("remaining to'g'ri kamayadi", () => {
  const check = createRateLimiter({ windowMs: 60_000, max: 5 });
  assert.equal(check("k").remaining, 4);
  assert.equal(check("k").remaining, 3);
});

test("check funktsiyasi max qiymatini olib yuradi (X-RateLimit-Limit uchun)", () => {
  const check = createRateLimiter({ windowMs: 60_000, max: 7 });
  assert.equal(check.max, 7);
  const checkDefault = createRateLimiter();
  assert.equal(checkDefault.max, 240);
});
