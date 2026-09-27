// tests/validation.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { validateMovieInput, validateGenreName } = require("../src/validation");

test("to'liq, to'g'ri film ma'lumoti validatsiyadan o'tadi", () => {
  const r = validateMovieInput({
    title: "Interstellar",
    year: 2014,
    rating: 8.7,
    genres: ["Sci-Fi", "Drama"],
    duration: "2h 49m",
    description: "Koinotga sayohat",
  });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test("bo'sh title xato qaytaradi", () => {
  const r = validateMovieInput({ title: "", year: 2014 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "title"));
});

test("noto'g'ri yil xato qaytaradi", () => {
  const r = validateMovieInput({ title: "Film", year: 1800 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "year"));
});

test("0–10 dan tashqari rating xato qaytaradi", () => {
  const r = validateMovieInput({ title: "Film", year: 2020, rating: 11 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "rating"));
});

test("genres stringlar massivi bo'lmasa xato", () => {
  const r = validateMovieInput({ title: "Film", year: 2020, genres: "Drama" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "genres"));
});

test("yaroqsiz URL xato qaytaradi", () => {
  const r = validateMovieInput({ title: "Film", year: 2020, posterUrl: "not-a-url" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "posterUrl"));
});

test("http(s) URL o'tadi", () => {
  const r = validateMovieInput({ title: "Film", year: 2020, rating: 5, genres: ["Drama"], posterUrl: "https://example.com/p.jpg" });
  assert.equal(r.ok, true);
});

test("videoSources obyekt yoki null bo'lishi kerak", () => {
  const full = { title: "F", year: 2020, rating: 5, genres: ["Drama"] };
  assert.equal(validateMovieInput({ ...full, videoSources: "x" }).ok, false);
  assert.equal(validateMovieInput({ ...full, videoSources: null }).ok, true);
  assert.equal(validateMovieInput({ ...full, videoSources: {} }).ok, true);
});

test("PUT uchun partial validatsiya — faqat berilgan maydon", () => {
  const r = validateMovieInput({ rating: 8.5 }, true);
  assert.equal(r.ok, true);
});

test("partial PUT da ham noto'g'ri qiymat xato beradi", () => {
  const r = validateMovieInput({ year: 1800 }, true);
  assert.equal(r.ok, false);
});

test("validateGenreName: bo'sh/uzun nomlar rad etiladi", () => {
  assert.notEqual(validateGenreName(""), null);
  assert.notEqual(validateGenreName("   "), null);
  assert.equal(validateGenreName("Action"), null);
  assert.notEqual(validateGenreName("a".repeat(50)), null);
});

// -- PHASE 7: XSS + whitelist --

test("PHASE7: XSS-naqsh title rad etiladi", () => {
  const full = { year: 2024, rating: 5, genres: ["Drama"] };
  for (const title of ["<script>alert(1)</script>", "Film onerror=alert(1)", "javascript:alert(1)"]) {
    const r = validateMovieInput({ ...full, title });
    assert.equal(r.ok, false, `XSS rad etilmadi: ${title}`);
    assert.ok(r.errors.some((e) => e.field === "title"));
  }
});

test("PHASE7: XSS-naqsh description rad etiladi", () => {
  const r = validateMovieInput({
    title: "Film", year: 2024, rating: 5, genres: ["Drama"],
    description: "<img src=x onerror=alert(1)>",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "description"));
});

test("PHASE7: description uzunligi chegarasi (2000)", () => {
  const r = validateMovieInput({
    title: "Film", year: 2024, rating: 5, genres: ["Drama"],
    description: "a".repeat(2001),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "description"));
});

test("PHASE7: XSS-naqsh janr nomi rad etiladi", () => {
  assert.notEqual(validateGenreName("<script>xss</script>"), null);
  assert.notEqual(validateGenreName("Action onclick=alert(1)"), null);
  assert.equal(validateGenreName("Sci-Fi"), null);
});

test("PHASE7: ruxsat etilmagan maydon rad etiladi", () => {
  const r = validateMovieInput({
    title: "Film", year: 2024, rating: 5, genres: ["Drama"], hack: "x",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "hack"));
});

test("PHASE7: originalTitle validatsiyasi (uzunlik + XSS)", () => {
  const base = { title: "F", year: 2024, rating: 5, genres: ["Drama"] };
  // Uzun
  assert.equal(validateMovieInput({ ...base, originalTitle: "a".repeat(201) }).ok, false);
  // XSS
  assert.equal(validateMovieInput({ ...base, originalTitle: "<script>x</script>" }).ok, false);
  // To'g'ri
  assert.equal(validateMovieInput({ ...base, originalTitle: "The Real Title" }).ok, true);
});

test("PHASE7: ruxsat etilmagan maydon xatosi individual", () => {
  const r = validateMovieInput({ title: "F", year: 2024, rating: 5, genres: ["Drama"], foo: 1, bar: 2 });
  assert.equal(r.ok, false);
  const fields = r.errors.map((e) => e.field);
  assert.ok(fields.includes("foo"));
  assert.ok(fields.includes("bar"));
});
