// src/db.js
// Ikki xil "database" qatlami bitta modulda:
//   1) Fayl-asosidagi (default) — data/db.json, Render'da restart/deploy'da
//      diskning o'zi tozalanib ketadi (ephemeral).
//   2) PostgreSQL (DATABASE_URL o'rnatilganda) — Neon va h.k. Postgres
//      xizmatida bitta JSONB qatorda saqlanadi (repository'lar butun db
//      obyektini load()/persist() orqali ishlatadi, shu sababli individual
//      jadval/SQL qayta yozishga hojat yo'q — faqat shu modul o'zgaradi).
//
// DATABASE_URL yo'q bo'lsa — xatti-harakat OLDINGIDEK, bitta baytigacha
// o'zgarmagan (fayl-rejim quyida to'liq saqlangan).
//
// Xususiyatlari (fayl-rejim):
//  - Atomic yozish (temp fayl + rename) — jarayon o'lsa db.json buzilmaydi
//  - Yuklashda schema normalizatsiyasi + validatsiyasi
//  - Corruption recovery — buzilgan fayl o'rniga .bak dan tiklash / zaxirada
//  - Eski temp fayllarni tozalash (stale .tmp)
//  - Xotirada kesh + yozish navbati (race condition himoyasi)
//  - backup moduli bilan integratsiya (src/backup.js)
//
// Xususiyatlari (Postgres-rejim):
//  - Bitta jadval (kinobot_store), bitta qator, JSONB ustun — butun db.json
//    tarkibi shu yerda, fayl-rejimdagi schema bilan bir xil
//  - server.js/bot.js ALOHIDA process (start-all.js fork qiladi) — shuning
//    uchun har 5s da fon rejimida boshqa process yozgan o'zgarish bor-yo'qligi
//    tekshiriladi (updated_at solishtiriladi), bo'lsa qayta yuklanadi
//  - Xotirada kesh — load() SINXRON qoladi (repository'lar shuni kutadi),
//    tarmoq so'rovi faqat init()da (server ishga tushishidan OLDIN kutiladi)
//    va fon poll'da bo'ladi

const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";
const BAK_PATH = DB_PATH + ".bak";

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_POSTGRES = Boolean(DATABASE_URL);
const POLL_INTERVAL_MS = 5000;

// Fresh clone'da (masalan Render'da birinchi deploy) data/ papkasi umuman
// mavjud bo'lmasligi mumkin (.gitignore uni repodan chiqarib tashlaydi,
// git esa bo'sh papkalarni saqlamaydi). Shuning uchun har doim, har qanday
// o'qish/yozishdan oldin, papka mavjudligini ta'minlaymiz.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let cache = null;
// db.json OXIRGI o'qilgan mtime'si. `start-all.js` server.js (uzoq muddat
// ishlaydigan asosiy jarayon) va bot.js (alohida fork qilingan child
// process) ni BIRGA ishga tushiradi — ikkalasi ham shu faylni o'qiydi/
// yozadi, lekin ular ALOHIDA OS jarayonlari, xotira keshi ORTIQ umumiy emas.
// Agar `cache` faqat "birinchi load()da to'ldirilib, keyin hech qachon
// yangilanmasa" (avvalgi holat), bot.js yangi film yozganda server.js
// (webapp/admin panel) buni HECH QACHON ko'rmaydi — chunki uning xotiradagi
// nusxasi eskirgan bo'lib qoladi, fayl diskda o'zgargan bo'lsa ham.
// Shuning uchun har bir load() chaqiruvida faylning mtime'si tekshiriladi;
// agar boshqa jarayon uni o'zgartirgan bo'lsa — qayta o'qiladi.
let cachedMtimeMs = 0;

function currentMtimeMs() {
  try {
    return fs.statSync(DB_PATH).mtimeMs;
  } catch (e) {
    return 0; // fayl mavjud emas
  }
}

let writeQueue = Promise.resolve();

const DEFAULT_GENRES = [
  "Action", "Comedy", "Drama", "Horror", "Sci-Fi", "Thriller",
  "Anime", "Romance", "Documentary", "Fantasy", "Crime", "History",
];

// Analytics schémasi: daily counters + per-movie playback counts.
// Events tracking API'da bufferga to'planib, vaqt-vaqti bilan yoziladi.
function defaultAnalytics() {
  return { days: {}, moviePlays: {} };
}

