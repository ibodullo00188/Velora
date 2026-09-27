// tests/server.test.js
// Real server'ni alohida jarayonda ishga tushirib, HTTP orqali sinaydi.
// Test uchun ajratilgan port va soxta admin kalitidan foydalanadi.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_PORT = 4499;
const ADMIN_KEY = "test-key-123";
const BASE = `http://localhost:${TEST_PORT}/api`;
// Testlar asosiy data/db.json'ni buzmasligi uchun alohida vaqtinchalik DB.
const TEST_DB = path.join(os.tmpdir(), `kinobot-test-db-${process.pid}.json`);
// Kali lokal video papkasi ham vaqtinchalik — hermetic test uchun.
const TEST_VIDEO_DIR = path.join(os.tmpdir(), `kinobot-test-videos-${process.pid}`);

let child;
let stderr = "";

before(async () => {
  // Test DB — jonli data/db.json'ga HECH QACHON bog'liq emas (hermetic).
  // Sobit seed fixture'dan nusxalanadi, shuning uchun test natijalari
  // production ma'lumoti qancha o'zgarishidan qat'iy nazar barqaror bo'ladi.
  const src = path.join(__dirname, "fixtures", "seed-db.json");
  fs.copyFileSync(src, TEST_DB);

  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ADMIN_KEY,
      DEV_MODE: "1",
      BOT_TOKEN: "123456789:TESTTOKENabcdefghijklmnop",
      DATABASE_PATH: TEST_DB,
      LOCAL_VIDEOS_DIR: TEST_VIDEO_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => (stderr += d));
  // Server tayyor bo'lishini kutish
  await waitForServer(BASE, 8_000);
});

after(() => {
  if (child) child.kill();
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + ".tmp"); } catch {}
  try { fs.rmSync(TEST_VIDEO_DIR, { recursive: true, force: true }); } catch {}
});

