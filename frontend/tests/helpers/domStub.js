// frontend/tests/helpers/domStub.js
// api.js'ni Node muhitida yuklash uchun minimal window/document/localStorage/
// Telegram/fetch stub. Jest/Playwright YO'Q — zero-dependency tamoyili:
// faqat node:test + node:assert ishlatiladi.
//
// api.js global `window`, `fetch`, `localStorage`, `URLSearchParams`ga tayanadi.
// Bu stub ularni ta'minlaydi. Har bir test api.js'ni qayta yuklab (freshApi)
// toza holatda ishlaydi — modul ichidagi cachedToken shu yo'l bilan tozalanadi.

"use strict";

// --- localStorage stub (xotirada saqlanadi) ---
const store = new Map();
global.localStorage = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    store.set(String(key), String(value));
  },
  removeItem(key) {
    store.delete(key);
  },
  clear() {
    store.clear();
  },
  // Testlar foydalanishi uchun ichki ombor
  _store: store,
};

// --- Telegram stub (WebApp) ---
// Testlar `global.Telegram.WebApp.initData`ni o'zgartirib auth xatti-harakatini
// sinashi mumkin.
global.Telegram = {
  WebApp: {
    initData: "",
    ready() {},
    expand() {},
    setHeaderColor() {},
    setBackgroundColor() {},
    close() {},
    BackButton: { show() {}, hide() {}, onClick() {} },
  },
};

// --- window stub ---
// api.js `window.KinoBotApi`ni shu yerga o'rnatadi. Testlar:
//   window.KINOBOT_API_URL        — base URL sozlash
//   window.Telegram.WebApp.initData — Telegram auth simulyatsiyasi
//   window.location.search        — dev-mode userId simulyatsiyasi
global.window = {
  KINOBOT_API_URL: "",
  Telegram: global.Telegram,
  location: { search: "" },
  // EventTarget stub — api.js block aniqlanganda "kinobot:blocked"
  // hodisasini dispatch qiladi; testlar listener qo'shib tekshirishi mumkin.
  _listeners: {},
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  },
  removeEventListener(type, fn) {
    const arr = this._listeners[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  dispatchEvent(event) {
    (this._listeners[event.type] || []).forEach((fn) => fn(event));
    return true;
  },
  CustomEvent: class { constructor(type) { this.type = type; } },
};

// --- fetch stub ---
// Har bir test global.fetch'ni o'z mock'i bilan almashtiradi.
// Default: so'rov qilinsa aniq xato qaytaradi — qaysi test mock'ni unutganini ko'rsatadi.
global.fetch = () => Promise.reject(new Error("fetch stub o'rnatilmagan"));