function defaultDb() {
  return {
    movies: [],
    genres: DEFAULT_GENRES.slice(),
    deactivatedGenres: [], // admin tomonidan o'chirilgan (yashirilgan) janrlar
    users: {},
    favorites: {},
    history: {},
    auditLog: [],
    analytics: defaultAnalytics(),
    settings: {}, // ilova sozlamalari: adminPasswordHash, banner va boshqalar
    payments: {}, // to'lovlar: { paymentId: { id, userId, plan, amount, status, checkImageData, createdAt, reviewedAt, reviewedBy } }
    contactMessages: [], // "Biz bilan bog'lanish" xabarlari: { id, userId, userName, username, text, createdAt, status }
    blockedContactUsers: [], // faqat aloqa formasidan bloklangan user ID'lar (botdan foydalanishga ta'sir qilmaydi)
  };
}

// videoSources.<quality>.objectKey har doim "movies/{movieId}/{quality}.mp4"
// formatida bo'lishi kerak (r2.js/localStorage.js buildObjectKey shunday
// quradi, resolvePath ham shu formatni kutadi). Eski/qo'lda kiritilgan
// ma'lumotlarda prefiks tushib qolgan bo'lishi mumkin (masalan
// "{movieId}/{quality}.mp4" yoki faqat "{quality}.mp4") — bunday holda
// video topilmaydi/o'chirilmaydi, shuning uchun yuklashda tuzatib qo'yamiz.
function normalizeVideoSources(vs, movieId) {
  if (!vs || typeof vs !== "object" || Array.isArray(vs)) return vs;
  const out = { ...vs };
  for (const key of Object.keys(out)) {
    const entry = out[key];
    if (!entry || typeof entry !== "object" || typeof entry.objectKey !== "string") continue;
    if (/^movies\/[^/]+\/[^/]+\.mp4$/.test(entry.objectKey)) continue; // allaqachon to'g'ri
    let fixed = null;
    const short = /^([^/]+)\.mp4$/.exec(entry.objectKey); // "{quality}.mp4"
    const noPrefix = /^([^/]+)\/([^/]+\.mp4)$/.exec(entry.objectKey); // "{movieId}/{quality}.mp4"
    if (noPrefix) fixed = `movies/${noPrefix[1]}/${noPrefix[2]}`;
    else if (short) fixed = `movies/${movieId}/${short[1]}.mp4`;
    if (fixed) out[key] = { ...entry, objectKey: fixed };
  }
  return out;
}

// Eski schema (desc, videoUrl, g) → yangi schema (description, posterUrl,
// backdropUrl, originalTitle, videoSources, updatedAt) normalizatsiyasi.
// poster maydoni gradient fallback sifatida saqlanadi (frontend mosligi uchun).
function normalizeMovie(m) {
  if (!m || typeof m !== "object") return null;
  const id = String(m.id || "").trim();
  const title = String(m.title || "").trim();
  if (!id || !title) return null;

  const movie = { ...m };
  movie.id = id;
  movie.title = title;
  movie.originalTitle = movie.originalTitle != null ? String(movie.originalTitle) : "";
  movie.year = Number(movie.year) || 0;
  movie.duration = String(movie.duration || "");
  movie.genres = Array.isArray(movie.genres)
    ? movie.genres.filter((g) => typeof g === "string" && g.trim()).map((g) => g.trim())
    : [];
  movie.rating = Math.max(0, Math.min(10, Number(movie.rating) || 0));
  movie.description = movie.description != null ? String(movie.description) : String(movie.desc || "");
  delete movie.desc;
  movie.poster = String(movie.poster || "g0");
  movie.posterUrl = movie.posterUrl != null ? String(movie.posterUrl) : "";
  movie.backdropUrl = movie.backdropUrl != null ? String(movie.backdropUrl) : "";
  movie.videoSources = movie.videoSources != null ? normalizeVideoSources(movie.videoSources, movie.id) : null;
  movie.status = movie.status || "active";        // active | inactive | hidden
  movie.featured = Boolean(movie.featured);
  movie.trending = Boolean(movie.trending);       // admin tanlagan "Trenddagi filmlar"
  movie.trendingOrder = Number.isFinite(Number(movie.trendingOrder)) ? Number(movie.trendingOrder) : 0;
  movie.trendingBannerUrl = movie.trendingBannerUrl != null ? String(movie.trendingBannerUrl) : "";
  movie.isPremium = Boolean(movie.isPremium);     // premium kontent
  movie.planIds = Array.isArray(movie.planIds) ? movie.planIds.map(String) : [];
  movie.createdAt = movie.createdAt || new Date().toISOString();
  movie.updatedAt = movie.updatedAt || movie.createdAt;
  return movie;
}