function waitForServer(base, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() - start > timeoutMs) return reject(new Error("Server ishga tushmadi\n" + stderr));
      try {
        const r = await fetch(`${base}/health`);
        if (r.ok) return resolve();
      } catch {}
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function req(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// Telegram WebApp initData'ni test uchun to'g'ri imzo bilan quradi
// (src/telegramAuth.js'dagi tekshiruv algoritmi bilan bir xil — HMAC-SHA256).
const crypto = require("crypto");
const TEST_BOT_TOKEN = "123456789:TESTTOKENabcdefghijklmnop";
function signInitData(user) {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(TEST_BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckArr.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("GET /health -> 200 ok", async () => {
  const { status, json } = await req("/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test("GET /movies qaytadi va filmlar yangi schema'da", async () => {
  const { status, json } = await req("/movies");
  assert.equal(status, 200);
  assert.ok(json.data.count >= 10);
  const m = json.data.movies[0];
  assert.ok("description" in m);
  assert.ok("originalTitle" in m);
  assert.ok("posterUrl" in m);
  assert.ok("videoSources" in m);
});

test("GET /movies?q=search works", async () => {
  const { json } = await req("/movies?q=avenger");
  assert.ok(json.data.movies.some((m) => m.title.toLowerCase().includes("avenger")));
});

test("GET /movies?genre= filter works", async () => {
  const { json } = await req("/movies?genre=Horror");
  assert.ok(json.data.movies.every((m) => m.genres.includes("Horror")));
});

test("GET /movies/:id detail + similar", async () => {
  const { status, json } = await req("/movies/johnwick4");
  assert.equal(status, 200);
  assert.equal(json.data.movie.id, "johnwick4");
  assert.ok(Array.isArray(json.data.similar));
});

test("GET /movies/nonexistent -> 404", async () => {
  const { status, json } = await req("/movies/nope-xyz");
  assert.equal(status, 404);
  assert.equal(json.error.code, "NOT_FOUND");
});

test("GET /genres -> 200", async () => {
  const { json } = await req("/genres");
  assert.ok(json.data.genres.length >= 10);
});

// -- Himoyalangan endpointlar (dev-mode userId bilan) --
test("favorites toggle on/off ishlaydi", async () => {
  await req("/profile?userId=999");
  const on = await req("/favorites/toggle?userId=999", { method: "POST", body: JSON.stringify({ movieId: "johnwick4" }) });
  assert.equal(on.json.data.isFavorite, true);
  const list = await req("/favorites?userId=999");
  assert.ok(list.json.data.movies.some((m) => m.id === "johnwick4"));
  const off = await req("/favorites/toggle?userId=999", { method: "POST", body: JSON.stringify({ movieId: "johnwick4" }) });
  assert.equal(off.json.data.isFavorite, false);
});

test("favorites: noto'g'ri body -> 400", async () => {
  const r = await req("/favorites/toggle?userId=999", { method: "POST", body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("auth himoyasi: initData'siz profile -> 401", async () => {
  const { status, json } = await req("/profile");
  assert.equal(status, 401);
  assert.equal(json.error.code, "UNAUTHORIZED");
});

test("history record + get", async () => {
  await req("/history?userId=888", { method: "POST", body: JSON.stringify({ movieId: "johnwick4", progressPct: 42 }) });
  const { json } = await req("/history?userId=888");
  assert.equal(json.data.history[0].movieId, "johnwick4");
  assert.equal(json.data.history[0].progressPct, 42);
});

test("history: positionSeconds saqlanadi va continue-watching 1..94% filmlarni qaytaradi", async () => {
  const uid = "889";
  // 50% — davom etishga kiradi
  await req(`/history?userId=${uid}`, { method: "POST", body: JSON.stringify({ movieId: "johnwick4", progressPct: 50, positionSeconds: 900 }) });
  // 100% (completed) — continue-watching'ga kirmaydi
  await req(`/history?userId=${uid}`, { method: "POST", body: JSON.stringify({ movieId: "avengers4", progressPct: 100, positionSeconds: 0 }) });
  // 0% — boshlanmagan, kirmaydi
  await req(`/history?userId=${uid}`, { method: "POST", body: JSON.stringify({ movieId: "fightclub", progressPct: 0, positionSeconds: 0 }) });

  const { json } = await req(`/history/continue-watching?userId=${uid}`);
  assert.equal(json.ok, true);
  const cw = json.data.continueWatching;
  assert.equal(cw.length, 1);
  assert.equal(cw[0].movieId, "johnwick4");
  assert.equal(cw[0].progressPct, 50);
  assert.equal(cw[0].positionSeconds, 900);
  assert.ok(cw[0].movie && cw[0].movie.title);

  // Umumiy tarixda 3 yozuv ham bor
  const all = await req(`/history?userId=${uid}`);
  assert.equal(all.json.data.history.length, 3);
});

// -- Admin --
test("admin: ruxsatsiz -> 403", async () => {
  const { status } = await req("/admin/stats");
  assert.equal(status, 403);
});

test("admin: noto'g'ri kalit -> 403", async () => {
  const { status } = await req("/admin/stats", { headers: { "X-Admin-Key": "wrong" } });
  assert.equal(status, 403);
});

test("admin: to'g'ri kalit bilan stats", async () => {
  const { status, json } = await req("/admin/stats", { headers: { "X-Admin-Key": ADMIN_KEY } });
  assert.equal(status, 200);
  assert.ok(json.data.totalMovies >= 10);
});

test("admin: to'liq CRUD sikli (create->update->delete)", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const created = await req("/admin/movies", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ title: "CRUD Test", year: 2024, rating: 7.0, genres: ["Drama"] }),
  });
  assert.equal(created.status, 201);
  const id = created.json.data.movie.id;

  const updated = await req(`/admin/movies/${id}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ rating: 9.9 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.movie.rating, 9.9);

  const deleted = await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
  assert.equal(deleted.status, 200);

  const gone = await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
  assert.equal(gone.status, 404);
});

test("admin: film status filtri (active/inactive/hidden) va status yangilash", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const created = await req("/admin/movies", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ title: "Status Filter Test", year: 2025, rating: 6.0, genres: ["Drama"] }),
  });
  assert.equal(created.status, 201);
  const id = created.json.data.movie.id;
  // Yangi film default active bo'ladi
  assert.equal(created.json.data.movie.status, "active");

  // hidden ga o'tkazamiz
  const upd = await req(`/admin/movies/${id}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ status: "hidden" }),
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.movie.status, "hidden");

  // hidden filtri uni topadi, active filtri topmaydi
  const hidden = await req("/admin/movies?status=hidden", { headers: h });
  assert.equal(hidden.status, 200);
  assert.ok(hidden.json.data.movies.some((m) => m.id === id));

  const active = await req("/admin/movies?status=active", { headers: h });
  assert.ok(!active.json.data.movies.some((m) => m.id === id));

  // "hidden" (yashirin) status — ommaviy katalogda va film detalida hech
  // kimga ko'rinmaydi (parol/kalit orqali ko'rish funksiyasi olib tashlandi —
  // bu status endi faqat admin panelning ichki ko'rinish boshqaruvi).
  const publicCatalog = await req("/movies");
  assert.ok(!publicCatalog.json.data.movies.some((m) => m.id === id));
  const publicDetail = await req(`/movies/${id}`);
  assert.equal(publicDetail.status, 404);

  // noto'g'ri status 422 qaytaradi
  const bad = await req(`/admin/movies/${id}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ status: "bogus" }),
  });
  assert.equal(bad.status, 422);

  // tozalash
  await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
});

test("admin: noto'g'ri film yaratish -> 422", async () => {
  const { status, json } = await req("/admin/movies", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ title: "", year: 1800 }),
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("admin: janr qo'shish/duplikat/o'chirish", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const add = await req("/admin/genres", { method: "POST", headers: h, body: JSON.stringify({ name: "Neo-Noir" }) });
  assert.equal(add.status, 201);
  const dup = await req("/admin/genres", { method: "POST", headers: h, body: JSON.stringify({ name: "Neo-Noir" }) });
  assert.equal(dup.status, 409);
  const del = await req("/admin/genres/Neo-Noir", { method: "DELETE", headers: h });
  assert.equal(del.status, 200);
});

test("admin: janr deactivate/activate — admin ro'yxati active flag bilan, jamoatda yashirinadi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  // Admin ro'yxati hamma janrlarni active holati bilan qaytaradi
  const list = await req("/admin/genres", { headers: h });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.data.genres));
  assert.ok(list.json.data.genres.every((g) => typeof g.name === "string" && typeof g.active === "boolean"));

  // Drama'ni vaqtincha deaktiv qilamiz
  const before = await req("/genres");
  assert.ok(before.json.data.genres.includes("Drama"));

  const deact = await req("/admin/genres/Drama/deactivate", { method: "POST", headers: h });
  assert.equal(deact.status, 200);
  assert.equal(deact.json.data.genre.active, false);

  // Jamoat ro'yxatidan yashiriladi, admin ro'yxatida hali ham ko'rinadi
  const pub = await req("/genres");
  assert.ok(!pub.json.data.genres.includes("Drama"));
  const adminList2 = await req("/admin/genres", { headers: h });
  const drama = adminList2.json.data.genres.find((g) => g.name === "Drama");
  assert.equal(drama.active, false);

  // Qayta faollashtirish
  const act = await req("/admin/genres/Drama/activate", { method: "POST", headers: h });
  assert.equal(act.status, 200);
  assert.equal(act.json.data.genre.active, true);
  const pub2 = await req("/genres");
  assert.ok(pub2.json.data.genres.includes("Drama"));
});

test("admin: foydalanuvchilar ro'yxati", async () => {
  const { status, json } = await req("/admin/users", { headers: { "X-Admin-Key": ADMIN_KEY } });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.data.users));
});

// -- PHASE 3: User management --
test("admin: user detali + statistika", async () => {
  await req("/profile?userId=1001"); // user yaratish
  const { status, json } = await req("/admin/users/1001", { headers: { "X-Admin-Key": ADMIN_KEY } });
  assert.equal(status, 200);
  assert.equal(json.data.user.id, "1001");
  assert.ok("favoritesCount" in json.data.stats);
  assert.ok("historyCount" in json.data.stats);
});

test("admin: user block/unblock, blocked user rad etiladi", async () => {
  await req("/profile?userId=1002"); // user yaratish
  const h = { "X-Admin-Key": ADMIN_KEY };

  // Block
  const block = await req("/admin/users/1002/block", { method: "POST", headers: h });
  assert.equal(block.status, 200);
  assert.equal(block.json.data.user.status, "BLOCKED");

  // Blocked user himoyalangan endpointga kira olmaydi -> 403 FORBIDDEN
  const denied = await req("/favorites?userId=1002");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "FORBIDDEN");

  // Blocked user profil ololmaydi
  const deniedProfile = await req("/profile?userId=1002");
  assert.equal(deniedProfile.status, 403);

  // Unblock
  const unblock = await req("/admin/users/1002/unblock", { method: "POST", headers: h });
  assert.equal(unblock.status, 200);
  assert.equal(unblock.json.data.user.status, "ACTIVE");

  // Endi kira oladi
  const allowed = await req("/favorites?userId=1002");
  assert.equal(allowed.status, 200);

  // Adashgan id -> 404
  const missing = await req("/admin/users/nope-xyz/block", { method: "POST", headers: h });
  assert.equal(missing.status, 404);
});

test("admin: isAdmin yangilash va ro'yxatda ko'rinishi", async () => {
  await req("/profile?userId=1003"); // user yaratish
  const h = { "X-Admin-Key": ADMIN_KEY };

  const on = await req("/admin/users/1003", { method: "PUT", headers: h, body: JSON.stringify({ isAdmin: true }) });
  assert.equal(on.status, 200);
  assert.equal(on.json.data.user.isAdmin, true);

  const detail = await req("/admin/users/1003", { headers: h });
  assert.equal(detail.json.data.user.isAdmin, true);

  const off = await req("/admin/users/1003", { method: "PUT", headers: h, body: JSON.stringify({ isAdmin: false }) });
  assert.equal(off.json.data.user.isAdmin, false);
});

test("admin: 'Adminga aylantirish' orqali belgilangan foydalanuvchi haqiqatan ham admin huquqiga ega bo'ladi (Telegram initData orqali)", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const secondaryId = 7788990011;

  // Avval oddiy foydalanuvchi sifatida profil oladi — isAdmin: false bo'lishi kerak.
  const beforeInit = signInitData({ id: secondaryId, first_name: "Ikkinchi" });
  const beforeProfile = await req("/profile", { headers: { "X-Telegram-Init-Data": beforeInit } });
  assert.equal(beforeProfile.status, 200);
  assert.equal(beforeProfile.json.data.user.isAdmin, false);

  // Bu foydalanuvchi admin panel orqali (X-Admin-Key bilan) admin qilinadi.
  const grant = await req(`/admin/users/${secondaryId}`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ isAdmin: true }),
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.json.data.user.isAdmin, true);

  // Endi shu foydalanuvchining O'ZINING profili ham isAdmin:true ko'rsatishi kerak
  // (avval bu yerda har doim ADMIN_ID bilan qat'iy solishtirilgani uchun
  // doim false qaytar edi, tugma amaliy natija bermas edi).
  const afterInit = signInitData({ id: secondaryId, first_name: "Ikkinchi" });
  const afterProfile = await req("/profile", { headers: { "X-Telegram-Init-Data": afterInit } });
  assert.equal(afterProfile.json.data.user.isAdmin, true);

  // Va eng muhimi — shu foydalanuvchi endi X-Admin-Key'siz, faqat o'z
  // Telegram initData'si bilan haqiqiy admin endpointlariga kira olishi kerak.
  const asAdmin = await req("/admin/genres", { headers: { "X-Telegram-Init-Data": afterInit } });
  assert.equal(asAdmin.status, 200);

  // Adminlikdan olib tashlangandan keyin esa qayta kira olmasligi kerak.
  await req(`/admin/users/${secondaryId}`, { method: "PUT", headers: h, body: JSON.stringify({ isAdmin: false }) });
  const revokedInit = signInitData({ id: secondaryId, first_name: "Ikkinchi" });
  const afterRevoke = await req("/admin/genres", { headers: { "X-Telegram-Init-Data": revokedInit } });
  assert.equal(afterRevoke.status, 403);
});

test("admin: user ro'yxatida status filtri", async () => {
  await req("/profile?userId=1004"); // user yaratish
  const h = { "X-Admin-Key": ADMIN_KEY };
  await req("/admin/users/1004/block", { method: "POST", headers: h });

  const blocked = await req("/admin/users?status=BLOCKED", { headers: h });
  assert.equal(blocked.status, 200);
  assert.ok(blocked.json.data.users.some((u) => u.id === "1004"));

  await req("/admin/users/1004/unblock", { method: "POST", headers: h });
  const active = await req("/admin/users?status=ACTIVE", { headers: h });
  assert.equal(active.status, 200);
  assert.ok(active.json.data.users.some((u) => u.id === "1004"));
});

// -- PHASE 7: Security hardening --

test("PHASE7: xavfsizlik headerlari API javobida mavjud", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(
    res.headers.get("permissions-policy"),
    "geolocation=(), camera=(), microphone=(), payment=()"
  );
  // Maxfiy ma'lumot keshlanmasligi uchun API javoblari no-store.
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("PHASE7: OPTIONS preflight javobida ham xavfsizlik headerlari bor", async () => {
  const res = await fetch(`${BASE}/health`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("PHASE7: X-RateLimit headerlari javobda mavjud", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.headers.get("x-ratelimit-limit"), "240");
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  assert.ok(Number.isInteger(remaining) && remaining >= 0);
});

test("PHASE7: auth endpointi qat'iy limit (10/60s) — 429 qaytaradi", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const { status } = await req("/auth/telegram", {
      method: "POST",
      body: JSON.stringify({ initData: "invalid-init-data" }),
    });
    statuses.push(status);
  }
  // Dastlabki so'rovlar validatsiyada rad etiladi (401), 11-chisi limitga yetadi (429).
  assert.equal(statuses[0], 401);
  assert.equal(statuses[10], 429);
});

test("PHASE7: XSS-naqsh title rad etiladi (422)", async () => {
  const { status, json } = await req("/admin/movies", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ title: "<script>alert(1)</script>", year: 2024, rating: 5, genres: ["Drama"] }),
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("PHASE7: XSS-naqsh janr nomi rad etiladi (422)", async () => {
  const { status } = await req("/admin/genres", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ name: "<img src=x onerror=alert(1)>" }),
  });
  assert.equal(status, 422);
});

test("PHASE7: ruxsat etilmagan maydon rad etiladi (422)", async () => {
  const { status } = await req("/admin/movies", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ title: "Legit Film", year: 2024, rating: 5, genres: ["Drama"], hack: "x" }),
  });
  assert.equal(status, 422);
});

test("PHASE7: user yangilashda ruxsat etilmagan maydon rad etiladi (422)", async () => {
  await req("/profile?userId=1005"); // user yaratish
  const { status } = await req("/admin/users/1005", {
    method: "PUT",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ isAdmin: true, evil: "x" }),
  });
  assert.equal(status, 422);
});

// -- R2 video endpoints (R2 sozlanmagan holatda — validation va xato yo'llari) --

test("R2: video URL authsiz -> 401", async () => {
  const { status, json } = await req("/movies/dune2/video/720p");
  assert.equal(status, 401);
  assert.equal(json.error.code, "UNAUTHORIZED");
});

test("R2: video URL noto'g'ri quality -> 422", async () => {
  const { status, json } = await req("/movies/dune2/video/hd?userId=999");
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("Kali fallback: R2 sozlanmagan, lokal fayl ham yo'q -> 404 (video mavjud emas)", async () => {
  // R2 sozlanmagan, lekin Kali lokal mavjud — endi 503 emas.
  // johnwick4'da faqat legacy url bor, objectKey'li 720p yo'q → "video mavjud emas".
  const { status, json } = await req("/movies/johnwick4/video/720p?userId=999");
  assert.equal(status, 404);
  assert.equal(json.error.code, "NOT_FOUND");
});

test("R2: presign authsiz -> 403", async () => {
  const { status } = await req("/admin/movies/dune2/video/presign", {
    method: "POST",
    body: JSON.stringify({ quality: "720p", contentType: "video/mp4", size: 100 }),
  });
  assert.equal(status, 403);
});

test("R2: presign noto'g'ri quality -> 422", async () => {
  const { status, json } = await req("/admin/movies/dune2/video/presign", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ quality: "uhd", contentType: "video/mp4", size: 100 }),
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("R2: presign noto'g'ri contentType -> 422", async () => {
  const { status, json } = await req("/admin/movies/dune2/video/presign", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ quality: "720p", contentType: "text/html", size: 100 }),
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("Kali: presign R2 sozlanmagan bo'lsa ham lokal mode'da ishlaydi", async () => {
  // Yangi mantiq: storage berilmasa STORAGE_MODE ishlatiladi. R2 sozlanmagan,
  // Kali lokal mavjud → lokal upload endpoint URL qaytariladi (503 emas).
  const { status, json } = await req("/admin/movies/johnwick4/video/presign", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ quality: "720p", contentType: "video/mp4", size: 100 }),
  });
  assert.equal(status, 200);
  assert.ok(json.data.uploadUrl.includes("/video/upload/720p"), "lokal upload endpoint'ga ishora qilishi kerak");
  assert.equal(json.data.mode, "local");
});

test("Kali: confirm fayl lokal'da topilmasa -> 400 (upload yo'q)", async () => {
  // Yangi mantiq: confirm lokal mode'da localStorage.stat'ni tekshiradi.
  // R2 sozlanmagan → lokal, fayl yuklanmagan → 400 "Upload topilmadi" (503 emas).
  const { status, json } = await req("/admin/movies/johnwick4/video/confirm", {
    method: "POST",
    headers: { "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ quality: "720p", size: 100 }),
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, "BAD_REQUEST");
});

test("R2: video delete authsiz -> 403", async () => {
  const { status } = await req("/admin/movies/dune2/video/720p", { method: "DELETE" });
  assert.equal(status, 403);
});

test("R2: video delete noto'g'ri quality -> 422", async () => {
  const { status, json } = await req("/admin/movies/dune2/video/uhd", {
    method: "DELETE",
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  assert.equal(status, 422);
  assert.equal(json.error.code, "VALIDATION_ERROR");
});

test("R2: video delete biriktirilmagan quality -> 404", async () => {
  const { status, json } = await req("/admin/movies/dune2/video/720p", {
    method: "DELETE",
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  assert.equal(status, 404);
  assert.equal(json.error.code, "NOT_FOUND");
});

test("R2: oddiy /movies/:id route video sub-route'ga yemaydi", async () => {
  const { status } = await req("/movies/johnwick4?userId=999");
  assert.equal(status, 200);
  // videoSources'da objectKey bo'lmasligi kerak (sanitizatsiya)
  const m = (await req("/movies/johnwick4?userId=999")).json.data.movie;
  assert.ok(m.videoSources.url, "legacy url saqlanadi");
  const vs = m.videoSources;
  for (const q of ["360p", "480p", "720p", "1080p"]) {
    assert.ok(!(vs[q] && typeof vs[q].objectKey === "string"), "public javobda objectKey ko'rinmasligi kerak");
  }
});

// ---------------------------------------------------------------------------
// Kali lokal video — to'liq end-to-end sikl:
// upload → confirm (storage=local) → video URL (tokenli stream) → Range → delete
// R2 test'da sozlanmagan, shuning uchun butun yo'l lokal orqali o'tadi.
// ---------------------------------------------------------------------------
test("Kali: lokal video to'liq sikl — upload, storageType, tokenli stream, Range, delete", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  // 1) Yangi film yaratamiz (test DB nusxasida — xavfsiz).
  const created = await req("/admin/movies", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ title: "Kali Local E2E", year: 2026, rating: 8, genres: ["Action"] }),
  });
  assert.equal(created.status, 201);
  const id = created.json.data.movie.id;

  // 2) 720p lokal videoni yuklaymiz (PUT → server faylga yozadi).
  const videoBytes = Buffer.from("kinobot-kali-video-0123456789");
  const upload = await req(`/admin/movies/${id}/video/upload/720p`, {
    method: "PUT",
    headers: h,
    body: videoBytes,
  });
  assert.equal(upload.status, 200);

  // 3) Confirm: storage=local → DB'ga storageType biriktiriladi.
  const confirm = await req(`/admin/movies/${id}/video/confirm`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ quality: "720p", size: videoBytes.length, storage: "local" }),
  });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.data.storageType, "local");
  const src720 = confirm.json.data.movie.videoSources["720p"];
  assert.equal(src720.storageType, "local");
  assert.equal(src720.objectKey, `movies/${id}/720p.mp4`);

  // 4) Oddiy foydalanuvchi video URL oladi → tokenli lokal stream URL (R2 sozlanmagan).
  const vurl = await req(`/movies/${id}/video/720p?userId=999`);
  assert.equal(vurl.status, 200);
  assert.equal(vurl.json.data.storageType, "local");
  assert.ok(vurl.json.data.url.includes(`/api/movies/${id}/video/720p/stream?token=`), "tokenli stream URL bo'lishi kerak");
  // Server URL'ni to'liq (absolute) qaytaradi — oldiga origin qo'shilmaydi.
  assert.ok(vurl.json.data.url.startsWith("http"), "stream URL absolute bo'lishi kerak");
  const streamUrl = vurl.json.data.url;

  // 5) Stream Range bilan → 206, faqat so'ralgan baytlar qaytadi.
  const rangeRes = await fetch(streamUrl, { headers: { Range: "bytes=0-9" } });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get("content-range"), `bytes 0-9/${videoBytes.length}`);
  const head = Buffer.from(await rangeRes.arrayBuffer());
  assert.equal(head.toString("utf8"), videoBytes.toString("utf8").slice(0, 10));

  // 6) AUTH: noto'g'ri token bilan stream → 401 (begona odam kira olmaydi).
  const badTokenUrl = streamUrl.replace(/token=[^&]+/, "token=wrong");
  const badRes = await fetch(badTokenUrl);
  assert.equal(badRes.status, 401);

  // 7) 1080p alohida quality sifatida qo'shiladi.
  const upload2 = await req(`/admin/movies/${id}/video/upload/1080p`, {
    method: "PUT",
    headers: h,
    body: Buffer.from("1080-video-content"),
  });
  assert.equal(upload2.status, 200);
  const confirm2 = await req(`/admin/movies/${id}/video/confirm`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ quality: "1080p", size: 18, storage: "local" }),
  });
  assert.equal(confirm2.status, 200);

  // 8) Delete → storage'da ham DB'da ham o'chadi.
  const del = await req(`/admin/movies/${id}/video/720p`, { method: "DELETE", headers: h });
  assert.equal(del.status, 200);
  const after = del.json.data.movie.videoSources;
  assert.ok(!after["720p"], "720p o'chgan bo'lishi kerak");
  assert.ok(after["1080p"], "1080p qolgan bo'lishi kerak");
  const streamGone = await fetch(streamUrl);
  assert.equal(streamGone.status, 404, "diskdan fayl ham o'chirilgan bo'lishi kerak");

  // 9) Film o'chirilganda butun video papka tozalanadi.
  await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
  assert.ok(!fs.existsSync(path.join(TEST_VIDEO_DIR, id)), "film video papkasi tozalanishi kerak");
});

// ---------------------------------------------------------------------------
// Premium / Plans / Payments — oldin bu oqim uchun bitta ham test yo'q edi.
// ---------------------------------------------------------------------------

test("premium: /premium/plans standart paketlarni qaytaradi", async () => {
  const { status, json } = await req("/premium/plans");
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.data.plans));
  assert.ok(json.data.plans.length >= 3);
  assert.ok(json.data.plans.some((p) => p.id === "1month"));
  assert.ok("price" in json.data.plans[0] && "duration" in json.data.plans[0]);
});

test("premium: /premium/status authsiz -> 401", async () => {
  const { status } = await req("/premium/status");
  assert.equal(status, 401);
});

test("premium: yangi user uchun status free", async () => {
  await req("/profile?userId=5001");
  const { status, json } = await req("/premium/status?userId=5001");
  assert.equal(status, 200);
  assert.equal(json.data.premium.isActive, false);
  assert.equal(json.data.premium.status, "free");
});

test("premium: purchase -> pending payment yaratadi, noto'g'ri plan -> 422", async () => {
  await req("/profile?userId=5002");
  const bad = await req("/premium/purchase?userId=5002", {
    method: "POST",
    body: JSON.stringify({ plan: "not-a-real-plan", checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  assert.equal(bad.status, 422);

  const noImage = await req("/premium/purchase?userId=5002", {
    method: "POST",
    body: JSON.stringify({ plan: "1month" }),
  });
  assert.equal(noImage.status, 422);

  const ok1 = await req("/premium/purchase?userId=5002", {
    method: "POST",
    body: JSON.stringify({ plan: "1month", checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  assert.equal(ok1.status, 201);
  assert.equal(ok1.json.data.payment.status, "pending");
  assert.equal(ok1.json.data.payment.plan, "1month");
});

test("premium: admin plans CRUD — custom paket yaratib, u bilan xarid qilish mumkin", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const created = await req("/admin/plans", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ name: "VIP hafta", durationDays: 7, price: 15000 }),
  });
  assert.equal(created.status, 201);
  const planId = created.json.data.plan.id;

  await req("/profile?userId=5003");
  const purchase = await req("/premium/purchase?userId=5003", {
    method: "POST",
    body: JSON.stringify({ plan: planId, checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  assert.equal(purchase.status, 201, "dinamik (custom) paket bilan ham xarid ishlashi kerak");

  const del = await req(`/admin/plans/${planId}`, { method: "DELETE", headers: h });
  assert.equal(del.status, 200);
});

test("premium: to'lovni admin approve qilsa, user premium bo'ladi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  await req("/profile?userId=5004");
  const purchase = await req("/premium/purchase?userId=5004", {
    method: "POST",
    body: JSON.stringify({ plan: "1month", checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  const paymentId = purchase.json.data.payment.id;

  const approve = await req(`/admin/payments/${paymentId}/approve`, { method: "POST", headers: h });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.data.user.premium.status, "active");

  const status = await req("/premium/status?userId=5004");
  assert.equal(status.json.data.premium.isActive, true);
  assert.equal(status.json.data.premium.plan, "1month");
});

test("premium: to'lovni admin reject qilsa, user free qoladi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  await req("/profile?userId=5005");
  const purchase = await req("/premium/purchase?userId=5005", {
    method: "POST",
    body: JSON.stringify({ plan: "1month", checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  const paymentId = purchase.json.data.payment.id;

  const reject = await req(`/admin/payments/${paymentId}/reject`, { method: "POST", headers: h });
  assert.equal(reject.status, 200);
  assert.equal(reject.json.data.payment.status, "rejected");

  const status = await req("/premium/status?userId=5005");
  assert.equal(status.json.data.premium.isActive, false);
});

test("premium: premium film — premium bo'lmagan user -> 403 PREMIUM_REQUIRED", async () => {
  await req("/profile?userId=5006");
  const { status, json } = await req("/movies/planetearth2/video/720p?userId=5006");
  assert.equal(status, 403);
  assert.equal(json.error.code, "PREMIUM_REQUIRED");
});

test("premium: admin payments ro'yxati va stats", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const { status, json } = await req("/admin/payments", { headers: h });
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.data.payments));
  assert.ok(json.data.stats.total >= 4);
  // Ro'yxatda chek rasmi bo'lmasligi kerak (og'ir/maxfiy ma'lumot)
  assert.ok(json.data.payments.every((p) => p.checkImageData === undefined));
});

test("premium: payment-settings admin saqlaydi, public GET orqali ko'rinadi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const save = await req("/admin/payment-settings", {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ cardNumber: "8600123412341234", cardHolder: "TEST HOLDER" }),
  });
  assert.equal(save.status, 200);

  const pub = await req("/premium/payment-settings");
  assert.equal(pub.status, 200);
  assert.equal(pub.json.data.settings.cardHolder, "TEST HOLDER");
});

test("stream token: boshqa userId bilan qayta ishlatib bo'lmaydi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const id = "stream-uid-test";
  await req("/admin/movies", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ id, title: "Stream UID Test", year: 2024, rating: 5, genres: ["Drama"] }),
  });
  await req(`/admin/movies/${id}/video/presign`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ quality: "720p", contentType: "video/mp4", storage: "local" }),
  });
  await req(`/admin/movies/${id}/video/upload/720p`, {
    method: "PUT",
    headers: h,
    body: "fake-bytes",
  });
  await req(`/admin/movies/${id}/video/confirm`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ quality: "720p", storage: "local" }),
  });

  const asUserA = await req(`/movies/${id}/video/720p?userId=aaa`);
  const streamUrl = asUserA.json.data.url; // to'liq URL, token+uid bilan
  const tokenMatch = /token=([^&]+)/.exec(streamUrl);
  const token = decodeURIComponent(tokenMatch[1]);

  const asOwner = await fetch(`${BASE}/movies/${id}/video/720p/stream?token=${encodeURIComponent(token)}&uid=aaa`);
  assert.equal(asOwner.status, 200);

  const asOther = await fetch(`${BASE}/movies/${id}/video/720p/stream?token=${encodeURIComponent(token)}&uid=bbb`);
  assert.equal(asOther.status, 401, "boshqa userId bilan token yaroqsiz bo'lishi kerak");

  await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
});

// ---------------------------------------------------------------------------
// Majburiy obuna kanallari
// ---------------------------------------------------------------------------

test("channels: bo'sh ro'yxatda /channels/required bo'sh massiv qaytaradi", async () => {
  const { status, json } = await req("/channels/required");
  assert.equal(status, 200);
  assert.deepEqual(json.data.channels, []);
});

test("channels: kanal bo'lmasa /channels/check har doim subscribed:true", async () => {
  await req("/profile?userId=6001");
  const { status, json } = await req("/channels/check?userId=6001");
  assert.equal(status, 200);
  assert.equal(json.data.subscribed, true);
  assert.deepEqual(json.data.missing, []);
});

test("channels: admin CRUD — qo'shish, ro'yxat, noto'g'ri chatId, dublikat, o'chirish", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };

  const badChatId = await req("/admin/channels", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ chatId: "", title: "Bo'sh" }),
  });
  assert.equal(badChatId.status, 422);

  const created = await req("/admin/channels", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ chatId: "@kinobot_channel", title: "Asosiy kanal" }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.channel.chatId, "@kinobot_channel");
  assert.equal(created.json.data.channel.inviteLink, "https://t.me/kinobot_channel");
  const channelId = created.json.data.channel.id;

  const dup = await req("/admin/channels", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ chatId: "@kinobot_channel", title: "Yana" }),
  });
  assert.equal(dup.status, 409);

  const list = await req("/admin/channels", { headers: h });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.channels.some((c) => c.id === channelId));

  const publicList = await req("/channels/required");
  assert.ok(publicList.json.data.channels.some((c) => c.id === channelId));
  // Public javobda ichki chatId maydoni yo'q bo'lishi shart emas, lekin
  // kamida title/inviteLink kerakli maydonlar bo'lishi kerak.
  const pub = publicList.json.data.channels.find((c) => c.id === channelId);
  assert.equal(pub.title, "Asosiy kanal");
  assert.ok(pub.inviteLink);

  const del = await req(`/admin/channels/${channelId}`, { method: "DELETE", headers: h });
  assert.equal(del.status, 200);

  const gone = await req(`/admin/channels/${channelId}`, { method: "DELETE", headers: h });
  assert.equal(gone.status, 404);

  const afterDelete = await req("/channels/required");
  assert.ok(!afterDelete.json.data.channels.some((c) => c.id === channelId));
});

test("channels: admin CRUD authsiz -> 403", async () => {
  const list = await req("/admin/channels");
  assert.equal(list.status, 403);
  const add = await req("/admin/channels", { method: "POST", body: JSON.stringify({ chatId: "@x" }) });
  assert.equal(add.status, 403);
});

test("channels: kanal qo'shilgach, Telegram API mavjud bo'lmasa video so'rovi SUBSCRIPTION_REQUIRED beradi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const created = await req("/admin/channels", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ chatId: "-1009999999", title: "Test kanal" }),
  });
  const channelId = created.json.data.channel.id;

  // BOT_TOKEN test muhitida haqiqiy emas — Telegram getChatMember xato
  // qaytaradi, shuning uchun bot foydalanuvchi a'zoligini isbotlay olmaydi
  // va xavfsizlik tarafida (fail-closed) obuna talab qilingan deb hisoblanadi.
  await req("/profile?userId=6002");
  const check = await req("/channels/check?userId=6002");
  assert.equal(check.json.data.subscribed, false);
  assert.equal(check.json.data.missing.length, 1);

  const video = await req("/movies/johnwick4/video/720p?userId=6002");
  assert.equal(video.status, 403);
  assert.equal(video.json.error.code, "SUBSCRIPTION_REQUIRED");

  await req(`/admin/channels/${channelId}`, { method: "DELETE", headers: h });
});

// ---------------------------------------------------------------------------
// Premium tizimini yoqish/o'chirish (admin)
// ---------------------------------------------------------------------------

test("premium-enabled: standart holat yoqilgan, faqat admin o'zgartira oladi", async () => {
  const pub = await req("/premium/enabled");
  assert.equal(pub.status, 200);
  assert.equal(pub.json.data.enabled, true);

  const noAuth = await req("/admin/premium-enabled", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  assert.equal(noAuth.status, 403);
});

test("premium-enabled: o'chirilsa premium film hammaga ochiladi, xarid bloklanadi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };

  // Haqiqiy (lokal) videoli, premium film yaratamiz — shu orqali
  // 200/403 farqini legacy formatga bog'liq bo'lmagan holda tekshiramiz.
  const id = "premium-toggle-test";
  await req("/admin/movies", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ id, title: "Premium Toggle Test", year: 2024, rating: 5, genres: ["Drama"], isPremium: true }),
  });
  await req(`/admin/movies/${id}/video/presign`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ quality: "720p", contentType: "video/mp4", storage: "local" }),
  });
  await req(`/admin/movies/${id}/video/upload/720p`, { method: "PUT", headers: h, body: "fake-bytes" });
  await req(`/admin/movies/${id}/video/confirm`, { method: "POST", headers: h, body: JSON.stringify({ quality: "720p", storage: "local" }) });

  const off = await req("/admin/premium-enabled", { method: "PUT", headers: h, body: JSON.stringify({ enabled: false }) });
  assert.equal(off.status, 200);
  assert.equal(off.json.data.enabled, false);
  assert.equal((await req("/premium/enabled")).json.data.enabled, false);

  // Premium bo'lmagan (free) foydalanuvchi endi premium filmni ham ko'ra oladi.
  await req("/profile?userId=8001");
  const video = await req(`/movies/${id}/video/720p?userId=8001`);
  assert.equal(video.status, 200);

  // Xarid qilish endi bloklangan.
  const purchase = await req("/premium/purchase?userId=8001", {
    method: "POST",
    body: JSON.stringify({ plan: "1month", checkImageData: "data:image/png;base64,aGVsbG8=" }),
  });
  assert.equal(purchase.status, 503);
  assert.equal(purchase.json.error.code, "PREMIUM_DISABLED");

  // Qayta yoqamiz — keyingi testlarga ta'sir qilmasligi uchun.
  const on = await req("/admin/premium-enabled", { method: "PUT", headers: h, body: JSON.stringify({ enabled: true }) });
  assert.equal(on.json.data.enabled, true);

  // Qayta yoqilgach, premium film yana himoyalangan bo'lishi kerak.
  const videoAfter = await req(`/movies/${id}/video/720p?userId=8001`);
  assert.equal(videoAfter.status, 403);

  await req(`/admin/movies/${id}`, { method: "DELETE", headers: h });
});

test("premium-enabled: noto'g'ri qiymat -> 422", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const bad = await req("/admin/premium-enabled", { method: "PUT", headers: h, body: JSON.stringify({ enabled: "yes" }) });
  assert.equal(bad.status, 422);
});

test("admin/stats: pendingPayments va unreadMessages badge sonlarini qaytaradi", async () => {
  const h = { "X-Admin-Key": ADMIN_KEY };
  const stats = await req("/admin/stats", { headers: h });
  assert.equal(stats.status, 200);
  assert.ok(typeof stats.json.data.pendingPayments === "number");
  assert.ok(typeof stats.json.data.unreadMessages === "number");

  const before = stats.json.data.unreadMessages;
  await req("/profile?userId=9001");
  await req("/contact?userId=9001", { method: "POST", body: JSON.stringify({ text: "Badge test xabari" }) });
  const after = await req("/admin/stats", { headers: h });
  assert.equal(after.json.data.unreadMessages, before + 1);
});
