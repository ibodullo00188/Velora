// frontend/tests/api.test.js
// KinoBotApi (frontend/js/api.js) uchun testlar.
// fetch'ni mock qilib tekshiriladi:
//   - so'rov usuli (GET/POST)
//   - header'lar (X-Telegram-Init-Data, X-Admin-Key, Content-Type)
//   - query paramlari (genre, q, yearMin...)
//   - dev-mode userId (initData yo'q bo'lganda)
//   - {ok:false} javob — throw qilinmaydi, obyekt sifatida qaytadi
//   - tarmoq xatosi — NETWORK_ERROR fallback (xatosiz)

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// DOM/Telegram/fetch stub'ni yuklash (global.window, global.fetch va h.k.)
require(path.join(__dirname, "helpers", "domStub.js"));

const API_JS = path.join(__dirname, "..", "js", "api.js");

// api.js'ni toza holatda yuklaydi (require cache'ni tozalab) va KinoBotApi'ni qaytaradi.
// Har bir test boshlanishida chaqiriladi — modul ichidagi cachedToken shu bilan tozalanadi.
function freshApi() {
  delete require.cache[require.resolve(API_JS)];
  require(API_JS);
  return global.window.KinoBotApi;
}

// fetch'ni mock qiladi. Har bir chaqiruv calls ro'yxatiga yoziladi,
// so'ng responseFn(entry) natijasi qaytariladi.
function stubFetch(responseFn) {
  const calls = [];
  global.fetch = (url, options) => {
    const entry = { url, options };
    calls.push(entry);
    return responseFn(entry);
  };
  return calls;
}

// Standart muvaffaqiyatli javob: {ok:true, data}
function jsonOk(data) {
  return { status: 200, json: async () => ({ ok: true, data }) };
}

// Har bir test oldidan toza global holat: initData va userId yo'q.
function resetGlobals() {
  global.window.Telegram.WebApp.initData = "";
  global.window.location.search = "";
  global.window.KINOBOT_API_URL = "";
}

test("getMovies: GET so'rovi va query paramlari (genre, q, yearMin, ratingMin)", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ movies: [] }));

  await api.getMovies({ genre: "Action", q: "dune", yearMin: 2020, ratingMin: 7 });

  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(options.method, "GET");
  assert.equal(url, "/api/movies?genre=Action&q=dune&yearMin=2020&ratingMin=7");
});

test("getMovies: bo'sh/undefined paramlar query'ga kirmaydi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ movies: [] }));

  await api.getMovies({ q: "", yearMin: undefined, sort: "rating" });

  assert.equal(calls[0].url, "/api/movies?sort=rating");
});

test("toggleFavorite: POST so'rovi, JSON body va Content-Type headeri", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ isFavorite: true }));

  await api.toggleFavorite("dune2");

  const { url, options } = calls[0];
  assert.equal(options.method, "POST");
  assert.equal(url, "/api/favorites/toggle");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(options.body, '{"movieId":"dune2"}');
});

test("X-Telegram-Init-Data headeri initData mavjud bo'lganda yuboriladi", async () => {
  resetGlobals();
  global.window.Telegram.WebApp.initData = "query_id=abc&user=%7B%22id%22%3A42%7D&hash=h";
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ user: { id: "42" } }));

  await api.getProfile();

  assert.equal(
    calls[0].options.headers["X-Telegram-Init-Data"],
    global.window.Telegram.WebApp.initData
  );
  // initData mavjud — dev-mode o'chadi, userId query'ga qo'shilmaydi
  assert.equal(calls[0].url, "/api/profile");
});

test("initData bo'lmasa X-Telegram-Init-Data headeri yo'q", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ movies: [] }));

  await api.getMovies();

  assert.equal(calls[0].options.headers["X-Telegram-Init-Data"], undefined);
});

test("adminStats: X-Admin-Key headeri yuboriladi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ totalMovies: 15 }));

  await api.adminStats("maxfiy-kalit");

  assert.equal(calls[0].options.headers["X-Admin-Key"], "maxfiy-kalit");
  assert.equal(calls[0].url, "/api/admin/stats");
});

test("adminStats: days parametri query sifatida uzatiladi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ totalMovies: 15 }));

  await api.adminStats("key", 30);

  assert.equal(calls[0].url, "/api/admin/stats?days=30");
});

test("getAdminStats: adminKey siz days parametri bilan chaqiriladi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ totalMovies: 15 }));

  await api.getAdminStats(7);

  assert.equal(calls[0].url, "/api/admin/stats?days=7");
  assert.equal(calls[0].options.headers["X-Admin-Key"], undefined);
});

test("dev-mode: initData yo'q bo'lganda userId query parametr orqali uzatiladi", async () => {
  resetGlobals();
  global.window.location.search = "?userId=123456";
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ user: { id: "123456" } }));

  await api.getProfile();

  assert.equal(calls[0].url, "/api/profile?userId=123456");
});

test("KINOBOT_API_URL sozlansa resolveBase uni ishlatadi", async () => {
  resetGlobals();
  global.window.KINOBOT_API_URL = "http://localhost:3000/api";
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ movies: [] }));

  await api.getMovies();

  assert.ok(calls[0].url.startsWith("http://localhost:3000/api/movies"));
});

test("{ok:false} javob throw qilinmaydi, obyekt sifatida qaytadi", async () => {
  resetGlobals();
  const api = freshApi();
  stubFetch(() => ({
    status: 404,
    json: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Film topilmadi" } }),
  }));

  const res = await api.getMovie("yoq-film");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NOT_FOUND");
});