// Schema validatsiyasi — korrupsiyalangan/noto'g'ri strukturali db'ni
// xavfsiz tarzda default qiymatlar bilan to'ldiradi.
// return { db, warnings }
function validateSchema(db) {
  const warnings = [];
  if (!db || typeof db !== "object") {
    return { db: defaultDb(), warnings: ["db null/not-object — default schema ishlatildi"] };
  }
  if (!Array.isArray(db.movies)) {
    db.movies = [];
    warnings.push("movies massiv emas — tozalandi");
  }
  if (!Array.isArray(db.genres)) {
    db.genres = DEFAULT_GENRES.slice();
    warnings.push("genres massiv emas — defaultlar o'rnatildi");
  }
  if (!Array.isArray(db.deactivatedGenres)) {
    db.deactivatedGenres = [];
    warnings.push("deactivatedGenres massiv emas — tozalandi");
  }
  if (!db.users || typeof db.users !== "object" || Array.isArray(db.users)) {
    db.users = {};
    warnings.push("users object emas — tozalandi");
  }
  if (!db.favorites || typeof db.favorites !== "object" || Array.isArray(db.favorites)) {
    db.favorites = {};
    warnings.push("favorites object emas — tozalandi");
  }
  if (!db.history || typeof db.history !== "object" || Array.isArray(db.history)) {
    db.history = {};
    warnings.push("history object emas — tozalandi");
  }
  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  if (!db.analytics || typeof db.analytics !== "object" || Array.isArray(db.analytics)) {
    db.analytics = defaultAnalytics();
  }
  if (!db.analytics.days || typeof db.analytics.days !== "object") db.analytics.days = {};
  if (!db.analytics.moviePlays || typeof db.analytics.moviePlays !== "object") db.analytics.moviePlays = {};
  if (!db.settings || typeof db.settings !== "object" || Array.isArray(db.settings)) {
    db.settings = {};
    warnings.push("settings object emas — tozalandi");
  }
  if (!db.payments || typeof db.payments !== "object" || Array.isArray(db.payments)) {
    db.payments = {};
    warnings.push("payments object emas — tozalandi");
  }
  if (!Array.isArray(db.contactMessages)) {
    db.contactMessages = [];
    warnings.push("contactMessages massiv emas — tozalandi");
  }
  if (!Array.isArray(db.blockedContactUsers)) {
    db.blockedContactUsers = [];
    warnings.push("blockedContactUsers massiv emas — tozalandi");
  }
  return { db, warnings };
}

function normalizeUser(u, id) {
  if (!u || typeof u !== "object") return null;
  const now = new Date().toISOString();
  return {
    id: id != null ? String(id) : String(u.id || ""),
    telegramId: u.telegramId != null ? String(u.telegramId) : (id != null ? String(id) : String(u.id || "")),
    username: u.username != null ? String(u.username) : "",
    firstName: u.firstName != null ? String(u.firstName) : "",
    lastName: u.lastName != null ? String(u.lastName) : "",
    photoUrl: u.photoUrl != null ? String(u.photoUrl) : "",
    language: u.language != null ? String(u.language) : "",
    createdAt: u.createdAt || now,
    updatedAt: u.updatedAt || now,
    lastSeenAt: u.lastSeenAt || u.updatedAt || now,
    status: u.status === "BLOCKED" ? "BLOCKED" : "ACTIVE",
    isAdmin: Boolean(u.isAdmin),
    isBlocked: u.status === "BLOCKED" || Boolean(u.isBlocked),
    premium: u.premium && typeof u.premium === "object" ? {
      status: u.premium.status === "active" ? "active" : "free",
      plan: u.premium.plan || null,
      expiresAt: u.premium.expiresAt || null,
      activatedAt: u.premium.activatedAt || null,
    } : { status: "free", plan: null, expiresAt: null, activatedAt: null },
  };
}

function normalizeHistoryEntry(h) {
  if (!h || typeof h !== "object") return null;
  const movieId = String(h.movieId || "").trim();
  if (!movieId) return null;
  return {
    movieId,
    progressPct: Math.max(0, Math.min(100, Number(h.progressPct) || 0)),
    positionSeconds: Math.max(0, Number(h.positionSeconds) || 0),
    completed: Boolean(h.completed),
    watchedAt: h.watchedAt || new Date().toISOString(),
    lastWatchedAt: h.lastWatchedAt || h.watchedAt || new Date().toISOString(),
  };
}

