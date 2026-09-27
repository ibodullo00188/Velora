// frontend/tests/structure.test.js
// Frontend tuzilishi uchun testlar:
//  - index.html'da 12 ta ekran (screen-*) mavjud;
//  - app.js'da asosiy render/navigatsiya funksiyalari mavjud.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf-8");
const APP_JS = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf-8");

// --- Ekranlar (index.html) ---
const SCREENS = [
  "screen-home", "screen-catalog", "screen-search", "screen-detail",
  "screen-player", "screen-favorites", "screen-history", "screen-profile",
  "screen-admin", "screen-settings", "screen-filter", "screen-info",
];

test("index.html 12 ekranni o'z ichiga oladi", () => {
  assert.equal(SCREENS.length, 12, "ekranlar ro'yxati 12 ta bo'lishi kerak");
  for (const id of SCREENS) {
    assert.ok(
      new RegExp(`id="${id}"`).test(HTML),
      `index.html'da #${id} ekrani topilmadi`
    );
  }
});

test("har bir ekran <section> elementi sifatida mavjud", () => {
  for (const id of SCREENS) {
    assert.ok(
      new RegExp(`<section[^>]*id="${id}"`).test(HTML),
      `#${id} <section> elementi emas`
    );
  }
});

// --- app.js asosiy funksiyalari ---
const FUNCTIONS = [
  "openScreen", "goBack", "t", "applyI18n",
  "renderHome", "renderCatalog", "renderSearch", "renderDetail", "renderPlayer",
  "renderFavorites", "renderHistory", "renderProfile", "renderAdmin", "renderFilter",
  "toggleFav", "loadData", "init",
];

test("app.js asosiy funksiyalarni e'lon qiladi", () => {
  for (const fn of FUNCTIONS) {
    const decl = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`);
    assert.ok(decl.test(APP_JS), `app.js'da 'function ${fn}' topilmadi`);
  }
});

test("app.js KinoBotApi bilan integratsiyalashgan", () => {
  // api.js bilan bog'liqlik: app.js KinoBotApi'ni ishlatishi kerak
  assert.ok(/KinoBotApi\./.test(APP_JS), "app.js KinoBotApi'ni ishlatmaydi");
});

// --- player moduli (PHASE 6) ---
test("index.html player.js skriptini va #playerQuality elementini o'z ichiga oladi", () => {
  assert.ok(/<script src="js\/player\.js(\?[^"]*)?"><\/script>/.test(HTML), "player.js skripti yo'q");
  assert.ok(/id="playerQuality"/.test(HTML), "#playerQuality elementi yo'q");
});

test("app.js KinoBotPlayer moduli bilan ishlaydi", () => {
  const PLAYER_JS = fs.readFileSync(path.join(ROOT, "js", "player.js"), "utf-8");
  assert.ok(/window\.KinoBotPlayer\s*=\s*Player/.test(PLAYER_JS), "player.js KinoBotPlayer'ni eksport qilmaydi");
  assert.ok(/KinoBotPlayer\./.test(APP_JS), "app.js KinoBotPlayer'ni ishlatmaydi");
  // app.js yordamchilarni player moduliga ochib beradi
  assert.ok(/window\.KinoBotEsc\s*=/.test(APP_JS), "app.js KinoBotEsc'ni eksport qilmaydi");
});

// --- PHASE 11: Global error handling & offline detection ---
test("app.js global xatolik handlerlarni o'rnatadi", () => {
  assert.ok(/window\.onerror\s*=\s*function/.test(APP_JS), "window.onerror handler mavjud emas");
  assert.ok(/window\.addEventListener\s*\(\s*["']unhandledrejection["']/.test(APP_JS), "unhandledrejection listener mavjud emas");
});

test("app.js offline/online detectionni qo'shadi", () => {
  assert.ok(/window\.addEventListener\s*\(\s*["']offline["']/.test(APP_JS), "offline listener mavjud emas");
  assert.ok(/window\.addEventListener\s*\(\s*["']online["']/.test(APP_JS), "online listener mavjud emas");
});

test("api.js retry logikasini o'z ichiga oladi", () => {
  const API_JS = fs.readFileSync(path.join(ROOT, "js", "api.js"), "utf-8");
  assert.ok(/retries/.test(API_JS), "api.js'da retry parametri mavjud emas");
  assert.ok(/retries\s*[-:>]\s*retries\s*-\s*1/.test(API_JS), "api.js'da retry logikasi mavjud emas");
});

// --- PHASE 12: Admin Stats tab ---
test("index.html admin panelda stats tab mavjud", () => {
  assert.ok(/data-tab="stats"/.test(HTML), "admin tab 'stats' mavjud emas");
  assert.ok(/adminStatsTab/.test(HTML), "adminStatsTab i18n kaliti mavjud emas");
});

test("app.js renderAdminStats funksiyasini e'lon qiladi", () => {
  assert.ok(/async\s+function\s+renderAdminStats/.test(APP_JS), "renderAdminStats funksiyasi topilmadi");
});

test("app.js admin tab routing'da stats mavjud", () => {
  assert.ok(/state\.adminTab\s*===\s*["']stats["']/.test(APP_JS), "admin tab routing'da 'stats' yo'q");
});
