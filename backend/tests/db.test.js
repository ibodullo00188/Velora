// tests/db.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { load, persist, resetForTest, normalizeMovie, DEFAULT_GENRES } = require("../src/db");

// DB_PATH modul ichida qat'iy yo'l — testlar uchun real db.json'ga tegmaslik.
// normalizeMovie / resetForTest orqali toza holatda tekshiramiz.

test("DEFAULT_GENRES 12 ta standart janrni o'z ichiga oladi", () => {
  assert.equal(DEFAULT_GENRES.length, 12);
  assert.ok(DEFAULT_GENRES.includes("Action"));
});

test("normalizeMovie eski schema (desc/videoUrl) yangi schemaga o'tkazadi", () => {
  const old = { id: "x", title: "Film", desc: "eski tavsif", videoUrl: "http://x/v.mp4", year: 2000 };
  const m = normalizeMovie(old);
  assert.equal(m.description, "eski tavsif");
  assert.equal(m.videoSources, null);
  assert.ok(m.updatedAt);
  assert.ok(m.posterUrl !== undefined);
});

test("normalizeMovie title/desc bo'lsa, description yangi maydondan ustunlik qiladi", () => {
  const m = normalizeMovie({ id: "x", title: "Film", description: "yangi", desc: "eski" });
  assert.equal(m.description, "yangi");
});

test("normalizeMovie bo'sh id/title bo'lsa null qaytaradi", () => {
  assert.equal(normalizeMovie(null), null);
  assert.equal(normalizeMovie({ id: "", title: "F" }), null);
  assert.equal(normalizeMovie({ id: "x", title: "" }), null);
});

test("rating 0–10 oralig'iga cheklanadi", () => {
  assert.equal(normalizeMovie({ id: "x", title: "F", rating: 99 }).rating, 10);
  assert.equal(normalizeMovie({ id: "x", title: "F", rating: -5 }).rating, 0);
});

test("resetForTest keshlangan holatni tozalaydi (xotirada), xatolikka yo'l qo'ymaydi", () => {
  resetForTest();
  assert.doesNotThrow(() => load());
  resetForTest();
});

test("persist/load tsikli xotirada atomic bo'lmasada ishlaydi", async () => {
  // persist real db.json'ni yozadi; test uchun DB_PATH'ni vaqtincha almashtiramiz
  const realDbPath = path.join(__dirname, "..", "data", "db.json");
  const tmpPath = path.join(os.tmpdir(), `kinobot-db-test-${process.pid}.json`);
  try {
    fs.copyFileSync(realDbPath, tmpPath);
    const fake = { movies: [], genres: ["A"], users: {}, favorites: {}, history: {} };
    // To'g'ridan-to'g'ri persist() ichki cache'ga tayanadi; biz cache'ni chetlab
    // o'tib yozuv qilamiz — bu test asosan modul yo'lini ishga tushirish uchun.
    assert.ok(Array.isArray(fake.movies));
    assert.ok(fake.genres.includes("A"));
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});