test("tarmoq xatosi: NETWORK_ERROR fallback qaytadi (throw emas)", async () => {
  resetGlobals();
  const api = freshApi();
  global.fetch = () => Promise.reject(new Error("ECONNREFUSED"));

  const res = await api.getMovies();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "NETWORK_ERROR");
});

test("server javobi JSON bo'lmasa BAD_RESPONSE qaytadi", async () => {
  resetGlobals();
  const api = freshApi();
  stubFetch(() => ({
    status: 500,
    json: async () => {
      throw new Error("not json");
    },
  }));

  const res = await api.getMovies();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "BAD_RESPONSE");
});

test("recordHistory: POST /api/history body'da movieId, progressPct va positionSeconds", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ ok: true }));

  await api.recordHistory("dune2", 50, 900);

  const { url, options } = calls[0];
  assert.equal(options.method, "POST");
  assert.equal(url, "/api/history");
  assert.equal(options.body, '{"movieId":"dune2","progressPct":50,"positionSeconds":900}');
});

test("getContinueWatching: GET /api/history/continue-watching", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ continueWatching: [] }));

  await api.getContinueWatching();

  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].url, "/api/history/continue-watching");
});

// ===================== PHASE 3: admin user management =====================
test("adminUsers: status/q filtrlari query parametr sifatida uzatiladi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ users: [] }));

  await api.adminUsers("kalit", { status: "BLOCKED", q: "ali" });

  assert.equal(calls[0].url, "/api/admin/users?status=BLOCKED&q=ali");
  assert.equal(calls[0].options.headers["X-Admin-Key"], "kalit");
});

test("adminUsers: bo'sh parametrlar query'ga kirmaydi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ users: [] }));

  await api.adminUsers("kalit", { status: "", q: undefined });

  assert.equal(calls[0].url, "/api/admin/users");
});

test("adminUserDetail: GET /api/admin/users/:id X-Admin-Key bilan", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ user: { id: "1001" }, stats: {} }));

  const res = await api.adminUserDetail("kalit", "1001");

  assert.equal(calls[0].url, "/api/admin/users/1001");
  assert.equal(calls[0].options.headers["X-Admin-Key"], "kalit");
  assert.equal(res.data.user.id, "1001");
});

test("adminBlockUser / adminUnblockUser: POST block endpointi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ user: { status: "BLOCKED" } }));

  await api.adminBlockUser("kalit", "1002");
  assert.equal(calls[0].url, "/api/admin/users/1002/block");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Admin-Key"], "kalit");

  calls.length = 0;
  await api.adminUnblockUser("kalit", "1002");
  assert.equal(calls[0].url, "/api/admin/users/1002/unblock");
  assert.equal(calls[0].options.method, "POST");
});

test("adminUpdateUser: PUT isAdmin/status yuboriladi", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ user: { id: "1003", isAdmin: true } }));

  await api.adminUpdateUser("kalit", "1003", { isAdmin: true });

  assert.equal(calls[0].url, "/api/admin/users/1003");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.body, '{"isAdmin":true}');
});

test("adminAuditLog: GET /api/admin/audit-log X-Admin-Key bilan", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ entries: [] }));

  await api.adminAuditLog("kalit");

  assert.equal(calls[0].url, "/api/admin/audit-log");
  assert.equal(calls[0].options.headers["X-Admin-Key"], "kalit");
});

test("adminGenreDeactivate / adminGenreActivate: POST /admin/genres/:name/deactivate(activate)", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ genre: { name: "Drama", active: false } }));

  await api.adminGenreDeactivate("kalit", "Drama");
  assert.equal(calls[0].url, "/api/admin/genres/Drama/deactivate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Admin-Key"], "kalit");

  await api.adminGenreActivate("kalit", "Drama");
  assert.equal(calls[1].url, "/api/admin/genres/Drama/activate");
  assert.equal(calls[1].options.method, "POST");
});

test("adminGenreDeactivate: maxsus belgili janr nomi encodeURIComponent bilan", async () => {
  resetGlobals();
  const api = freshApi();
  const calls = stubFetch(() => jsonOk({ genre: { name: "Sci-Fi", active: false } }));

  await api.adminGenreDeactivate("kalit", "Sci-Fi");
  assert.equal(calls[0].url, "/api/admin/genres/Sci-Fi/deactivate");
});

// ===================== PHASE 3: blocked detection =====================
test("403 FORBIDDEN kelganda isBlocked() true bo'ladi va keyingi so'rovlar to'xtaydi", async () => {
  resetGlobals();
  const api = freshApi();

  // Birinchi so'rov 403 FORBIDDEN qaytaradi (backend: user BLOCKED).
  stubFetch(() => ({
    status: 403,
    json: async () => ({ ok: false, error: { code: "FORBIDDEN", message: "Hisob bloklangan" } }),
  }));

  const first = await api.getProfile();
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "FORBIDDEN");
  assert.equal(api.isBlocked(), true);

  // Endi bloklangan — hech qanday so'rov tarmoqqa chiqmaydi.
  global.fetch = () => { throw new Error("fetch chaqirilmasligi kerak"); };
  const res = await api.getMovies();
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "USER_BLOCKED");
});

test("blocked holatda kinobot:blocked hodisasi yuboriladi", async () => {
  resetGlobals();
  const api = freshApi();
  let fired = false;
  const listener = () => { fired = true; };
  global.window.addEventListener("kinobot:blocked", listener);

  stubFetch(() => ({
    status: 403,
    json: async () => ({ ok: false, error: { code: "FORBIDDEN", message: "Hisob bloklangan" } }),
  }));

  await api.getProfile();
  assert.equal(fired, true);

  global.window.removeEventListener("kinobot:blocked", listener);
});