function normalize(db) {
  const { db: cleaned, warnings } = validateSchema(db);
  return {
    movies: Array.isArray(cleaned.movies)
      ? cleaned.movies.map(normalizeMovie).filter(Boolean)
      : [],
    genres: Array.isArray(cleaned.genres)
      ? cleaned.genres.filter((g) => typeof g === "string" && g.trim())
      : [],
    deactivatedGenres: Array.isArray(cleaned.deactivatedGenres)
      ? cleaned.deactivatedGenres.filter((g) => typeof g === "string" && g.trim())
      : [],
    users: (() => {
      const out = {};
      for (const [key, u] of Object.entries(cleaned.users || {})) {
        const normalized = normalizeUser(u, key);
        if (normalized && normalized.id) out[normalized.id] = normalized;
      }
      return out;
    })(),
    favorites: (() => {
      const out = {};
      for (const [key, arr] of Object.entries(cleaned.favorites || {})) {
        if (!Array.isArray(arr)) continue;
        // Duplikatlarni olib tashlash — fav'lar yagona bo'lishi kerak
        out[key] = [...new Set(arr.map((x) => String(x)).filter(Boolean))];
      }
      return out;
    })(),
    history: (() => {
      const out = {};
      for (const [key, arr] of Object.entries(cleaned.history || {})) {
        if (!Array.isArray(arr)) continue;
        const normalized = arr.map(normalizeHistoryEntry).filter(Boolean);
        // Duplikat movieId'larni olib tashlash (eng oxirgi yozuv qoladi)
        const seen = new Map();
        for (const entry of normalized) seen.set(entry.movieId, entry);
        out[key] = [...seen.values()];
      }
      return out;
    })(),
    auditLog: Array.isArray(cleaned.auditLog) ? cleaned.auditLog : [],
    analytics: cleaned.analytics,
    settings: cleaned.settings || {},
    payments: (() => {
      const out = {};
      for (const [key, p] of Object.entries(cleaned.payments || {})) {
        if (!p || typeof p !== "object") continue;
        out[key] = {
          id: String(p.id || key),
          userId: String(p.userId || ""),
          plan: p.plan || "1month",
          amount: Number(p.amount) || 0,
          status: p.status === "approved" ? "approved" : (p.status === "rejected" ? "rejected" : "pending"),
          checkImageData: p.checkImageData || null,
          createdAt: p.createdAt || new Date().toISOString(),
          reviewedAt: p.reviewedAt || null,
          reviewedBy: p.reviewedBy || null,
        };
      }
      return out;
    })(),
    contactMessages: Array.isArray(cleaned.contactMessages)
      ? cleaned.contactMessages.map((m) => {
          if (!m || typeof m !== "object") return null;
          return {
            id: String(m.id || "").trim(),
            userId: String(m.userId || "").trim(),
            userName: String(m.userName || "").trim(),
            username: String(m.username || "").trim(),
            text: String(m.text || "").slice(0, 2000),
            createdAt: m.createdAt || new Date().toISOString(),
            status: m.status === "read" ? "read" : "new",
          };
        }).filter(Boolean)
      : [],
    blockedContactUsers: Array.isArray(cleaned.blockedContactUsers)
      ? cleaned.blockedContactUsers.filter((x) => typeof x === "string" && x.trim())
      : [],
  };
}

// Eski .tmp fayllarni tozalash — jarayon o'lsa qolib ketgan bo'lishi mumkin.
function cleanupStaleTempFiles() {
  try {
    if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
  } catch (e) {
    // e'tiborsiz — fayl band bo'lishi mumkin
  }
}

// Corrupted faylni zaxiraga olib, keyingi safe startup uchun ajratib qo'yadi.
function quarantineCorruptFile() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = DB_PATH + `.corrupt-${stamp}`;
    fs.renameSync(DB_PATH, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

// Korrupsiyalangan db.json ni tiklash: .bak mavjud bo'lsa uni ishlatamiz.
// return { restored: boolean, note: string }
function recoverFromCorruption() {
  if (fs.existsSync(BAK_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BAK_PATH, "utf-8"));
      // .bak toza bo'lsa uni asosiy fayl qilib qaytarish
      const quarantined = fs.existsSync(DB_PATH) ? quarantineCorruptFile() : null;
      fs.copyFileSync(BAK_PATH, DB_PATH);
      return { restored: true, note: quarantined ? `.bak dan tiklandi (corrupt → ${path.basename(quarantined)})` : ".bak dan tiklandi" };
    } catch (e) {
      return { restored: false, note: ".bak ham buzilgan" };
    }
  }
  return { restored: false, note: ".bak mavjud emas" };
}

