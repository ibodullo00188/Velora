const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, "..", "data", "db.json");
const TMP_PATH = DB_PATH + ".tmp";
const BAK_PATH = DB_PATH + ".bak";


// Fresh clone'da (masalan Render'da birinchi deploy) data/ papkasi umuman
// mavjud bo'lmasligi mumkin (.gitignore uni repodan chiqarib tashlaydi,
// git esa bo'sh papkalarni saqlamaydi). Shuning uchun har doim, har qanday
// o'qish/yozishdan oldin, papka mavjudligini ta'minlaymiz.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let cache = null;
// Manual file replacement invalidates the cache. Bot/API share one process.
let cachedMtimeMs = 0;

function currentMtimeMs() {
  try {
    return fs.statSync(DB_PATH).mtimeMs;
  } catch (e) {
    return 0; // fayl mavjud emas
  }
}



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
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(cache || load(), null, 2), "utf-8");
    fs.renameSync(TMP_PATH, DB_PATH);
    cachedMtimeMs = currentMtimeMs();
    return Promise.resolve();
  } catch (err) { return Promise.reject(err); }
}

// One process owns the file database; server and bot share the same cache.
let initPromise;
async function init() {
  if (!initPromise) initPromise = require("./telegramBackup").initializeLocal();
  return initPromise;
}
function load() { return loadFromFile(); }
function persist() { return persistToFile(); }
function resetForTest() { cache = null; cachedMtimeMs = 0; }
function replaceDatabase(data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(TMP_PATH, json);
  fs.renameSync(TMP_PATH, DB_PATH);
  resetForTest();
}
module.exports = {
  init, load, persist, resetForTest, replaceDatabase,
  DEFAULT_GENRES, normalizeMovie, normalize, normalizeHistoryEntry, validateSchema,
  getDbPath: () => DB_PATH, getBakPath: () => BAK_PATH,
};
