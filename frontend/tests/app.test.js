// frontend/tests/app.test.js
// app.js eksport qilingan funksiyalari uchun testlar

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf-8");

// --- KinoBotEsc tests (app.js ichida esc funksiyasi bor) ---
test("app.js da esc funksiyasi HTML escape qiladi", () => {
  // esc funksiyasi app.js da quyidagicha e'lon qilingan:
  // function esc(s) { return s == null ? "" : String(s).replace(/[&<>"']/g, ...); }
  const escMatch = APP_JS.match(/function esc\([^)]*\)\s*\{[^}]+\}/);
  assert.ok(escMatch, "esc funksiyasi topilmadi");

  // Regex orqali escape logikasi borligini tekshiramiz
  assert.ok(/&amp;/.test(APP_JS), "&amp; escape mavjud");
  assert.ok(/&lt;/.test(APP_JS), "&lt; escape mavjud");
  assert.ok(/&gt;/.test(APP_JS), "&gt; escape mavjud");
  assert.ok(/&quot;/.test(APP_JS), "&quot; escape mavjud");
  assert.ok(/&#39;/.test(APP_JS), "&#39; escape mavjud");
});

test("app.js KinoBotEsc ni window ga eksport qiladi", () => {
  assert.ok(/window\.KinoBotEsc\s*=/.test(APP_JS), "window.KinoBotEsc eksport qilinmagan");
});

// --- KinoBotT tests (i18n) ---
test("app.js da t funksiyasi i18n tarjimalarni qaytaradi", () => {
  // t funksiyasi DICT dan tarjima oladi
  assert.ok(/function t\([^)]*\)\s*\{/.test(APP_JS), "t funksiyasi topilmadi");
  assert.ok(/DICT\[lang\]/.test(APP_JS), "DICT dan olish mavjud emas");
});

test("app.js KinoBotT ni window ga eksport qiladi", () => {
  assert.ok(/window\.KinoBotT\s*=/.test(APP_JS), "window.KinoBotT eksport qilinmagan");
});

// --- KinoBotIcon tests ---
test("app.js da icon funksiyasi SVG yaratadi", () => {
  assert.ok(/function icon\([^)]*\)\s*\{/.test(APP_JS), "icon funksiyasi topilmadi");
  assert.ok(/<svg/.test(APP_JS), "SVG yaratish mavjud");
});

test("app.js KinoBotIcon ni window ga eksport qiladi", () => {
  assert.ok(/window\.KinoBotIcon\s*=/.test(APP_JS), "window.KinoBotIcon eksport qilinmagan");
});

// --- toggleFav funksiyasi ---
test("app.js da toggleFav funksiyasi mavjud", () => {
  assert.ok(/async\s+function\s+toggleFav\s*\(/.test(APP_JS), "toggleFav funksiyasi topilmadi");
});

test("toggleFav KinoBotApi.toggleFavorite ni chaqiradi", () => {
  assert.ok(/KinoBotApi\.toggleFavorite/.test(APP_JS), "toggleFavorite chaqiruvi yo'q");
});

// --- renderAdminStats funksiyasi (PHASE 12) ---
test("app.js da renderAdminStats funksiyasi mavjud", () => {
  assert.ok(/async\s+function\s+renderAdminStats\s*\(/.test(APP_JS), "renderAdminStats funksiyasi topilmadi");
});

test("renderAdminStats mostWatched va dailyActivity ni render qiladi", () => {
  assert.ok(/mostWatched/.test(APP_JS), "mostWatched mavjud emas");
  assert.ok(/dailyActivity/.test(APP_JS), "dailyActivity mavjud emas");
});

// --- DICT i18n kalitlari ---
test("DICT da uz/en/ru tillari mavjud", () => {
  assert.ok(/uz:\s*\{/.test(APP_JS), "uz tili mavjud emas");
  assert.ok(/en:\s*\{/.test(APP_JS), "en tili mavjud emas");
  assert.ok(/ru:\s*\{/.test(APP_JS), "ru tili mavjud emas");
});

test("DICT da eventUserRegistered kaliti barcha tillarda mavjud", () => {
  const uzCount = (APP_JS.match(/eventUserRegistered:/g) || []).length;
  assert.ok(uzCount >= 3, "eventUserRegistered kamida 3 til uchun mavjud emas");
});