function loadFromFile() {
  const diskMtime = currentMtimeMs();
  // Kesh hali yaroqli: mavjud VA fayl boshqa jarayon tomonidan
  // o'zgartirilmagan (mtime bir xil qolgan).
  if (cache && diskMtime === cachedMtimeMs) return cache;
  cleanupStaleTempFiles();

  if (!fs.existsSync(DB_PATH)) {
    cache = defaultDb();
    cachedMtimeMs = 0;
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (e) {
    // Korrupsiya — avval .bak'dan tiklashga urinamiz
    const rec = recoverFromCorruption();
    if (rec.restored) {
      try {
        parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
        console.error("[db] Buzilgan db.json dan tiklandi:", rec.note);
      } catch (e2) {
        console.error("[db] Tiklangan fayl ham buzilgan:", rec.note);
        const q = quarantineCorruptFile();
        if (q) console.error(`[db] Corrupt fayl zaxiraga olindi: ${q}`);
        parsed = defaultDb();
      }
    } else {
      console.error("[db] db.json buzilgan —", rec.note, ". Toza schema bilan boshlanmoqda (silent emas).");
      const q = quarantineCorruptFile();
      if (q) console.error(`[db] Corrupt fayl zaxiraga olindi: ${q}`);
      parsed = defaultDb();
    }
  }

  cache = normalize(parsed);
  cachedMtimeMs = currentMtimeMs();
  return cache;
}

function persistToFile() {
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve, reject) => {
        try {
          const json = JSON.stringify(cache, null, 2);
          // Atomic yozish: avval temp faylga, keyin rename
          fs.writeFileSync(TMP_PATH, json, "utf-8");
          fs.renameSync(TMP_PATH, DB_PATH);
          // O'zimiz yozgan holatni "yangi" deb belgilaymiz — shu jarayonning
          // keyingi load() chaqiruvi o'z-o'zining yozuvini qayta o'qib
          // (ortiqcha, lekin zararsiz) I/O sarflamasin.
          cachedMtimeMs = currentMtimeMs();
          resolve();
        } catch (err) {
          reject(err);
        }
      })
  );
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Postgres-rejim (DATABASE_URL o'rnatilganda)
// ---------------------------------------------------------------------------
let pgPool = null;
let cachedUpdatedAtIso = null; // Postgresdagi oxirgi ko'rilgan updated_at
let pollTimer = null;
let initPromise = null;

function getPool() {
  if (!pgPool) {
    // Faqat shu yerda talab qilinadi — DATABASE_URL bo'lmasa "pg" paketi
    // umuman yuklanmaydi (fayl-rejimda hech qanday tashqi bog'liqlik yo'q).
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      // Neon va ko'pchilik boshqa boshqaruvli Postgres xizmatlari uchun
      // odatiy SSL rejimi (o'z-sertifikatini tekshirmaymiz).
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    pgPool.on("error", (err) => {
      console.error("[db] Postgres pool xatosi (fon):", err.message);
    });
  }
  return pgPool;
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS kinobot_store (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Poster/banner rasmlari uchun alohida jadval — Render'ning ephemeral
  // diskiga bog'liq bo'lmasligi uchun (deploy/restart'da fayl yo'qolib
  // ketmasligi kerak). Kichik rasmlar (<=2MB) BYTEA ustunda saqlanadi.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS kinobot_images (
      id TEXT PRIMARY KEY,
      ext TEXT NOT NULL,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Postgres-rejimda poster/banner rasmini saqlaydi (id: masalan "poster:123"
// yoki "banner"). Fayl-rejimdagi posterStore/bannerStore bilan bir xil
// vazifani bajaradi, faqat diskka emas — DB'ga yozadi.
async function pgSaveImage(id, ext, buffer) {
  await getPool().query(
    `INSERT INTO kinobot_images (id, ext, data, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET ext = $2, data = $3, updated_at = now()`,
    [id, ext, buffer]
  );
}

async function pgFindImage(id) {
  const res = await getPool().query("SELECT ext, data FROM kinobot_images WHERE id = $1", [id]);
  if (res.rows.length === 0) return null;
  return { ext: res.rows[0].ext, data: res.rows[0].data };
}

async function pgDeleteImage(id) {
  await getPool().query("DELETE FROM kinobot_images WHERE id = $1", [id]);
}

async function pgLoad() {
  const res = await getPool().query("SELECT data, updated_at FROM kinobot_store WHERE id = 1");
  if (res.rows.length === 0) {
    const fresh = defaultDb();
    await getPool().query(
      "INSERT INTO kinobot_store (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(fresh)]
    );
    const res2 = await getPool().query("SELECT data, updated_at FROM kinobot_store WHERE id = 1");
    cache = normalize(res2.rows[0].data);
    cachedUpdatedAtIso = res2.rows[0].updated_at.toISOString();
    return cache;
  }
  cache = normalize(res.rows[0].data);
  cachedUpdatedAtIso = res.rows[0].updated_at.toISOString();
  return cache;
}

async function pgPersist() {
  const json = JSON.stringify(cache);
  const res = await getPool().query(
    `INSERT INTO kinobot_store (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()
     RETURNING updated_at`,
    [json]
  );
  if (res.rows[0]) cachedUpdatedAtIso = res.rows[0].updated_at.toISOString();
}

// server.js va bot.js ALOHIDA OS jarayoni (start-all.js fork qiladi) —
// ikkalasi ham xotirada o'z nusxasini saqlaydi. Fayl-rejimda bu muammo
// bo'lmagan (umumiy disk, mtime tekshiruvi bilan har load()da yangilanadi).
// Postgres-rejimda esa load() sinxron bo'lishi SHART (repository'lar shuni
// kutadi), shuning uchun tarmoqni har load()da so'rab bo'lmaydi — buning
// o'rniga fonda har necha soniyada bir marta tekshirib turamiz.
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const res = await getPool().query("SELECT updated_at FROM kinobot_store WHERE id = 1");
      const remoteIso = res.rows[0] ? res.rows[0].updated_at.toISOString() : null;
      if (remoteIso && remoteIso !== cachedUpdatedAtIso) {
        await pgLoad();
      }
    } catch (e) {
      console.error("[db] Postgres poll xatosi:", e.message);
    }
  }, POLL_INTERVAL_MS);
  pollTimer.unref();
}

