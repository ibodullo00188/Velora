// frontend/tests/i18n.test.js
// i18n DICT (frontend/js/app.js) uchun testlar.
// app.js manba fayli o'qilib, DICT obyekti qavs-balansi orqali ajratib olinadi
// (VM/regex orqali emas — satr ichidagi "{n}" kabi qavslarni to'g'ri hisoblash uchun).
// Tekshiruv: uz/en/ru uchala til bir xil kalit to'plamiga ega — hech bir kalit yo'qolmaydi.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP_JS = path.join(__dirname, "..", "js", "app.js");
const src = fs.readFileSync(APP_JS, "utf-8");

// DICT = { ... } obyekt matnini ajratib oladi va JS obyekti sifatida qaytaradi.
function extractDict() {
  const marker = "const DICT = {";
  const markerIdx = src.indexOf(marker);
  assert.ok(markerIdx !== -1, "app.js ichida 'const DICT = {' topilmadi");
  const openIdx = markerIdx + marker.indexOf("{");

  // Qavs chuqurligini hisoblab boramiz; satr ichidagi { } e'tiborsiz qoldiriladi.
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  let endIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = true; quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  assert.ok(endIdx !== -1, "DICT obyektining yopilish qavsi topilmadi");

  const dictText = src.slice(openIdx, endIdx + 1);
  // DICT — faqat string qiymatli obyekt; xavfsiz tarzda hisoblanadi.
  // eslint-disable-next-line no-new-func
  return Function("return (" + dictText + ")")();
}

const DICT = extractDict();

test("DICT uchala tilni o'z ichiga oladi (uz, en, ru)", () => {
  assert.ok(DICT.uz && typeof DICT.uz === "object", "uz til bloki yo'q");
  assert.ok(DICT.en && typeof DICT.en === "object", "en til bloki yo'q");
  assert.ok(DICT.ru && typeof DICT.ru === "object", "ru til bloki yo'q");
});

test("uz/en/ru bir xil kalit to'plamiga ega — hech bir kalit yo'qolmagan", () => {
  const keys = (lang) => Object.keys(DICT[lang]).sort();
  const uz = keys("uz");
  const en = keys("en");
  const ru = keys("ru");
  assert.deepStrictEqual(uz, en, "uz va en kalitlari farq qiladi");
  assert.deepStrictEqual(uz, ru, "uz va ru kalitlari farq qiladi");
});

test("kalitlar soni uchala tilda bir xil va bo'sh emas", () => {
  const nUz = Object.keys(DICT.uz).length;
  assert.equal(nUz, Object.keys(DICT.en).length);
  assert.equal(nUz, Object.keys(DICT.ru).length);
  assert.ok(nUz > 10, "DICT juda kichik ko'rinadi");
});

test("har bir kalit uchun uchala tilda ham bo'sh bo'lmagan tarjima bor", () => {
  for (const key of Object.keys(DICT.uz)) {
    for (const lang of ["uz", "en", "ru"]) {
      assert.ok(
        typeof DICT[lang][key] === "string" && DICT[lang][key].length > 0,
        `${lang}.${key} bo'sh yoki mavjud emas`
      );
    }
  }
});