// Server/bot ishga tushishidan OLDIN chaqirilishi SHART (Postgres-rejimda
// birinchi ma'lumotni tarmoqdan olib kelish uchun). Fayl-rejimda hech narsa
// qilmaydi (load() lazy, avvalgidek) — chaqirilmasa ham xatti-harakat bir xil.
async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!USE_POSTGRES) return;
    await ensureTable();
    await pgLoad();
    startPolling();
  })();
  return initPromise;
}

function load() {
  if (USE_POSTGRES) {
    if (!cache) {
      // Ehtiyot chorasi: kimdir init()ni kutmasdan load() chaqirsa,
      // server qulab tushmasin — bo'sh schema bilan davom etamiz va
      // ogohlantiramiz (bu normal holatda YUZ BERMASLIGI kerak).
      console.error("[db] load() init() tugashidan OLDIN chaqirildi — bo'sh schema bilan davom etilmoqda");
      cache = defaultDb();
    }
    return cache;
  }
  return loadFromFile();
}

function persist() {
  if (USE_POSTGRES) {
    writeQueue = writeQueue.then(() => pgPersist());
    return writeQueue;
  }
  return persistToFile();
}

// Testlar uchun: keshlangan ma'lumotni qayta yuklash (har testdan oldin toza holat).
function resetForTest() {
  cache = null;
  cachedMtimeMs = 0;
  cachedUpdatedAtIso = null;
  writeQueue = Promise.resolve();
  initPromise = null;
}

module.exports = {
  init,
  load,
  persist,
  resetForTest,
  DEFAULT_GENRES,
  normalizeMovie,
  normalize,
  normalizeHistoryEntry,
  validateSchema,
  getDbPath: () => DB_PATH,
  getBakPath: () => BAK_PATH,
  isPostgres: () => USE_POSTGRES,
  // Poster/banner rasmlari uchun (faqat Postgres-rejimda mazmunli;
  // fayl-rejimda posterStore/bannerStore o'zi diskka yozadi).
  saveImage: (id, ext, buffer) => pgSaveImage(id, ext, buffer),
  findImage: (id) => pgFindImage(id),
  deleteImage: (id) => pgDeleteImage(id),
};
