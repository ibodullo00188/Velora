// server.js
// KinoBot uchun REST API server. Faqat Node.js ichki modullaridan foydalanadi.
//
// Arxitektura:
//   server.js → repositories (src/repositories) → db (src/db) → data/db.json
//
// server.js database implementatsiyasining ichki tafsilotini bilmaydi —
// faqat repository'lar almashtiriladi.
//
// API formati:
//   Muaffaqiyatli: { ok: true,  data: { ... } }
//   Xatolik:        { ok: false, error: { code: "...", message: "..." } }

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Konfiguratsiya (.env yuklash) — QOLGAN BARCHA LOKAL MODULLARDAN OLDIN!
// ---------------------------------------------------------------------------
// MUHIM: bu IIFE pastdagi `require("./src/...")` qatorlaridan OLDIN turishi
// SHART. Sabab: src/mtproto.js kabi modullar process.env.TELEGRAM_API_ID
// (va h.k.) ni MODUL YUKLANISH PAYTIDA (top-level const) o'qiydi — bu bir
// martalik o'qish. Agar .env bu requirelardan KEYIN yuklansa, o'sha modullar
// "" (bo'sh) qiymatlarni ko'rib qoladi va TELEGRAM_API_ID/HASH .env'da
// to'liq bo'lsa ham telegramStream.isEnabled() doim false qaytaradi
// ("Telegram video xizmati sozlanmagan" xatosi — .env'dagi qiymatlarga
// mutlaqo bog'liq bo'lmagan holda).
(function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  // MUHIM: bu funksiya faqat platforma (Render va h.k.) hali o'rnatmagan
  // o'zgaruvchilarni to'ldiradi. PORT va NODE_ENV kabi platforma o'zi
  // beradigan qiymatlar HECH QACHON .env bilan ustidan yozilmaydi yoki
  // o'chirilmaydi — aks holda Render "no open port" xatosi bilan deploy
  // muvaffaqiyatsiz tugaydi yoki production rejimi kutilmaganda o'chib,
  // xavfsizlik teshigi (dev-mode auth bypass) ochilib qoladi.
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const db = require("./src/db");
const { verifyTelegramInitData } = require("./src/telegramAuth");
const { validateMovieInput, validateGenreName } = require("./src/validation");
const { createRateLimiter } = require("./src/rateLimit");
const repos = require("./src/repositories");
const { startAutoBackup, createBackup } = require("./src/backup");
const { logAudit } = require("./src/auditLog");
const { hashPassword, verifyPassword } = require("./src/password");
const { logger } = require("./src/logger");
const r2 = require("./src/r2");
const localStorage = require("./src/localStorage");
const storageVideos = require("./src/storageVideos");
const channelAutoSave = require("./src/channelAutoSave");
const telegramStream = require("./src/telegramStream");
const videoRouting = require("./src/videoRouting");
const mtproto = require("./src/mtproto");
const posterStore = require("./src/posterStore");
const bannerStore = require("./src/bannerStore");
const imagekitStore = require("./src/imagekitStore");

// Video saqlash: R2 sozlangan bo'lsa — R2, aks holda lokal disk.
// Bitta helper — server.js'da har yerga bir xil mantiq qo'llanadi.
const storage = r2.isConfigured() ? r2 : localStorage;
const STORAGE_MODE = r2.isConfigured() ? "r2" : "local";

// ---------------------------------------------------------------------------
// Lokal video stream tokeni
// ---------------------------------------------------------------------------
// `<video>` elementi custom header yuborolmaydi (X-Telegram-Init-Data yo'q),
// shuning uchun stream URL ichida qisqa muddatli HMAC-token beriladi.
const STREAM_TOKEN_TTL_MS = 6 * 60 * 1000; // 6 daqiqa

function streamTokenSecret() {
  return crypto.createHash("sha256").update(`kinobot-stream:${BOT_TOKEN}:${ADMIN_KEY}`).digest("hex");
}

// Token endi userId'ga ham bog'langan — link ulashilsa, boshqa foydalanuvchi
// (hatto Telegram initData'siz, faqat linkni bilgan holda) undan foydalana
// olmaydi. Eski (userId'siz) tokenlar avtomatik yaroqsiz bo'ladi (payload
// o'zgargani uchun imzo mos kelmaydi) — bu qasddan qilingan.
function signStreamToken(id, quality, userId) {
  const exp = Date.now() + STREAM_TOKEN_TTL_MS;
  const payload = `${id}:${quality}:${userId}:${exp}`;
  const sig = crypto.createHmac("sha256", streamTokenSecret()).update(payload).digest("base64url");
  return `${exp}.${sig}`;
}

function verifyStreamToken(id, quality, userId, token) {
  if (typeof token !== "string") return false;
  const idx = token.indexOf(".");
  if (idx === -1) return false;
  const exp = Number(token.slice(0, idx));
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${id}:${quality}:${userId}:${exp}`;
  const expected = crypto.createHmac("sha256", streamTokenSecret()).update(payload).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Storage-kanal (Telegram MTProto) video strimi uchun alohida token — bir
// xil sir (secret), lekin userId'ga bog'langan (localStorage stream tokeni
// bilan bir xil xavfsizlik darajasi: link ulashilsa ham boshqa foydalanuvchi
// ishlata olmaydi).
const STORAGE_STREAM_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 daqiqa (video uzunroq bo'lishi mumkin)
const STORAGE_STREAM_TOKEN_TTL_SEC = STORAGE_STREAM_TOKEN_TTL_MS / 1000;

function signStorageStreamToken(id, userId) {
  const exp = Date.now() + STORAGE_STREAM_TOKEN_TTL_MS;
  const payload = `sv:${id}:${userId}:${exp}`;
  const sig = crypto.createHmac("sha256", streamTokenSecret()).update(payload).digest("base64url");
  return `${exp}.${sig}`;
}

function verifyStorageStreamToken(id, userId, token) {
  if (typeof token !== "string") return false;
  const idx = token.indexOf(".");
  if (idx === -1) return false;
  const exp = Number(token.slice(0, idx));
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `sv:${id}:${userId}:${exp}`;
  const expected = crypto.createHmac("sha256", streamTokenSecret()).update(payload).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildTelegramStreamUrl(req, storageVideoId, userId) {
  const token = signStorageStreamToken(storageVideoId, userId);
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/api/storage-videos/${encodeURIComponent(storageVideoId)}/stream?token=${encodeURIComponent(token)}&uid=${encodeURIComponent(userId)}`;
}

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : "";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // Default yo'q — production'da o'rnatish shart
const IS_PROD = process.env.NODE_ENV === "production";
// XAVFSIZLIK: dev-mode endi faqat aniq DEV_MODE=1/true bilan yoqiladi.
// Avval "NODE_ENV production emas bo'lsa avtomatik yoqiladi" edi — bu
// fail-open edi: NODE_ENV o'rnatilmagan har qanday serverda (masalan,
// unutilgan .env) ?userId= orqali admin bo'lish mumkin bo'lardi.
const DEV_MODE = process.env.DEV_MODE === "1" || process.env.DEV_MODE === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ANALYTICS_FLUSH_MS = Math.max(5_000, Number(process.env.ANALYTICS_FLUSH_MS) || 30_000);

if (!BOT_TOKEN) {
  logger.error("DIQQAT: BOT_TOKEN o'rnatilmagan. Telegram initData tekshiruvi ishlamaydi.");
}
if (!ADMIN_ID && !ADMIN_KEY) {
  logger.warn("DIQQAT: ADMIN_ID va ADMIN_KEY hammasi bo'sh. Admin endpointlari ishlamaydi.");
}

// Telegram Bot API'ga umumiy so'rov (POST, JSON) — sendMessage, getChatMember
// va h.k. uchun qayta ishlatiladi. Xato bo'lsa {ok:false} qaytaradi (throw qilmaydi).
function telegramApiRequest(method, payload, timeoutMs = 8000) {
  if (!BOT_TOKEN) return Promise.resolve({ ok: false, description: "BOT_TOKEN sozlanmagan" });
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ ok: false, description: "Telegram javobini parse qilib bo'lmadi" });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, description: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, description: "timeout" }); });
    req.write(body);
    req.end();
  });
}

// Telegram Bot API'ga sendMessage — adminga aloqa xabari bildirishnomasi
// yuborish uchun. Xato bo'lsa jim log qiladi (foydalanuvchi oqimini buzmaslik
// uchun) — xabar baribir DB'da saqlangan bo'ladi.
async function sendTelegramMessage(chatId, text) {
  if (!chatId) return false;
  const res = await telegramApiRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
  if (!res.ok) logger.warn("sendTelegramMessage xato: " + (res.description || "noma'lum"));
  return res.ok === true;
}

// ---------------------------------------------------------------------------
// Majburiy obuna — kanal a'zoligini tekshirish
// ---------------------------------------------------------------------------
// getChatMember natijasi keshlanadi (userId -> {result, expiresAt}) — har bir
// webapp ochilishida/video so'rovida Telegram API'ga urilmaslik uchun.
// DIQQAT: bot getChatMember chaqirishi uchun kanalda a'zo (yaxshisi — admin)
// bo'lishi shart, aks holda Telegram "member list is inaccessible" xatosi beradi.
const SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 daqiqa
const subscriptionCache = new Map(); // userId -> { expiresAt } — faqat "to'liq obuna" holati keshlanadi

// Telegram getChatMember xatolari ikki xil bo'ladi:
//  1) foydalanuvchiga bog'liq (u haqiqatan a'zo emas) — bu yerda emas;
//  2) SOZLAMA xatosi — bot kanalda admin emas, chatId noto'g'ri, bot kanaldan
//     chiqarilgan. Bu holatda bot HECH KIM uchun a'zolikni bilolmaydi.
// 2-turdagi xato bo'lsa foydalanuvchini bloklash noto'g'ri: u kanalga
// obuna bo'lgan bo'lsa ham hech qachon ilovaga kira olmaydi.
// DIQQAT: timeout / tarmoq xatosi / "Unauthorized" bu ro'yxatga KIRMAYDI —
// ular vaqtinchalik, shuning uchun xavfsizlik tarafida (fail-closed) qoladi.
function isChannelConfigError(description) {
  const d = String(description || "").toLowerCase();
  if (!d) return false;
  return (
    d.includes("member list is inaccessible") ||
    d.includes("chat not found") ||
    d.includes("chat_admin_required") ||
    d.includes("not enough rights") ||
    d.includes("bot is not a member") ||
    d.includes("bot was kicked") ||
    d.includes("bot was blocked")
  );
}

async function checkSubscription(userId) {
  const channels = repos.channels.listChannels();
  if (!channels.length) return { subscribed: true, missing: [] };

  const cached = subscriptionCache.get(String(userId));
  if (cached && cached.expiresAt > Date.now()) {
    return { subscribed: true, missing: [] };
  }

  const missing = [];
  for (const ch of channels) {
    const res = await telegramApiRequest("getChatMember", { chat_id: ch.chatId, user_id: userId });

    // SOZLAMA XATOSI: bot kanalda admin emas / chatId noto'g'ri / bot kanaldan
    // chiqarilgan. Bunday holatda Telegram HECH KIM uchun a'zolikni ayta olmaydi
    // — natijada allaqachon obuna bo'lgan foydalanuvchi ham "obuna emas" deb
    // hisoblanib, ilovaga umuman kira olmay qolardi (chiqish yo'li yo'q edi).
    // Shuning uchun bu kanal tekshiruvdan o'tkazib yuboriladi va admin uchun
    // aniq xato logi yoziladi.
    if (!res.ok && isChannelConfigError(res.description)) {
      logger.error(
        `Majburiy obuna kanali sozlanmagan (${ch.chatId}): ${res.description || "noma'lum"}. ` +
        `Bot shu kanalga ADMIN qilib qo'shilishi kerak, aks holda a'zolikni tekshirib bo'lmaydi.`
      );
      continue;
    }

    const status = res.ok && res.result ? res.result.status : null;
    // "restricted" holatida a'zolik is_member maydoni bilan aniqlanadi.
    const isMember =
      status &&
      !["left", "kicked"].includes(status) &&
      !(status === "restricted" && res.result.is_member === false);
    if (!isMember) {
      missing.push({ id: ch.id, title: ch.title, inviteLink: ch.inviteLink });
      if (!res.ok) {
        logger.warn(`getChatMember xato (${ch.chatId}, user=${userId}): ${res.description || "noma'lum"}`);
      }
    }
  }

  // MUHIM: faqat TO'LIQ obuna bo'lgan holat keshlanadi. Aks holda
  // foydalanuvchi kanalga hozirgina qo'shilgan bo'lsa ham, avvalgi
  // "obuna emas" natijasi keshdan 5 daqiqagacha qaytaverardi — aynan shu
  // "tekshirish ishlamayapti" muammosining sababi shu edi.
  if (missing.length === 0) {
    subscriptionCache.set(String(userId), { expiresAt: Date.now() + SUBSCRIPTION_CACHE_TTL_MS });
  } else {
    subscriptionCache.delete(String(userId));
  }
  return { subscribed: missing.length === 0, missing };
}

// Obuna bekor qilingandan keyin (yoki admin kanal ro'yxatini o'zgartirganda)
// keshni tozalash uchun.
function clearSubscriptionCache() {
  subscriptionCache.clear();
}



// Xavfsizlik headerlari — barcha API javoblariga qo'shiladi (nginx bo'lmagan
// sozlamalarda ham ishlashi uchun; deploy/nginx.conf bilan takrorlanadi).
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
  // API javoblari keshlanmasin (maxfiy foydalanuvchi ma'lumotlari xavfsizligi).
  "Cache-Control": "no-store",
};

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------
const limitGeneral = createRateLimiter({ windowMs: 60_000, max: 240 });
const limitAuth = createRateLimiter({ windowMs: 60_000, max: 10 }); // brute-force himoya (qat'iy)
const limitAdmin = createRateLimiter({ windowMs: 60_000, max: 60 });

function rateLimitKey(req) {
  const user = resolveUserIdRaw(req);
  if (user) return `user:${user}`;
  return `ip:${req.socket.remoteAddress || "unknown"}`;
}

// Rate limitni qo'llash + javobga X-RateLimit-* headerlarini qo'yish.
function applyRateLimit(req, res, limiter, key) {
  const rl = limiter(key);
  res.setHeader("X-RateLimit-Limit", String(limiter.max));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rl.remaining)));
  if (!rl.allowed) res.setHeader("Retry-After", String(rl.retryAfter));
  return rl;
}

// ---------------------------------------------------------------------------
// API javob yordamchilari
// ---------------------------------------------------------------------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    ...(res._corsHeader || {}),
  };
  res.writeHead(status, headers);
  res.end(body);
}

function ok(res, status, data) {
  sendJSON(res, status, { ok: true, data });
}

function fail(res, status, code, message) {
  sendJSON(res, status, { ok: false, error: { code, message } });
}

// Public (oddiy foydalanuvchi) uchun film obyektini tozalaydi:
// R2 ichki objectKey maydoni yashiriladi (quality + metadata + storageType qoladi).
// storageType "r2" | "local" — frontend badge ko'rsatishi uchun qo'shiladi.
function sanitizeMovie(movie) {
  if (!movie || !movie.videoSources || typeof movie.videoSources !== "object" || Array.isArray(movie.videoSources)) {
    return movie;
  }
  const vs = { ...movie.videoSources };
  let changed = false;
  for (const k of Object.keys(vs)) {
    const v = vs[k];
    if (v && typeof v === "object" && typeof v.objectKey === "string") {
      const meta = { size: v.size, uploadedAt: v.uploadedAt };
      if (v.storageType) meta.storageType = v.storageType;
      vs[k] = meta;
      changed = true;
    }
  }
  return changed ? { ...movie, videoSources: vs } : movie;
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function applyCors(req, res) {
  const origin = req.headers.origin;
  const acao = resolveAllowedOrigin(origin);
  if (acao) {
    res._corsHeader = {
      "Access-Control-Allow-Origin": acao,
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Telegram-Init-Data, X-Request-ID",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    };
  }
  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    if (res._corsHeader) {
      res.writeHead(204, { ...SECURITY_HEADERS, ...res._corsHeader });
    } else {
      res.writeHead(204, SECURITY_HEADERS);
    }
    res.end();
    return true; // handled
  }
  return false;
}

function resolveAllowedOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS[0] : "*";
  if (ALLOWED_ORIGINS.length) {
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  }
  return IS_PROD ? origin : "*"; // dev mode: barchaga ruxsat
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------
function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error("__PAYLOAD_TOO_LARGE__"));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("JSON noto'g'ri formatda"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Autentifikatsiya yordamchilari
// ---------------------------------------------------------------------------

// initData'dan user ID olish (yaroqli initData bo'lsa); aks holda dev mode'da
// query/body userId qaytaradi.
function resolveUserIdRaw(req) {
  const initData = req.headers["x-telegram-init-data"];
  if (initData && BOT_TOKEN) {
    const r = verifyTelegramInitData(initData, BOT_TOKEN);
    if (r.ok && r.user) return String(r.user.id);
  }
  return null;
}

// Barcha himoyalangan endpoint uchun: verified yoki dev-mode user.
// BLOCKED user'lar rad etiladi (error = "USER_BLOCKED").
// return { userId, user, error }
function resolveUserId(req, parsedBody) {
  // 1) Telegram initData bo'lsa — faqat tekshirilgan user'dan foydalanamiz.
  const initData = req.headers["x-telegram-init-data"];
  if (initData && BOT_TOKEN) {
    const r = verifyTelegramInitData(initData, BOT_TOKEN);
    if (r.ok && r.user) {
      const userId = String(r.user.id);
      const u = repos.users.getUser(userId);
      if (u && repos.users.isBlocked(u)) return { userId: null, user: null, error: "USER_BLOCKED" };
      return { userId, user: r.user, error: null };
    }
    if (!r.ok) return { userId: null, user: null, error: r.reason || "initData yaroqsiz" };
  }
  // 2) Dev mode: query/body userId orqali ruxsat beriladi.
  if (DEV_MODE) {
    const url = new URL(req.url, "http://localhost");
    const fallback = url.searchParams.get("userId") || (parsedBody && parsedBody.userId);
    if (fallback) {
      const userId = String(fallback);
      const u = repos.users.getUser(userId);
      if (u && repos.users.isBlocked(u)) return { userId: null, user: null, error: "USER_BLOCKED" };
      return { userId, user: null, error: null };
    }
  }
  return { userId: null, user: null, error: "Telegram initData topilmadi yoki yaroqsiz" };
}

// resolveUserId xatoligini mos HTTP statusga o'tkazadi.
// BLOCKED → 403 FORBIDDEN, aks holda → 401 UNAUTHORIZED.
function unauthorized(res, error) {
  if (error === "USER_BLOCKED") {
    return fail(res, 403, "FORBIDDEN", "Hisobingiz bloklangan. Yordam uchun administratorga murojaat qiling.");
  }
  return fail(res, 401, "UNAUTHORIZED", error);
}

// Admin endpointlari uchun: admin ekanligini tekshirish.
// return null — xato (res'ga javob yuborilgan); { admin:true } — ruxsat.
function requireAdmin(req, res) {
  const initData = req.headers["x-telegram-init-data"];
  const adminKeyHeader = req.headers["x-admin-key"];

  // 1) Telegram initData orqali admin tekshirish.
  //    Ikki toifadagi foydalanuvchi admin hisoblanadi: (a) .env'dagi asosiy
  //    ADMIN_ID, (b) admin panelda "Adminga aylantirish" tugmasi orqali
  //    belgilangan foydalanuvchi (repos.users record'idagi isAdmin bayrog'i).
  //    Avval faqat (a) tekshirilardi — shuning uchun tugma orqali admin
  //    qilingan foydalanuvchi hech qachon haqiqiy admin huquqiga ega
  //    bo'lolmasdi.
  if (initData && BOT_TOKEN) {
    const r = verifyTelegramInitData(initData, BOT_TOKEN);
    if (r.ok && r.user) {
      const uid = String(r.user.id);
      const isPrimaryAdmin = Boolean(ADMIN_ID) && uid === ADMIN_ID;
      const record = repos.users.getUser(uid);
      const isGrantedAdmin = Boolean(record && record.isAdmin);
      if (isPrimaryAdmin || isGrantedAdmin) {
        return { admin: true, via: "telegram", userId: uid };
      }
      fail(res, 403, "FORBIDDEN", "Bu amal faqat admin uchun");
      return null;
    }
  }

  // 2) Dev mode: Telegram'dasiz ADMIN_ID tekshiruvi.
  if (DEV_MODE && ADMIN_ID) {
    const uid = resolveUserIdRaw(req);
    if (uid === ADMIN_ID) return { admin: true, via: "dev-telegram", userId: uid };
  }

  // 3) X-Admin-Key header.
  //    Admin panelda parol o'zgartirilgan bo'lsa, saqlangan hash tekshiriladi
  //    (u ADMIN_KEY o'rnini bosadi). Aks holda .env'dagi ADMIN_KEY ishlatiladi.
  if (adminKeyHeader) {
    const storedHash = repos.settings.getAdminPasswordHash();
    let valid = false;
    if (storedHash) {
      valid = verifyPassword(adminKeyHeader, storedHash);
    } else if (ADMIN_KEY) {
      valid = typeof adminKeyHeader === "string" && typeof ADMIN_KEY === "string" &&
        adminKeyHeader.length === ADMIN_KEY.length && crypto.timingSafeEqual(
          Buffer.from(adminKeyHeader), Buffer.from(ADMIN_KEY)
        );
    }
    if (valid) return { admin: true, via: "admin-key" };
    if (storedHash || ADMIN_KEY) {
      fail(res, 403, "FORBIDDEN", "Admin kaliti noto'g'ri");
      return null;
    }
  }

  // 4) Hech qanday admin usuli ishlamadi.
  if (!ADMIN_ID && !ADMIN_KEY) {
    fail(res, 503, "CONFIG_ERROR", "Admin konfiguratsiyasi yetishmayapti (ADMIN_ID yoki ADMIN_KEY o'rnatilmagan)");
    return null;
  }
  fail(res, 403, "FORBIDDEN", "Ruxsat yo'q. Telegram orqali admin sifatida kiring.");
  return null;
}

// ---------------------------------------------------------------------------
// Route handlerlar
// ---------------------------------------------------------------------------

// -- Filmlar (oddiy foydalanuvchilar)
async function handleMovies(req, res, url) {
  const result = repos.movies.list({
    genre: url.searchParams.get("genre"),
    q: url.searchParams.get("q"),
    yearMin: url.searchParams.get("yearMin"),
    yearMax: url.searchParams.get("yearMax"),
    ratingMin: url.searchParams.get("ratingMin"),
    sort: url.searchParams.get("sort"),
    page: url.searchParams.get("page"),
    limit: url.searchParams.get("limit"),
  });
  ok(res, 200, { count: result.movies.length, movies: result.movies.map(sanitizeMovie), total: result.total, page: result.page, totalPages: result.totalPages });
}

async function handleMovieDetail(req, res, id) {
  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  // "inactive"/"hidden" — hech kimga ko'rinmaydi (faqat admin panelda
  // boshqariladi). Mavjudligini oshkor qilmaslik uchun 404 qaytariladi.
  if (movie.status !== "active") return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  const similar = repos.movies.getSimilar(movie);
  ok(res, 200, { movie: sanitizeMovie(movie), similar: similar.map(sanitizeMovie) });
}

// GET /api/movies/code/:code — kod bilan film topish (public, auth shart emas)
async function handleMovieByCode(req, res, code) {
  if (!code || typeof code !== "string") {
    return fail(res, 400, "VALIDATION_ERROR", "Kod majburiy");
  }
  // Kod formatini tozalash
  const normalizedCode = code.replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase();
  const movie = repos.movies.getById(normalizedCode);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  if (movie.status !== "active") return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  ok(res, 200, { movie: sanitizeMovie(movie) });
}

async function handleGenres(req, res) {
  ok(res, 200, { genres: repos.genres.list() });
}

// -- Majburiy obuna kanallari (public) ----
// GET /api/channels/required — webapp'da "obuna bo'lish" ekrani uchun kanallar ro'yxati.
async function handleChannelsRequired(req, res) {
  const channels = repos.channels.listChannels().map((c) => ({
    id: c.id,
    title: c.title,
    inviteLink: c.inviteLink,
  }));
  ok(res, 200, { channels });
}

// GET /api/channels/check — foydalanuvchi barcha majburiy kanallarga obuna bo'lganmi?
async function handleChannelsCheck(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);
  const result = await checkSubscription(userId);
  ok(res, 200, result);
}

// -- Admin: premium tizimini yoqish/o'chirish ----
async function handleAdminSetPremiumEnabled(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  if (typeof body.enabled !== "boolean") {
    return fail(res, 422, "VALIDATION_ERROR", "enabled (true/false) majburiy");
  }

  await repos.settings.setPremiumEnabled(body.enabled);
  await logAudit({
    adminId: admin.userId,
    action: body.enabled ? "ADMIN_ENABLED_PREMIUM" : "ADMIN_DISABLED_PREMIUM",
    entityType: "settings",
    entityId: "premiumEnabled",
  });
  ok(res, 200, { enabled: body.enabled });
}

// -- Admin: video-strimni (Telegram MTProto) faqat Premium foydalanuvchilarga
// cheklashni yoqish/o'chirish ----
async function handleAdminSetStreamingPremiumOnly(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  if (typeof body.enabled !== "boolean") {
    return fail(res, 422, "VALIDATION_ERROR", "enabled (true/false) majburiy");
  }

  await repos.settings.setStreamingPremiumOnly(body.enabled);
  await logAudit({
    adminId: admin.userId,
    action: body.enabled ? "ADMIN_ENABLED_STREAMING_PREMIUM_ONLY" : "ADMIN_DISABLED_STREAMING_PREMIUM_ONLY",
    entityType: "settings",
    entityId: "streamingPremiumOnly",
  });
  ok(res, 200, { enabled: body.enabled });
}

// -- Admin: majburiy obuna kanallari CRUD ----
async function handleAdminListChannels(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  ok(res, 200, { channels: repos.channels.listChannels() });
}

async function handleAdminAddChannel(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { chatId, title, inviteLink } = body || {};
  if (!chatId || typeof chatId !== "string" || !chatId.trim()) {
    return fail(res, 422, "VALIDATION_ERROR", "chatId majburiy (@username yoki -100xxxxxxxxxx)");
  }

  const result = await repos.channels.addChannel({ chatId, title, inviteLink });
  if (result.error) return fail(res, 422, "VALIDATION_ERROR", result.error);
  if (result.conflict) return fail(res, 409, "CONFLICT", "Bu kanal allaqachon ro'yxatda");

  clearSubscriptionCache();
  await logAudit({ adminId: admin.userId, action: "ADMIN_ADDED_CHANNEL", entityType: "channel", entityId: result.channel.id, newValue: result.channel });
  ok(res, 201, { channel: result.channel });
}

async function handleAdminDeleteChannel(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const removed = await repos.channels.removeChannel(id);
  if (!removed) return fail(res, 404, "NOT_FOUND", "Kanal topilmadi");

  clearSubscriptionCache();
  await logAudit({ adminId: admin.userId, action: "ADMIN_REMOVED_CHANNEL", entityType: "channel", entityId: id });
  ok(res, 200, { ok: true });
}

// -- Admin: storage kanalga avtomatik saqlangan videolar (Telegram MTProto) ----

// GET /api/admin/storage-videos
async function handleAdminListStorageVideos(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (!channelAutoSave.isEnabled()) {
    return ok(res, 200, { enabled: false, videos: [] });
  }
  ok(res, 200, { enabled: true, videos: storageVideos.listEntries() });
}

// DELETE /api/admin/storage-videos/:id — faqat DB yozuvini o'chiradi.
// (Telegram'dagi storage-kanal xabarini o'chirish qasddan qilinmagan —
// admin xohlasa storage kanaldan qo'lda o'chirishi mumkin.)
async function handleAdminDeleteStorageVideo(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const removed = await storageVideos.removeById(id);
  if (!removed) return fail(res, 404, "NOT_FOUND", "Yozuv topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_REMOVED_STORAGE_VIDEO", entityType: "storageVideo", entityId: id });
  ok(res, 200, { ok: true });
}

// GET /api/admin/storage-videos/:id/stream-url — qisqa muddatli tokenli strim URL
async function handleAdminStorageVideoStreamUrl(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const entry = storageVideos.getById(id);
  if (!entry) return fail(res, 404, "NOT_FOUND", "Yozuv topilmadi");

  const url = buildTelegramStreamUrl(req, id, admin.userId || "admin");
  ok(res, 200, { url, title: entry.fileName || entry.caption || id });
}

// GET/HEAD /api/storage-videos/:id/stream — tokenli, Range qo'llab-quvvatlaydi
async function handleStorageVideoStream(req, res, id) {
  const u = new URL(req.url, "http://localhost");
  const token = u.searchParams.get("token") || "";
  const uid = u.searchParams.get("uid") || "";
  if (!verifyStorageStreamToken(id, uid, token)) {
    return unauthorized(res, "AUTH_REQUIRED");
  }
  const entry = storageVideos.getById(id);
  if (!entry) return fail(res, 404, "NOT_FOUND", "Video topilmadi");

  await telegramStream.streamStorageVideo(req, res, entry);
}

// -- Sevimlilar (himoyalangan — verified user)
async function handleGetFavorites(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);
  ok(res, 200, { movies: repos.favorites.list(userId).map(sanitizeMovie) });
}

async function handleToggleFavorite(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { movieId } = body;
  if (!movieId || typeof movieId !== "string") {
    return fail(res, 400, "VALIDATION_ERROR", "movieId majburiy va string bo'lishi kerak");
  }
  if (!repos.movies.exists(movieId)) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  const wasFav = repos.favorites.isFavorite(userId, movieId);
  const result = await repos.favorites.toggle(userId, movieId);
  repos.analytics.bufferEvent(wasFav ? "favoriteRemoved" : "favoriteAdded", { userId, movieId });
  ok(res, 200, { isFavorite: result.isFavorite, movieId });
}

// -- Tarix (himoyalangan)
async function handleGetHistory(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);
  ok(res, 200, { history: repos.history.list(userId).map((h) => ({ ...h, movie: sanitizeMovie(h.movie) })) });
}

// Continue Watching — progress 1..94% bo'lgan, oxirgi ko'rilgan filmlar.
async function handleGetContinueWatching(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);
  ok(res, 200, { continueWatching: repos.history.getContinueWatching(userId).map((h) => ({ ...h, movie: sanitizeMovie(h.movie) })) });
}

async function handleRecordHistory(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { movieId, progressPct, positionSeconds } = body;
  if (!movieId || typeof movieId !== "string") {
    return fail(res, 400, "VALIDATION_ERROR", "movieId majburiy");
  }
  if (!repos.movies.exists(movieId)) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  await repos.history.save(userId, movieId, { progressPct, positionSeconds });
  repos.analytics.bufferEvent("historyUpdated", { userId, movieId });
  ok(res, 200, { ok: true });
}

// -- Profil (himoyalangan)
async function handleGetProfile(req, res) {
  const { userId, user: tgUser, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  const record = await repos.users.upsertFromTelegram(userId, tgUser || {});
  const profile = { ...record };
  // ADMIN_ID (.env'dagi asosiy admin) HAR DOIM admin, bundan tashqari admin
  // panelda "Adminga aylantirish" tugmasi orqali belgilangan foydalanuvchilar
  // ham (repos.users.setAdmin orqali saqlangan) — avval bu yerda faqat
  // ADMIN_ID tekshirilib, saqlangan bayroq har doim ustidan yozib
  // yuborilardi, shuning uchun tugma hech qanday amaliy natija bermasdi.
  profile.isAdmin = (ADMIN_ID && profile.id === ADMIN_ID) || Boolean(record.isAdmin);
  repos.analytics.bufferEvent("userOpenedApp", { userId });
  ok(res, 200, { user: profile });
}

// -- Auth/telegram
async function handleAuthTelegram(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const rateKey = `auth:${req.socket.remoteAddress}`;
  const rl = applyRateLimit(req, res, limitAuth, rateKey);
  if (!rl.allowed) {
    return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov. Biroz kutib qayta urinib ko'ring.");
  }

  const { initData } = body;
  const result = verifyTelegramInitData(initData, BOT_TOKEN);
  if (!result.ok) return fail(res, 401, "UNAUTHORIZED", result.reason);

  // BLOCKED user login qila olmaydi (lastSeenAt yangilanmaydi).
  const existing = repos.users.getUser(result.user.id);
  if (existing && repos.users.isBlocked(existing)) {
    return fail(res, 403, "FORBIDDEN", "Hisobingiz bloklangan. Yordam uchun administratorga murojaat qiling.");
  }

  const isNew = !existing;
  const record = await repos.users.upsertFromTelegram(result.user.id, result.user);
  if (isNew) repos.analytics.bufferEvent("userRegistered", { userId: record.id });
  const profile = { ...record };
  // ADMIN_ID (.env'dagi asosiy admin) HAR DOIM admin, bundan tashqari admin
  // panelda "Adminga aylantirish" tugmasi orqali belgilangan foydalanuvchilar
  // ham (repos.users.setAdmin orqali saqlangan) — avval bu yerda faqat
  // ADMIN_ID tekshirilib, saqlangan bayroq har doim ustidan yozib
  // yuborilardi, shuning uchun tugma hech qanday amaliy natija bermasdi.
  profile.isAdmin = (ADMIN_ID && profile.id === ADMIN_ID) || Boolean(record.isAdmin);
  ok(res, 200, { user: profile });
}

// -- Admin: filmlar CRUD
async function handleAdminListMovies(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  const result = repos.movies.adminList({
    q: url.searchParams.get("q"),
    genre: url.searchParams.get("genre"),
    yearMin: url.searchParams.get("yearMin"),
    yearMax: url.searchParams.get("yearMax"),
    ratingMin: url.searchParams.get("ratingMin"),
    status: url.searchParams.get("status"),
    page: url.searchParams.get("page"),
    limit: url.searchParams.get("limit"),
  });
  ok(res, 200, { count: result.movies.length, movies: result.movies, total: result.total, page: result.page, totalPages: result.totalPages });
}

async function handleAdminCreateMovie(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const { ok: valid, errors } = validateMovieInput(body);
  if (!valid) return fail(res, 422, "VALIDATION_ERROR", errors.map((e) => `${e.field}: ${e.message}`).join("; "));

  const result = await repos.movies.create(body);
  if (result.conflict) return fail(res, 409, "CONFLICT", "Film ID allaqachon mavjud");

  await logAudit({ adminId: admin.userId, action: "ADMIN_CREATED_MOVIE", entityType: "movie", entityId: result.movie.id, newValue: { title: result.movie.title } });
  ok(res, 201, { movie: result.movie });
}

async function handleAdminUpdateMovie(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const { ok: valid, errors } = validateMovieInput(body, true);
  if (!valid) return fail(res, 422, "VALIDATION_ERROR", errors.map((e) => `${e.field}: ${e.message}`).join("; "));

  const before = repos.movies.getById(id);
  const movie = await repos.movies.update(id, body);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_UPDATED_MOVIE", entityType: "movie", entityId: id, oldValue: before, newValue: movie });
  ok(res, 200, { movie });
}

async function handleAdminDeleteMovie(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  const removed = await repos.movies.remove(id);
  if (!removed) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  // Poster + video objectlari cleanup — ikkala storage'da ham tozalanadi (best-effort).
  await posterStore.removeByMovieId(id);
  await localStorage.removeByMovieId(id);
  if (r2.isConfigured()) {
    const prefix = r2.buildObjectPrefix(id);
    try {
      const deleted = await r2.deleteObjectsByPrefix(prefix);
      if (deleted > 0) {
        logger.info("R2 video cleanup completed", { movieId: id, objects: deleted });
      }
    } catch (e) {
      logger.warn("R2 video cleanup failed", { movieId: id, error: e.message });
    }
  }

  await logAudit({ adminId: admin.userId, action: "ADMIN_DELETED_MOVIE", entityType: "movie", entityId: id, oldValue: { title: removed.title } });
  ok(res, 200, { ok: true });
}

// -- Video URL (oddiy foydalanuvchi uchun)
// GET /api/movies/:id/video/:quality
// Manba tanlash qat'iy prioritet bilan videoRouting modulida:
//   1. R2 tekshiriladi (HEAD, 3s timeout) → presigned GET URL
//   2. R2'da yo'q yoki xato → Kali lokal fayl → tokenli stream URL
//   3. Ikkalasi ham yo'q → 404 "video mavjud emas"
function buildLocalStreamUrl(req, id, quality, userId) {
  const token = signStreamToken(id, quality, userId);
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/api/movies/${encodeURIComponent(id)}/video/${encodeURIComponent(quality)}/stream?token=${encodeURIComponent(token)}&uid=${encodeURIComponent(userId)}`;
}

async function handleMovieVideoUrl(req, res, id, quality) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  // Majburiy obuna tekshiruvi — faqat frontend gate'iga tayanmaslik uchun
  // (to'g'ridan-to'g'ri API so'rovi bilan aylanib o'tib bo'lmasligi kerak).
  const subscription = await checkSubscription(userId);
  if (!subscription.subscribed) {
    return fail(res, 403, "SUBSCRIPTION_REQUIRED", "Video ko'rish uchun barcha kanallarga obuna bo'ling");
  }

  if (!storage.isValidQuality(quality)) {
    return fail(res, 422, "VALIDATION_ERROR", "Noma'lum quality. Ruxsat etilgan: " + storage.QUALITIES.join(", "));
  }
  if (!storage.isConfigured() && !localStorage.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "Video xizmati sozlanmagan");
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  // "inactive"/"hidden" — hech kimga ko'rinmaydi (faqat admin panelda
  // boshqariladi).
  if (movie.status !== "active") return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  // Premium film tekshiruvi — tizim butunlay o'chirilgan bo'lsa (admin
  // panel orqali), premium filmlar ham hammaga ochiq bo'ladi (aks holda
  // premium UI yashirin bo'lganda foydalanuvchi umuman ochib bo'lmaydigan
  // filmga duch kelib qolardi).
  if (movie.isPremium && repos.settings.getPremiumEnabled()) {
    const premium = repos.premium.getPremiumStatus(userId);
    if (!premium.isActive) {
      return fail(res, 403, "PREMIUM_REQUIRED", "Bu film faqat Premium foydalanuvchilari uchun");
    }
    // Plan covers movie check (if plan has specific movieIds)
    if (premium.plan && !repos.plans.validatePlanCoversMovie(premium.plan, id)) {
      const planName = repos.plans.getPlanById(premium.plan)?.name || premium.plan;
      return fail(res, 403, "PREMIUM_PLAN_MISMATCH", `Bu film ${planName} paketi bilan ochiladi`);
    }
  }

  const src = movie.videoSources && typeof movie.videoSources === "object" && movie.videoSources[quality];
  if (!src || typeof src.objectKey !== "string") {
    return fail(res, 404, "NOT_FOUND", `Bu film uchun ${quality} video mavjud emas`);
  }

  // Telegram (storage-kanal) manbali video — R2/lokal fallback zanjiriga
  // kirmaydi, to'g'ridan-to'g'ri telegramStream orqali strim qilinadi.
  if (src.storageType === "telegram") {
    if (!telegramStream.isEnabled()) {
      return fail(res, 503, "SERVICE_UNAVAILABLE", "Telegram video xizmati sozlanmagan");
    }
    // Admin panel orqali yoqilgan bo'lsa, to'g'ridan-to'g'ri strim faqat
    // faol Premium foydalanuvchilarga ochiq (film o'zi premium deb
    // belgilanmagan bo'lsa ham). Boshqa yetkazish usullariga (masalan
    // botga forward) taalluqli emas.
    if (repos.settings.getStreamingPremiumOnly() && !repos.premium.isPremiumActive(userId)) {
      return fail(res, 403, "PREMIUM_REQUIRED", "Video strim faqat Premium foydalanuvchilari uchun");
    }
    const storageVideoId = src.storageVideoId || String(src.objectKey).replace(/^telegram:/, "");
    const svEntry = storageVideos.getById(storageVideoId);
    if (!svEntry) {
      return fail(res, 404, "NOT_FOUND", `Bu film uchun ${quality} video mavjud emas`);
    }
    const url = buildTelegramStreamUrl(req, storageVideoId, userId);
    repos.analytics.bufferEvent("playbackStarted", { userId, movieId: id, quality, storageType: "telegram" });
    return ok(res, 200, { url, expiresIn: STORAGE_STREAM_TOKEN_TTL_SEC, quality, storageType: "telegram" });
  }

  const resolved = await videoRouting.resolveVideoSource({
    movieId: id,
    quality,
    r2,
    local: localStorage,
    buildStreamUrl: (mid, q) => buildLocalStreamUrl(req, mid, q, userId),
    logger,
  });

  if (!resolved) {
    return fail(res, 404, "NOT_FOUND", `Bu film uchun ${quality} video mavjud emas`);
  }

  repos.analytics.bufferEvent("playbackStarted", { userId, movieId: id, quality, storageType: resolved.storageType });
  ok(res, 200, { url: resolved.url, expiresIn: 300, quality, storageType: resolved.storageType });
}

// -- Videoni to'g'ridan-to'g'ri bot chatiga forward qilish (YAGONA yetkazish usuli)
// POST /api/movies/:id/deliver
//
// R2 va lokal (Kali) strim ancha vaqtdan beri barqaror ishlamayapti va
// MTProto orqali telegramStream ham beqaror — shuning uchun webapp'dagi
// "Tomosha qilish" tugmasi endi hech qanday pleyer ochmaydi. Buning
// o'rniga storage kanaldagi ASL xabar oddiy Bot API copyMessage bilan
// foydalanuvchining bot bilan shaxsiy chatiga nusxalanadi (xuddi
// channelCodes/handleCodeMessage'dagi kabi — Telegram'ning o'zi orqali,
// hajm chegarasi yo'q, qayta kodlash/yuklash shart emas).
//
// Eslatma: bu eski /video/:quality (R2/lokal/telegramStream) endpointini
// olib tashlamaydi — admin panel va eski mijozlar buzilmasligi uchun u
// tegilmagan holda qoladi, faqat asosiy foydalanuvchi oqimi endi bu
// yerdan o'tadi.
const limitDeliver = createRateLimiter({ windowMs: 60_000, max: 10 });

// movie.videoSources ichidan birinchi "telegram" manbali yozuvni topadi
// (autoMovie.js har doim faqat bitta kalit — masalan "480p" — ostida
// yaratadi, lekin admin qo'lda boshqa kalitlarga ham qo'shishi mumkin,
// shuning uchun barcha kalitlar aylanib chiqiladi).
function findTelegramSource(movie) {
  const vs = movie && movie.videoSources;
  if (!vs || typeof vs !== "object" || Array.isArray(vs)) return null;
  for (const key of Object.keys(vs)) {
    const src = vs[key];
    if (src && src.storageType === "telegram" && src.storageVideoId) return src;
  }
  return null;
}

async function handleDeliverMovie(req, res, id) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  const rl = applyRateLimit(req, res, limitDeliver, `deliver:${userId}`);
  if (!rl.allowed) {
    return fail(res, 429, "RATE_LIMITED", "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring.");
  }

  const subscription = await checkSubscription(userId);
  if (!subscription.subscribed) {
    return fail(res, 403, "SUBSCRIPTION_REQUIRED", "Video olish uchun barcha kanallarga obuna bo'ling");
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  if (movie.status !== "active") return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  // Premium tekshiruvi — handleMovieVideoUrl bilan bir xil mantiq.
  if (movie.isPremium && repos.settings.getPremiumEnabled()) {
    const premium = repos.premium.getPremiumStatus(userId);
    if (!premium.isActive) {
      return fail(res, 403, "PREMIUM_REQUIRED", "Bu film faqat Premium foydalanuvchilari uchun");
    }
    if (premium.plan && !repos.plans.validatePlanCoversMovie(premium.plan, id)) {
      const planName = repos.plans.getPlanById(premium.plan)?.name || premium.plan;
      return fail(res, 403, "PREMIUM_PLAN_MISMATCH", `Bu film ${planName} paketi bilan ochiladi`);
    }
  }

  const src = findTelegramSource(movie);
  if (!src) {
    return fail(res, 404, "NOT_FOUND", "Bu film hozircha yuborish uchun ulanmagan. Admin bilan bog'laning.");
  }

  const svEntry = storageVideos.getById(src.storageVideoId);
  if (!svEntry) {
    return fail(res, 404, "NOT_FOUND", "Video manbasi topilmadi. Admin bilan bog'laning.");
  }

  const copyRes = await telegramApiRequest("copyMessage", {
    chat_id: userId,
    from_chat_id: svEntry.storageChannelId,
    message_id: svEntry.storageMessageId,
  });

  if (!copyRes.ok) {
    logger.warn("Video forward (deliver) xatosi", {
      movieId: id,
      userId,
      error: copyRes.description || "noma'lum",
    });
    return fail(res, 502, "DELIVERY_FAILED", "Videoni yuborishda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.");
  }

  repos.analytics.bufferEvent("videoDelivered", { userId, movieId: id });
  ok(res, 200, { ok: true, delivered: true });
}

// -- Admin video presign (browser to'g'ridan-to'g'ri storage'ga upload uchun)
// POST /api/admin/movies/:id/video/presign
// body.storage: "r2" | "local" (ixtiyoriy; berilmasa STORAGE_MODE ishlatiladi).
// R2 mode: presigned PUT URL; lokal mode: server'dagi upload endpoint.
async function handleAdminVideoPresign(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { quality, contentType, size, storage: reqStorage } = body || {};
  const targetStorage = reqStorage === "r2" || reqStorage === "local" ? reqStorage : STORAGE_MODE;

  if (!storage.isValidQuality(quality)) {
    return fail(res, 422, "VALIDATION_ERROR", "Noma'lum quality. Ruxsat etilgan: " + storage.QUALITIES.join(", "));
  }
  if (!contentType || typeof contentType !== "string" || !/^video\/[a-z0-9.+-]+$/i.test(contentType)) {
    return fail(res, 422, "VALIDATION_ERROR", "contentType video fayl bo'lishi kerak (video/...)");
  }
  if (size != null && (!Number.isFinite(Number(size)) || Number(size) <= 0)) {
    return fail(res, 422, "VALIDATION_ERROR", "size musbat raqam bo'lishi kerak");
  }
  if (targetStorage === "r2" && !r2.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "R2 sozlanmagan");
  }
  if (targetStorage === "local" && !localStorage.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "Lokal video papka sozlanmagan");
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  const objectKey = storage.buildObjectKey(id, quality);
  let uploadUrl;
  if (targetStorage === "local") {
    // Lokal rejim: XHR shu endpoint'ga PUT qiladi (fayl body).
    uploadUrl = `/api/admin/movies/${encodeURIComponent(id)}/video/upload/${encodeURIComponent(quality)}`;
  } else {
    try {
      uploadUrl = r2.presignedPutUrl(objectKey, contentType, { expiresInSeconds: 900 });
    } catch (e) {
      logger.warn("Presigned PUT failed", { movieId: id, quality, error: e.message });
      return fail(res, 502, "BAD_GATEWAY", "Upload URL yaratib bo'lmadi");
    }
  }

  ok(res, 200, { uploadUrl, objectKey, expiresIn: 900, quality, mode: targetStorage });
}

// -- Lokal mode: admin video upload (browser PUT qiladi, body faylga yoziladi)
// PUT /api/admin/movies/:id/video/upload/:quality
// STORAGE_MODE'dan qat'iy nazar ishlaydi — admin Kali lokal videoni
// R2 asosiy rejimda bo'lsa ham yuklay oladi.
async function handleAdminVideoUpload(req, res, id, quality) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  if (!localStorage.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "Lokal video papka sozlanmagan");
  }
  if (!storage.isValidQuality(quality)) {
    return fail(res, 422, "VALIDATION_ERROR", "Noma'lum quality. Ruxsat etilgan: " + storage.QUALITIES.join(", "));
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  const objectKey = localStorage.buildObjectKey(id, quality);
  let saved;
  try {
    saved = await localStorage.saveStream(req, objectKey);
  } catch (e) {
    logger.warn("Local upload failed", { movieId: id, quality, error: e.message });
    // Eslatma: fayl yarim yuklangan bo'lishi mumkin — temp fayl auto-tozalanadi.
    return fail(res, 502, "BAD_GATEWAY", "Faylni saqlab bo'lmadi: " + e.message);
  }

  const st = await localStorage.stat(objectKey);
  const size = st ? st.size : (saved.size || 0);
  ok(res, 200, { ok: true, objectKey, size, quality });
}

// -- Admin video confirm (upload storage'ga tushganini tekshirib, DB'ga bog'laydi)
// POST /api/admin/movies/:id/video/confirm
// body.storage: "r2" | "local" (ixtiyoriy; berilmasa presign'dagi mode/STORAGE_MODE).
async function handleAdminVideoConfirm(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { quality, size, storage: reqStorage } = body || {};
  const targetStorage = reqStorage === "r2" || reqStorage === "local" ? reqStorage : STORAGE_MODE;

  if (!storage.isValidQuality(quality)) {
    return fail(res, 422, "VALIDATION_ERROR", "Noma'lum quality. Ruxsat etilgan: " + storage.QUALITIES.join(", "));
  }
  if (targetStorage === "r2" && !r2.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "R2 sozlanmagan");
  }
  if (targetStorage === "local" && !localStorage.isConfigured()) {
    return fail(res, 503, "SERVICE_UNAVAILABLE", "Lokal video papka sozlanmagan");
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  const objectKey = storage.buildObjectKey(id, quality);
  // Upload haqiqatan belgilangan storage'ga tushganini tekshiramiz.
  let actualSize = size != null ? Number(size) : 0;
  if (targetStorage === "local") {
    const st = await localStorage.stat(objectKey);
    if (!st) {
      return fail(res, 400, "BAD_REQUEST", "Upload topilmadi. Fayl to'liq yuklanmagan bo'lishi mumkin.");
    }
    if (!(actualSize > 0)) actualSize = st.size;
  } else {
    let head;
    try {
      head = await r2.headObject(objectKey);
    } catch (e) {
      logger.warn("R2 HEAD failed", { movieId: id, quality, error: e.message });
      return fail(res, 502, "BAD_GATEWAY", "R2 bilan bog'lanib bo'lmadi");
    }
    if (!head.ok) {
      return fail(res, 400, "BAD_REQUEST", "Upload topilmadi. Fayl R2'ga to'liq yuklanmagan bo'lishi mumkin.");
    }
    if (!(actualSize > 0)) actualSize = head.size;
  }

  const updated = await repos.movies.attachVideo(id, quality, { objectKey, size: actualSize, storageType: targetStorage });
  await logAudit({ adminId: admin.userId, action: "ADMIN_ATTACHED_VIDEO", entityType: "movie", entityId: id, newValue: { quality, objectKey, size: actualSize, storageType: targetStorage } });
  ok(res, 200, { movie: updated, quality, size: actualSize, storageType: targetStorage });
}

// -- Admin video delete (storage object + DB ma'lumoti)
// DELETE /api/admin/movies/:id/video/:quality
async function handleAdminVideoDelete(req, res, id, quality) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  if (!storage.isValidQuality(quality)) {
    return fail(res, 422, "VALIDATION_ERROR", "Noma'lum quality. Ruxsat etilgan: " + storage.QUALITIES.join(", "));
  }

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");
  const src = movie.videoSources && typeof movie.videoSources === "object" && movie.videoSources[quality];
  if (!src || typeof src.objectKey !== "string") {
    return fail(res, 404, "NOT_FOUND", `Bu film uchun ${quality} video mavjud emas`);
  }

  // Storage objectni o'chirish (best-effort — o'chirilgan bo'lsa ham DB tozalanadi).
  // storageType aniq bo'lsa shu storage'da, aks holda ikkalasida ham uriniladi.
  if (src.storageType !== "r2" && src.storageType !== "local") {
    // Legacy/rejim aniqlanmagan: ikkala storage'da ham o'chirishga harakat.
    try {
      const result = await localStorage.remove(src.objectKey);
      if (!result.ok) logger.warn("Local video delete failed", { movieId: id, quality });
    } catch (e) {
      logger.warn("Local video delete error", { movieId: id, quality, error: e.message });
    }
    if (r2.isConfigured()) {
      try {
        const result = await r2.deleteObject(src.objectKey);
        if (!result.ok) logger.warn("R2 delete failed", { movieId: id, quality, status: result.status });
      } catch (e) {
        logger.warn("R2 delete error", { movieId: id, quality, error: e.message });
      }
    }
  } else if (src.storageType === "local") {
    try {
      const result = await localStorage.remove(src.objectKey);
      if (!result.ok) logger.warn("Local video delete failed", { movieId: id, quality });
    } catch (e) {
      logger.warn("Local video delete error", { movieId: id, quality, error: e.message });
    }
  } else if (r2.isConfigured()) {
    try {
      const result = await r2.deleteObject(src.objectKey);
      if (!result.ok) logger.warn("R2 delete failed", { movieId: id, quality, status: result.status });
    } catch (e) {
      logger.warn("R2 delete error", { movieId: id, quality, error: e.message });
    }
  }

  const updated = await repos.movies.detachVideo(id, quality);
  await logAudit({ adminId: admin.userId, action: "ADMIN_DELETED_VIDEO", entityType: "movie", entityId: id, oldValue: { quality, objectKey: src.objectKey } });
  ok(res, 200, { movie: updated });
}

// -- Admin: janrlar CRUD
async function handleAdminGenres(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  // Admin ro'yxati — hamma janrlar active holati bilan qaytadi.
  ok(res, 200, { genres: repos.genres.adminList() });
}

async function handleAdminAddGenre(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }
  const { name } = body;
  const err = validateGenreName(name);
  if (err) return fail(res, 422, "VALIDATION_ERROR", err);

  const result = await repos.genres.create(name);
  if (result.invalid) return fail(res, 422, "VALIDATION_ERROR", "Janr nomi yaroqsiz");
  if (result.conflict) return fail(res, 409, "CONFLICT", `"${name.trim()}" allaqachon mavjud`);

  await logAudit({ adminId: admin.userId, action: "ADMIN_CREATED_GENRE", entityType: "genre", entityId: result.genre, newValue: result.genre });
  ok(res, 201, { genres: repos.genres.adminList() });
}

async function handleAdminDeleteGenre(req, res, name) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const removed = await repos.genres.remove(name);
  if (!removed) return fail(res, 404, "NOT_FOUND", "Janr topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_DELETED_GENRE", entityType: "genre", entityId: name, oldValue: name });
  ok(res, 200, { genres: repos.genres.adminList() });
}

async function handleAdminDeactivateGenre(req, res, name) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const result = await repos.genres.deactivate(name);
  if (!result) return fail(res, 404, "NOT_FOUND", "Janr topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_DEACTIVATED_GENRE", entityType: "genre", entityId: name });
  ok(res, 200, { genre: result });
}

async function handleAdminActivateGenre(req, res, name) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const result = await repos.genres.activate(name);
  if (!result) return fail(res, 404, "NOT_FOUND", "Janr topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_ACTIVATED_GENRE", entityType: "genre", entityId: name });
  ok(res, 200, { genre: result });
}

// -- Admin: foydalanuvchilar
async function handleAdminUsers(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let users = repos.users.listUsers();
  // Filtr: status=ACTIVE|BLOCKED, q=username/firstName/lastName bo'yicha qidiruv.
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");
  if (status === "ACTIVE" || status === "BLOCKED") {
    users = users.filter((u) => (status === "BLOCKED" ? repos.users.isBlocked(u) : u.status === "ACTIVE"));
  }
  if (q) {
    const needle = q.toLowerCase();
    users = users.filter((u) =>
      [u.username, u.firstName, u.lastName, u.id].some((v) => v && String(v).toLowerCase().includes(needle))
    );
  }
  // Eng oxirgi faollik bo'yicha tartiblash (eng yangi birinchi).
  users.sort((a, b) => new Date(b.lastSeenAt || b.updatedAt || 0) - new Date(a.lastSeenAt || a.updatedAt || 0));
  ok(res, 200, { count: users.length, users });
}

// GET /api/admin/users/:id — user detali + statistika.
async function handleAdminUserDetail(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const user = repos.users.getUser(id);
  if (!user) return fail(res, 404, "NOT_FOUND", "Foydalanuvchi topilmadi");
  const stats = repos.users.getUserStats(id);
  const favorites = repos.favorites.list(id);
  const history = repos.history.list(id);
  ok(res, 200, { user, stats, favorites, history });
}

// POST /api/admin/users/:id/block
async function handleAdminBlockUser(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (ADMIN_ID && String(id) === String(ADMIN_ID)) {
    return fail(res, 400, "VALIDATION_ERROR", "Adminni bloklab bo'lmaydi");
  }
  const user = await repos.users.block(id);
  if (!user) return fail(res, 404, "NOT_FOUND", "Foydalanuvchi topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_BLOCKED_USER", entityType: "user", entityId: id, newValue: { status: user.status } });
  ok(res, 200, { user });
}

// POST /api/admin/users/:id/unblock
async function handleAdminUnblockUser(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const user = await repos.users.unblock(id);
  if (!user) return fail(res, 404, "NOT_FOUND", "Foydalanuvchi topilmadi");

  await logAudit({ adminId: admin.userId, action: "ADMIN_UNBLOCKED_USER", entityType: "user", entityId: id, newValue: { status: user.status } });
  ok(res, 200, { user });
}

// PUT /api/admin/users/:id — isAdmin va/yo status yangilash.
async function handleAdminUpdateUser(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  // Whitelist — faqat isAdmin/status yangilanishi mumkin (boshqa maydonlar rad etiladi).
  const unknown = Object.keys(body).filter((k) => k !== "isAdmin" && k !== "status");
  if (unknown.length) {
    return fail(res, 422, "VALIDATION_ERROR", `Ruxsat etilmagan maydon(lar): ${unknown.join(", ")}`);
  }

  const before = repos.users.getUser(id);
  if (!before) return fail(res, 404, "NOT_FOUND", "Foydalanuvchi topilmadi");

  if (typeof body.isAdmin === "boolean") {
    if (String(id) === String(ADMIN_ID) && !body.isAdmin) {
      return fail(res, 400, "VALIDATION_ERROR", "Asosiy adminni adminlikdan olish mumkin emas");
    }
    await repos.users.setAdmin(id, body.isAdmin);
  }
  if (body.status === "ACTIVE" || body.status === "BLOCKED") {
    if (body.status === "BLOCKED" && ADMIN_ID && String(id) === String(ADMIN_ID)) {
      return fail(res, 400, "VALIDATION_ERROR", "Adminni bloklab bo'lmaydi");
    }
    await (body.status === "BLOCKED" ? repos.users.block(id) : repos.users.unblock(id));
  }

  const updated = repos.users.getUser(id);
  await logAudit({ adminId: admin.userId, action: "ADMIN_UPDATED_USER", entityType: "user", entityId: id, oldValue: before, newValue: updated });
  ok(res, 200, { user: updated });
}

// -- Admin: statistika
async function handleAdminStats(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const daysParam = url.searchParams.get("days");
  let days = null;
  if (daysParam) {
    if (daysParam === "all") days = null;
    else {
      const n = parseInt(daysParam, 10);
      if (!isNaN(n) && n > 0) days = n;
    }
  }
  const stats = repos.analytics.getStats({ days });
  ok(res, 200, stats);
}

// -- Admin: audit log
async function handleAdminAuditLog(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const { listAudit } = require("./src/auditLog");
  ok(res, 200, { entries: listAudit() });
}

// -- Premium endpoints (protected) ----

// GET /api/premium/enabled — premium tizimi admin tomonidan yoqilganmi
// (frontend shunga qarab Premium tabini ko'rsatadi/yashiradi).
async function handlePremiumEnabled(req, res) {
  ok(res, 200, {
    enabled: repos.settings.getPremiumEnabled(),
    streamingPremiumOnly: repos.settings.getStreamingPremiumOnly(),
  });
}

// GET /api/premium/plans — premium paketlar ro'yxati
async function handlePremiumPlans(req, res) {
  ok(res, 200, { plans: repos.premium.getPremiumPlans() });
}

// GET /api/premium/status — foydalanuvchi premium holati
async function handlePremiumStatus(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  const status = repos.premium.getPremiumStatus(userId);
  ok(res, 200, { premium: status });
}

// POST /api/premium/purchase — to'lov yaratish
async function handlePremiumPurchase(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  if (!repos.settings.getPremiumEnabled()) {
    return fail(res, 503, "PREMIUM_DISABLED", "Premium tizimi hozircha o'chirilgan");
  }

  let body;
  try { body = await readBody(req, 5_000_000); } catch (e) {
    if (e.message === "__PAYLOAD_TOO_LARGE__") {
      return fail(res, 413, "PAYLOAD_TOO_LARGE", "Rasm juda katta (maks. ~3MB)");
    }
    return fail(res, 400, "BAD_REQUEST", e.message);
  }

  const { plan, checkImageData } = body;
  // Qattiq kodlangan ["1month","3months","1year"] ro'yxati emas — admin panel
  // orqali yaratilgan dinamik (plan_xxxx) paketlar ham shu yerda tekshiriladi,
  // aks holda ular umuman xarid qilib bo'lmas edi.
  const planExists = plan && repos.plans.getPlans().some((p) => p.id === plan);
  if (!planExists) {
    return fail(res, 422, "VALIDATION_ERROR", "Noto'g'ri yoki nofaol paket");
  }

  // Check rasmni tekshirish (base64 data URL)
  if (!checkImageData || typeof checkImageData !== "string") {
    return fail(res, 422, "VALIDATION_ERROR", "Chek rasmi majburiy");
  }

  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(checkImageData.trim());
  if (!m) {
    return fail(res, 422, "VALIDATION_ERROR", "Chek rasmi base64 data URL formatida bo'lishi kerak");
  }

  const payment = await repos.payments.createPayment(userId, plan, checkImageData);
  repos.analytics.bufferEvent("paymentCreated", { userId, paymentId: payment.id, plan, amount: payment.amount });

  ok(res, 201, { payment: { id: payment.id, plan: payment.plan, amount: payment.amount, status: payment.status, createdAt: payment.createdAt } });
}

// GET /api/premium/payment/:id — to'lov holati
async function handlePremiumPaymentStatus(req, res, paymentId) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  const payment = repos.payments.getPayment(paymentId);
  if (!payment) {
    return fail(res, 404, "NOT_FOUND", "To'lov topilmadi");
  }

  // Faqat o'z to'lovini ko'rish mumkin
  if (payment.userId !== userId) {
    return fail(res, 403, "FORBIDDEN", "Bu to'lovni ko'rishga ruxsat yo'q");
  }

  ok(res, 200, { payment });
}

// GET /api/premium/payment-settings — karta ma'lumotlari
async function handleGetPaymentSettings(req, res) {
  const settings = repos.premium.getPaymentSettings();
  ok(res, 200, { settings });
}

// GET /api/premium/my-payments — foydalanuvchining o'z to'lovlar tarixi
async function handleMyPayments(req, res) {
  const { userId, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  const payments = repos.payments.getUserPayments(userId).map((p) => ({
    ...p,
    checkImageData: undefined, // tarix ro'yxatida chek rasmi kerak emas
  }));
  ok(res, 200, { payments });
}

// -- "Biz bilan bog'lanish" ----

// POST /api/contact — foydalanuvchi xabar yuboradi, admin'ga Telegram orqali
// bildirishnoma yuboriladi (BOT_TOKEN mavjud bo'lsa).
async function handleContactSend(req, res) {
  const { userId, user, error } = resolveUserId(req);
  if (error) return unauthorized(res, error);

  if (repos.contact.isContactBlocked(userId)) {
    return fail(res, 403, "CONTACT_BLOCKED", "Administrator sizni aloqa formasidan bloklagan.");
  }

  let body;
  try { body = await readBody(req, 20_000); } catch (e) {
    return fail(res, 400, "BAD_REQUEST", e.message);
  }

  const text = String((body && body.text) || "").trim();
  if (!text) return fail(res, 422, "VALIDATION_ERROR", "Xabar matni bo'sh bo'lmasligi kerak");
  if (text.length > 2000) return fail(res, 422, "VALIDATION_ERROR", "Xabar 2000 belgidan oshmasligi kerak");

  const dbUser = repos.users.getUser(userId);
  const userName = (user && `${user.first_name || ""} ${user.last_name || ""}`.trim()) ||
    (dbUser && `${dbUser.firstName || ""} ${dbUser.lastName || ""}`.trim()) || "";
  const username = (user && user.username) || (dbUser && dbUser.username) || "";

  const message = await repos.contact.createMessage({ userId, userName, username, text });
  repos.analytics.bufferEvent("contactMessageSent", { userId });

  if (ADMIN_ID) {
    const who = username ? `@${username}` : (userName || `ID: ${userId}`);
    const notifyText =
      `📩 <b>Yangi xabar</b>\n\n` +
      `<b>Kimdan:</b> ${who} (ID: ${userId})\n\n` +
      `${text}`;
    sendTelegramMessage(ADMIN_ID, notifyText).catch(() => {});
  }

  ok(res, 201, { message: { id: message.id, createdAt: message.createdAt } });
}

// -- Admin: aloqa xabarlari ----

// GET /api/admin/contact-messages — xabarlar ro'yxati
async function handleAdminContactList(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const page = url.searchParams.get("page");
  const limit = url.searchParams.get("limit");
  const result = repos.contact.listMessages({ page, limit });

  const enriched = result.messages.map((m) => ({
    ...m,
    blocked: repos.contact.isContactBlocked(m.userId),
  }));

  ok(res, 200, {
    count: enriched.length,
    messages: enriched,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    unread: repos.contact.countUnread(),
  });
}

// POST /api/admin/contact-messages/:id/read — xabarni o'qilgan deb belgilash
async function handleAdminContactMarkRead(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const msg = await repos.contact.markRead(id);
  if (!msg) return fail(res, 404, "NOT_FOUND", "Xabar topilmadi");
  ok(res, 200, { message: msg });
}

// POST /api/admin/contact-users/:userId/block — foydalanuvchini FAQAT aloqa
// formasidan bloklaydi (botning umumiy ishlatilishiga ta'sir qilmaydi).
async function handleAdminContactBlockUser(req, res, userId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  await repos.contact.blockContactUser(userId);
  await logAudit({ adminId: admin.userId, action: "ADMIN_BLOCKED_CONTACT_USER", entityType: "contactUser", entityId: userId });
  ok(res, 200, { userId, blocked: true });
}

// POST /api/admin/contact-users/:userId/unblock
async function handleAdminContactUnblockUser(req, res, userId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  await repos.contact.unblockContactUser(userId);
  await logAudit({ adminId: admin.userId, action: "ADMIN_UNBLOCKED_CONTACT_USER", entityType: "contactUser", entityId: userId });
  ok(res, 200, { userId, blocked: false });
}

// -- Admin Premium/Payment endpoints ----

// GET /api/admin/payments — to'lovlar ro'yxati
async function handleAdminPayments(req, res, url) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const status = url.searchParams.get("status");
  const filter = status && ["pending", "approved", "rejected"].includes(status) ? { status } : {};

  const payments = repos.payments.listPayments(filter);

  // Foydalanuvchi ma'lumotlarini qo'shish
  const enrichedPayments = payments.map(p => {
    const user = repos.users.getUser(p.userId);
    return {
      ...p,
      checkImageData: undefined, // Ro'yxatda check rasmini yubormaymiz
      user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username } : null,
    };
  });

  ok(res, 200, { count: enrichedPayments.length, payments: enrichedPayments, stats: repos.payments.getPaymentStats() });
}

// GET /api/admin/payments/:id — to'lov detali (check rasmi bilan)
async function handleAdminPaymentDetail(req, res, paymentId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const payment = repos.payments.getPayment(paymentId);
  if (!payment) {
    return fail(res, 404, "NOT_FOUND", "To'lov topilmadi");
  }

  const user = repos.users.getUser(payment.userId);
  ok(res, 200, { payment, user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, username: user.username, premium: user.premium } : null });
}

// POST /api/admin/payments/:id/approve — to'lovni tasdiqlash
async function handleAdminApprovePayment(req, res, paymentId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const payment = await repos.payments.approvePayment(paymentId, admin.userId || "admin");
  if (!payment) {
    return fail(res, 404, "NOT_FOUND", "To'lov topilmadi yoki allaqachon ko'rib chiqilgan");
  }
  if (payment.error === "USER_NOT_FOUND") {
    return fail(res, 409, "USER_NOT_FOUND", "Foydalanuvchi topilmadi (hali ilovaga kirmagan) — Premium berib bo'lmadi");
  }

  await logAudit({ adminId: admin.userId, action: "ADMIN_APPROVED_PAYMENT", entityType: "payment", entityId: paymentId, newValue: { userId: payment.userId, plan: payment.plan, amount: payment.amount } });
  repos.analytics.bufferEvent("paymentApproved", { userId: payment.userId, paymentId, plan: payment.plan, amount: payment.amount });

  const user = repos.users.getUser(payment.userId);
  ok(res, 200, { payment, user: user ? { id: user.id, premium: user.premium } : null });
}

// POST /api/admin/payments/:id/reject — to'lovni rad etish
async function handleAdminRejectPayment(req, res, paymentId) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const payment = await repos.payments.rejectPayment(paymentId, admin.userId || "admin");
  if (!payment) {
    return fail(res, 404, "NOT_FOUND", "To'lov topilmadi yoki allaqachon ko'rib chiqilgan");
  }

  await logAudit({ adminId: admin.userId, action: "ADMIN_REJECTED_PAYMENT", entityType: "payment", entityId: paymentId, newValue: { userId: payment.userId, plan: payment.plan } });
  repos.analytics.bufferEvent("paymentRejected", { userId: payment.userId, paymentId, plan: payment.plan });

  ok(res, 200, { payment });
}

// GET /api/admin/payment-settings — admin karta sozlamalari
async function handleAdminGetPaymentSettings(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const settings = repos.premium.getPaymentSettings();
  ok(res, 200, { settings });
}

// PUT /api/admin/payment-settings — admin karta sozlamalarini saqlash
async function handleAdminSavePaymentSettings(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const { cardNumber, cardHolder } = body;

  if (!cardNumber || typeof cardNumber !== "string" || cardNumber.trim().length < 10) {
    return fail(res, 422, "VALIDATION_ERROR", "Karta raqami to'g'ri emas");
  }

  if (!cardHolder || typeof cardHolder !== "string" || cardHolder.trim().length < 2) {
    return fail(res, 422, "VALIDATION_ERROR", "Karta egasi ismi kerak");
  }

  const settings = await repos.premium.savePaymentSettings(cardNumber.trim(), cardHolder.trim());

  await logAudit({ adminId: admin.userId, action: "ADMIN_UPDATED_PAYMENT_SETTINGS", entityType: "settings", entityId: "paymentSettings" });

  ok(res, 200, { settings: { cardNumber: settings.cardNumber, cardHolder: settings.cardHolder, updatedAt: settings.updatedAt } });
}

// ===================== ADMIN PLANS (Paketlar) =====================

// GET /api/admin/plans — barcha paketlar (faol + nofaol)
async function handleAdminListPlans(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const plans = repos.plans.getAllPlans();
  ok(res, 200, { plans, stats: repos.plans.getPlanStats() });
}

// POST /api/admin/plans — yangi paket yaratish
async function handleAdminCreatePlan(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const { name, durationDays, price, movieIds, isActive } = body;
  if (!name || typeof name !== "string" || name.trim().length < 1) {
    return fail(res, 422, "VALIDATION_ERROR", "Paket nomi kerak");
  }
  if (!Number.isFinite(Number(durationDays)) || Number(durationDays) < 1) {
    return fail(res, 422, "VALIDATION_ERROR", "Davomiylik (kun) to'g'ri emas");
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0) {
    return fail(res, 422, "VALIDATION_ERROR", "Narx to'g'ri emas");
  }

  const plan = await repos.plans.createPlan({
    name: name.trim(),
    durationDays: Number(durationDays),
    price: Number(price),
    movieIds: Array.isArray(movieIds) ? movieIds : [],
    isActive: isActive !== false,
  });

  await logAudit({ adminId: admin.userId, action: "ADMIN_CREATED_PLAN", entityType: "plan", entityId: plan.id, newValue: plan });
  ok(res, 201, { plan });
}

// PUT /api/admin/plans/:id — paketni yangilash
async function handleAdminUpdatePlan(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const existing = repos.plans.getPlanById(id);
  if (!existing) {
    return fail(res, 404, "NOT_FOUND", "Paket topilmadi");
  }

  const patch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 1) {
      return fail(res, 422, "VALIDATION_ERROR", "Paket nomi to'g'ri emas");
    }
    patch.name = body.name.trim();
  }
  if (body.durationDays !== undefined) {
    if (!Number.isFinite(Number(body.durationDays)) || Number(body.durationDays) < 1) {
      return fail(res, 422, "VALIDATION_ERROR", "Davomiylik (kun) to'g'ri emas");
    }
    patch.durationDays = Number(body.durationDays);
  }
  if (body.price !== undefined) {
    if (!Number.isFinite(Number(body.price)) || Number(body.price) < 0) {
      return fail(res, 422, "VALIDATION_ERROR", "Narx to'g'ri emas");
    }
    patch.price = Number(body.price);
  }
  if (body.movieIds !== undefined) {
    patch.movieIds = Array.isArray(body.movieIds) ? body.movieIds : [];
  }
  if (body.isActive !== undefined) {
    patch.isActive = Boolean(body.isActive);
  }

  const updated = await repos.plans.updatePlan(id, patch);
  await logAudit({ adminId: admin.userId, action: "ADMIN_UPDED_PLAN", entityType: "plan", entityId: id, newValue: patch });
  ok(res, 200, { plan: updated });
}

// DELETE /api/admin/plans/:id — paketni o'chirish (soft delete)
async function handleAdminDeletePlan(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const existing = repos.plans.getPlanById(id);
  if (!existing) {
    return fail(res, 404, "NOT_FOUND", "Paket topilmadi");
  }

  await repos.plans.deletePlan(id);
  await logAudit({ adminId: admin.userId, action: "ADMIN_DELETED_PLAN", entityType: "plan", entityId: id });
  ok(res, 200, { ok: true });
}

// PUT /api/admin/plans/:id/movies — paketga kinolarni biriktirish
async function handleAdminAssignPlanMovies(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const existing = repos.plans.getPlanById(id);
  if (!existing) {
    return fail(res, 404, "NOT_FOUND", "Paket topilmadi");
  }

  const movieIds = Array.isArray(body.movieIds) ? body.movieIds : [];
  const plan = await repos.plans.assignMoviesToPlan(id, movieIds);

  await logAudit({ adminId: admin.userId, action: "ADMIN_ASSIGNED_PLAN_MOVIES", entityType: "plan", entityId: id, newValue: { movieCount: movieIds.length } });
  ok(res, 200, { plan });
}


// -- Admin: panel parolini o'zgartirish
// Joriy admin (telegram/dev/key) parolni almashtiradi. Saqlangan parol
// .env'dagi ADMIN_KEY o'rnini bosadi — keyingi kirishda u tekshiriladi.
// Parol faqat scrypt-hash sifatida saqlanadi (db.json'da ochiq emas).
async function handleAdminChangePassword(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAuth, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try { body = await readBody(req); } catch (e) { return fail(res, 400, "BAD_REQUEST", e.message); }

  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";

  // Joriy parolni tekshiramiz: saqlangan hash yoki .env ADMIN_KEY.
  const storedHash = repos.settings.getAdminPasswordHash();
  let currentValid = false;
  if (storedHash) {
    currentValid = verifyPassword(current, storedHash);
  } else if (ADMIN_KEY) {
    currentValid = typeof current === "string" && typeof ADMIN_KEY === "string" &&
      current.length === ADMIN_KEY.length && crypto.timingSafeEqual(
        Buffer.from(current), Buffer.from(ADMIN_KEY)
      );
  }
  if (!currentValid) return fail(res, 403, "FORBIDDEN", "Joriy parol noto'g'ri");

  if (next.length < 8 || next.length > 128) {
    return fail(res, 422, "VALIDATION_ERROR", "Yangi parol 8–128 belgidan iborat bo'lishi kerak");
  }

  const hash = hashPassword(next);
  await repos.settings.setAdminPasswordHash(hash);
  await logAudit({ adminId: admin.userId, action: "ADMIN_CHANGED_PASSWORD", entityType: "admin", entityId: "password" });
  ok(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Film posterlari
// ---------------------------------------------------------------------------

// Rasmni diskka saqlashda ruxsat etilgan maksimal hajm (dekodlangandan keyin).
const POSTER_MAX_DECODED = 2 * 1024 * 1024; // 2 MB

// -- Admin: film posteri yuklash (base64 data URL orqali)
// Body: { data: "data:image/png;base64,..." }. Rasm diskka yoziladi va
// filmning posterUrl'iga lokal route (`/api/movies/:id/poster`) o'rnatiladi.
async function handleAdminUploadPoster(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  if (!repos.movies.exists(id)) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  let body;
  try {
    body = await readBody(req, 4_000_000);
  } catch (e) {
    if (e.message === "__PAYLOAD_TOO_LARGE__") {
      return fail(res, 413, "PAYLOAD_TOO_LARGE", "Rasm juda katta (maks. ~2MB)");
    }
    return fail(res, 400, "BAD_REQUEST", e.message);
  }

  const data = typeof body.data === "string" ? body.data : "";
  const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(data.trim());
  if (!m) return fail(res, 422, "VALIDATION_ERROR", "poster base64 data URL bo'lishi kerak");

  let buffer;
  try {
    buffer = Buffer.from(m[2], "base64");
  } catch (e) {
    return fail(res, 422, "VALIDATION_ERROR", "base64 dekodlab bo'lmadi");
  }
  if (buffer.length === 0) return fail(res, 422, "VALIDATION_ERROR", "Rasm bo'sh");
  if (buffer.length > POSTER_MAX_DECODED) {
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "Rasm juda katta (maks. 2MB)");
  }

  // Haqiqiy rasm ekanligini magic bytes orqali tekshiramiz.
  const ext = posterStore.detectImageExt(buffer);
  if (!ext) return fail(res, 422, "VALIDATION_ERROR", "Fayl rasm emas (png/jpeg/webp/gif bo'lishi kerak)");

  const saved = await posterStore.savePoster(id, buffer, ext);
  const posterUrl = saved.url || `/api/movies/${encodeURIComponent(id)}/poster`;
  await repos.movies.update(id, { posterUrl });
  await logAudit({ adminId: admin.userId, action: "ADMIN_UPLOADED_POSTER", entityType: "movie", entityId: id, newValue: { ext, size: buffer.length } });
  ok(res, 200, { posterUrl, ext, size: buffer.length });
}

// -- Admin: posterni o'chirish
async function handleAdminDeletePoster(req, res, id) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  const movie = repos.movies.getById(id);
  if (!movie) return fail(res, 404, "NOT_FOUND", "Film topilmadi");

  const before = movie.posterUrl;
  await posterStore.removeByMovieId(id);
  // Lokal/ImageKit route'ga qaratilgan bo'lsa posterUrl'ni tozalaymiz (tashqi URL qoladi).
  if (
    movie.posterUrl &&
    ((movie.posterUrl.startsWith("/api/movies/") && movie.posterUrl.endsWith("/poster")) ||
      imagekitStore.isOurUrl(movie.posterUrl))
  ) {
    await repos.movies.update(id, { posterUrl: "" });
  }
  await logAudit({ adminId: admin.userId, action: "ADMIN_DELETED_POSTER", entityType: "movie", entityId: id, oldValue: { posterUrl: before } });
  ok(res, 200, { ok: true });
}

// GET /api/movies/:id/poster — film posterini uzatish (public, kesh bilan).
async function handleMoviePoster(req, res, id) {
  const found = await posterStore.findForMovie(id);
  if (!found) return fail(res, 404, "NOT_FOUND", "Poster topilmadi");
  if (found.buffer) {
    res.writeHead(200, {
      "Content-Type": posterStore.mimeFor(found.ext),
      "Content-Length": found.buffer.length,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end(found.buffer);
  }
  let stat;
  try {
    stat = fs.statSync(found.absPath);
  } catch (e) {
    return fail(res, 404, "NOT_FOUND", "Poster topilmadi");
  }
  res.writeHead(200, {
    "Content-Type": posterStore.mimeFor(found.ext),
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(found.absPath).pipe(res);
}

// ---------------------------------------------------------------------------
// Banner (bosh sahifa: reklama yoki tanlangan film)
// ---------------------------------------------------------------------------

// GET /api/banner — public. active bo'lmasa yoki film turi uchun film mavjud
// bo'lmasa null qaytadi (banner ko'rsatilmaydi).
function handleGetBanner(req, res) {
  const banner = repos.settings.getBanner();
  if (!banner || banner.active === false) return ok(res, 200, { banner: null });

  const out = { ...banner };
  if (out.type === "movie" && out.movieId) {
    const m = repos.movies.getById(out.movieId);
    if (!m || m.status !== "active") return ok(res, 200, { banner: null });
    out.movie = sanitizeMovie(m);
  }
  ok(res, 200, { banner: out });
}

// GET /api/banner/image — banner rasmini uzatish (public, kesh bilan).
async function handleBannerImage(req, res) {
  const found = await bannerStore.find();
  if (!found) return fail(res, 404, "NOT_FOUND", "Banner rasmi topilmadi");
  if (found.buffer) {
    res.writeHead(200, {
      "Content-Type": bannerStore.mimeFor(found.ext),
      "Content-Length": found.buffer.length,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end(found.buffer);
  }
  let stat;
  try {
    stat = fs.statSync(found.absPath);
  } catch (e) {
    return fail(res, 404, "NOT_FOUND", "Banner rasmi topilmadi");
  }
  res.writeHead(200, {
    "Content-Type": bannerStore.mimeFor(found.ext),
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(found.absPath).pipe(res);
}

// PUT /api/admin/banner — banner o'rnatish/yangilash (admin).
// Body: { type: "movie"|"ad", active?, movieId?, title?, text?, link?, image? (base64 data URL), removeImage? }
async function handleAdminSetBanner(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  let body;
  try {
    body = await readBody(req, 4_000_000);
  } catch (e) {
    if (e.message === "__PAYLOAD_TOO_LARGE__") {
      return fail(res, 413, "PAYLOAD_TOO_LARGE", "Rasm juda katta (maks. ~2MB)");
    }
    return fail(res, 400, "BAD_REQUEST", e.message);
  }

  const type = body.type === "ad" ? "ad" : "movie";
  const banner = { type, active: body.active !== false };

  if (type === "movie") {
    const movieId = String(body.movieId || "").trim();
    if (!movieId) return fail(res, 422, "VALIDATION_ERROR", "Film tanlanmagan (movieId kerak)");
    if (!repos.movies.exists(movieId)) return fail(res, 404, "NOT_FOUND", "Film topilmadi");
    banner.movieId = movieId;
  } else {
    banner.title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
    banner.text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
    banner.link = typeof body.link === "string" ? body.link.trim().slice(0, 1000) : "";
    if (!banner.title && !banner.link) {
      return fail(res, 422, "VALIDATION_ERROR", "Reklama sarlavhasi yoki linki kerak");
    }
  }

  // Rasm: yangi image berilsa saqlaymiz; removeImage bo'lsa o'chiramiz;
  // aks holda eskisi qoladi (agar mavjud bo'lsa).
  const currentBanner = repos.settings.getBanner();
  if (body.removeImage) {
    await bannerStore.remove();
    banner.imageUrl = "";
  } else if (typeof body.image === "string" && body.image.trim()) {
    const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(body.image.trim());
    if (!m) return fail(res, 422, "VALIDATION_ERROR", "banner image base64 data URL bo'lishi kerak");
    let buffer;
    try {
      buffer = Buffer.from(m[2], "base64");
    } catch (e) {
      return fail(res, 422, "VALIDATION_ERROR", "base64 dekodlab bo'lmadi");
    }
    if (buffer.length === 0) return fail(res, 422, "VALIDATION_ERROR", "Rasm bo'sh");
    if (buffer.length > POSTER_MAX_DECODED) {
      return fail(res, 413, "PAYLOAD_TOO_LARGE", "Rasm juda katta (maks. 2MB)");
    }
    const ext = bannerStore.detectImageExt(buffer);
    if (!ext) return fail(res, 422, "VALIDATION_ERROR", "Fayl rasm emas (png/jpeg/webp/gif bo'lishi kerak)");
    const saved = await bannerStore.save(buffer, ext);
    banner.imageUrl = saved.url || "/api/banner/image";
  } else if (currentBanner && currentBanner.imageUrl) {
    // Yangi rasm berilmadi va o'chirish so'ralmadi — eski imageUrl saqlab
    // qolinadi (u lokal route, ImageKit URL yoki qo'lda kiritilgan
    // tashqi URL bo'lishi mumkin — hammasi to'g'ri ishlaydi).
    banner.imageUrl = currentBanner.imageUrl;
  } else {
    const existing = await bannerStore.find();
    if (existing) banner.imageUrl = "/api/banner/image";
  }

  await repos.settings.setBanner(banner);
  await logAudit({
    adminId: admin.userId,
    action: "ADMIN_SET_BANNER",
    entityType: "banner",
    entityId: "banner",
    newValue: { type, movieId: banner.movieId || null, title: banner.title || null, hasImage: Boolean(banner.imageUrl) },
  });
  ok(res, 200, { banner });
}

// DELETE /api/admin/banner — banner o'chirish (sozlama + rasm).
async function handleAdminDeleteBanner(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const rl = applyRateLimit(req, res, limitAdmin, rateLimitKey(req));
  if (!rl.allowed) return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov");

  const before = repos.settings.getBanner();
  await bannerStore.remove();
  await repos.settings.setBanner(null);
  await logAudit({
    adminId: admin.userId,
    action: "ADMIN_DELETED_BANNER",
    entityType: "banner",
    entityId: "banner",
    oldValue: before,
  });
  ok(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Request ID — xatoliklarni kuzatish uchun (X-Request-ID header).
  res.setHeader("X-Request-ID", crypto.randomBytes(8).toString("hex"));

  // CORS
  if (applyCors(req, res)) return; // OPTIONS handled

  // Rate limit
  const rl = applyRateLimit(req, res, limitGeneral, rateLimitKey(req));
  if (!rl.allowed) {
    return fail(res, 429, "RATE_LIMITED", "Juda ko'p so'rov. Biroz kutib qayta urinib ko'ring.");
  }

  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // ---- Public endpoints ----

    // GET /api/health
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "health") {
      return ok(res, 200, { status: "ok", time: new Date().toISOString() });
    }

    // GET /api/ready — database va muhim konfiguratsiya tayyorligi
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "ready") {
      const checks = {
        database: db.load() ? true : false,
        botToken: Boolean(BOT_TOKEN),
        adminConfigured: Boolean(ADMIN_ID || ADMIN_KEY),
      };
      const ready = checks.database && checks.botToken && checks.adminConfigured;
      // mtprotoPool — IXTIYORIY xususiyat (bir nechta STREAM_BOT_TOKENS
      // orqali flood-control'ga qarshi). `ready`ga ta'sir qilmaydi — o'chiq
      // bo'lsa ham bot normal ishlayveradi, bu faqat monitoring uchun.
      //   enabled       — TELEGRAM_API_ID/HASH + kamida 1 token sozlanganmi
      //   poolSize      — nechta token sozlangan (asosiy BOT_TOKEN + STREAM_BOT_TOKENS)
      //   connected     — hozir nechtasi haqiqatan ulangan (0 bo'lishi normal —
      //                    sessiyalar faqat birinchi video so'ralganda ulanadi)
      const mtprotoPool = {
        enabled: mtproto.isEnabled(),
        poolSize: mtproto.poolSize(),
        connected: mtproto.connectedCount(),
        // sessions — har bir token bo'yicha alohida holat. requests soni
        // 0dan katta bo'lgan indekslar ko'p bo'lsa — round-robin haqiqatan
        // yukni bir nechta bot orasida taqsimlayapti degani.
        sessions: mtproto.getSessionStats(),
      };
      // Server MUVAFFAQIYATLI ishga tushgan bo'lsa (bu javobni qaytarayotgan
      // ulanmasa server umuman ishga tushmaydi, server.js buni to'xtatadi).
      const storage = "file";
      return ok(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", checks, storage, mtprotoPool });
    }

    // GET /api/banner — bosh sahifa banneri (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "banner" && !parts[2]) {
      return handleGetBanner(req, res);
    }

    // GET /api/banner/image — banner rasmi (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "banner" && parts[2] === "image") {
      return handleBannerImage(req, res);
    }

    // GET /api/movies
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && !parts[2]) {
      return handleMovies(req, res, url);
    }

    // GET /api/movies/code/:code — kod bilan film topish (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && parts[2] === "code" && parts[3] && !parts[4]) {
      return handleMovieByCode(req, res, parts[3]);
    }

    // GET /api/movies/:id/video/:quality/stream — lokal faylni stream qilish (tokenli)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && parts[2] && parts[3] === "video" && parts[4] && parts[5] === "stream") {
      const token = url.searchParams.get("token") || "";
      const uid = url.searchParams.get("uid") || "";
      if (!verifyStreamToken(parts[2], parts[4], uid, token)) {
        return unauthorized(res, "AUTH_REQUIRED");
      }
      return localStorage.stream(req, res, localStorage.buildObjectKey(parts[2], parts[4]));
    }

    // GET /api/movies/:id/video/:quality — signed URL (verified user)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && parts[2] && parts[3] === "video" && parts[4]) {
      return handleMovieVideoUrl(req, res, parts[2], parts[4]);
    }

    // POST /api/movies/:id/deliver — videoni storage kanaldan bot chatiga forward qilish
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "movies" && parts[2] && parts[3] === "deliver" && !parts[4]) {
      return handleDeliverMovie(req, res, parts[2]);
    }

    // GET /api/movies/:id/poster — film posterini uzatish (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && parts[2] && parts[3] === "poster" && !parts[4]) {
      return handleMoviePoster(req, res, parts[2]);
    }

    // GET /api/movies/:id
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "movies" && parts[2] && !parts[3]) {
      return handleMovieDetail(req, res, parts[2]);
    }

    // GET /api/genres
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "genres") {
      return handleGenres(req, res);
    }

    // GET /api/channels/required — majburiy obuna kanallari (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "channels" && parts[2] === "required") {
      return handleChannelsRequired(req, res);
    }

    // GET /api/channels/check — foydalanuvchi obuna holatini tekshirish (protected)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "channels" && parts[2] === "check") {
      return handleChannelsCheck(req, res);
    }

    // ---- Protected endpoints (require verified user) ----

    // GET /api/profile
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "profile") {
      return handleGetProfile(req, res);
    }

    // GET /api/favorites
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "favorites") {
      return handleGetFavorites(req, res);
    }

    // POST /api/favorites/toggle
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "favorites" && parts[2] === "toggle") {
      return handleToggleFavorite(req, res);
    }

    // GET /api/history/continue-watching
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "history" && parts[2] === "continue-watching") {
      return handleGetContinueWatching(req, res);
    }

    // GET /api/history
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "history" && !parts[2]) {
      return handleGetHistory(req, res);
    }

    // POST /api/history
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "history") {
      return handleRecordHistory(req, res);
    }

    // POST /api/auth/telegram
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "telegram") {
      return handleAuthTelegram(req, res);
    }

    // ---- Admin endpoints ----

    // GET /api/admin/stats
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "stats") {
      return handleAdminStats(req, res);
    }

    // GET /api/admin/audit-log
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "audit-log") {
      return handleAdminAuditLog(req, res);
    }

    // POST /api/admin/password — panel parolini o'zgartirish (admin)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "password") {
      return handleAdminChangePassword(req, res);
    }

    // PUT /api/admin/banner — banner o'rnatish (admin)
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "banner") {
      return handleAdminSetBanner(req, res);
    }

    // DELETE /api/admin/banner — banner o'chirish (admin)
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "banner") {
      return handleAdminDeleteBanner(req, res);
    }

    // GET /api/admin/movies
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && !parts[3]) {
      return handleAdminListMovies(req, res, url);
    }

    // POST /api/admin/movies
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && !parts[3]) {
      return handleAdminCreateMovie(req, res);
    }

    // PUT /api/admin/movies/:id
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && !parts[4]) {
      return handleAdminUpdateMovie(req, res, parts[3]);
    }

    // PUT /api/admin/movies/:id/video/upload/:quality — lokal mode: faylni diskka yozadi (admin)
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "video" && parts[5] === "upload" && parts[6]) {
      return handleAdminVideoUpload(req, res, parts[3], parts[6]);
    }

    // POST /api/admin/movies/:id/poster — film posteri yuklash (admin)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "poster") {
      return handleAdminUploadPoster(req, res, parts[3]);
    }

    // DELETE /api/admin/movies/:id/poster — posterni o'chirish (admin)
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "poster") {
      return handleAdminDeletePoster(req, res, parts[3]);
    }

    // POST /api/admin/movies/:id/video/presign — R2 presigned PUT URL (admin)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "video" && parts[5] === "presign") {
      return handleAdminVideoPresign(req, res, parts[3]);
    }

    // POST /api/admin/movies/:id/video/confirm — upload tugadi, DB'ga bog'lash (admin)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "video" && parts[5] === "confirm") {
      return handleAdminVideoConfirm(req, res, parts[3]);
    }

    // DELETE /api/admin/movies/:id/video/:quality (admin)
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && parts[4] === "video" && parts[5]) {
      return handleAdminVideoDelete(req, res, parts[3], parts[5]);
    }

    // DELETE /api/admin/movies/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "movies" && parts[3] && !parts[4]) {
      return handleAdminDeleteMovie(req, res, parts[3]);
    }

    // GET /api/admin/genres
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "genres") {
      return handleAdminGenres(req, res);
    }

    // POST /api/admin/genres
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "genres" && !parts[3]) {
      return handleAdminAddGenre(req, res);
    }

    // DELETE /api/admin/genres/:name
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "genres" && parts[3]) {
      return handleAdminDeleteGenre(req, res, decodeURIComponent(parts[3]));
    }

    // POST /api/admin/genres/:name/deactivate
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "genres" && parts[3] && parts[4] === "deactivate") {
      return handleAdminDeactivateGenre(req, res, decodeURIComponent(parts[3]));
    }

    // POST /api/admin/genres/:name/activate
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "genres" && parts[3] && parts[4] === "activate") {
      return handleAdminActivateGenre(req, res, decodeURIComponent(parts[3]));
    }

    // PUT /api/admin/premium-enabled — premium tizimini yoqish/o'chirish
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "premium-enabled") {
      return handleAdminSetPremiumEnabled(req, res);
    }

    // PUT /api/admin/streaming-premium-only — video-strimni Premium'ga cheklash
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "streaming-premium-only") {
      return handleAdminSetStreamingPremiumOnly(req, res);
    }

    // GET /api/admin/channels — majburiy obuna kanallari ro'yxati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "channels" && !parts[3]) {
      return handleAdminListChannels(req, res);
    }
    // POST /api/admin/channels — yangi kanal qo'shish
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "channels" && !parts[3]) {
      return handleAdminAddChannel(req, res);
    }
    // DELETE /api/admin/channels/:id
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "channels" && parts[3]) {
      return handleAdminDeleteChannel(req, res, decodeURIComponent(parts[3]));
    }

    // GET /api/admin/storage-videos — Telegram MTProto orqali avtomatik saqlangan videolar
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "storage-videos" && !parts[3]) {
      return handleAdminListStorageVideos(req, res);
    }
    // DELETE /api/admin/storage-videos/:id — faqat DB yozuvini o'chiradi (Telegram'dagi videoga tegmaydi)
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "storage-videos" && parts[3] && !parts[4]) {
      return handleAdminDeleteStorageVideo(req, res, decodeURIComponent(parts[3]));
    }
    // GET /api/admin/storage-videos/:id/stream-url — tokenli strim URL yaratadi
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "storage-videos" && parts[3] && parts[4] === "stream-url") {
      return handleAdminStorageVideoStreamUrl(req, res, decodeURIComponent(parts[3]));
    }
    // GET/HEAD /api/storage-videos/:id/stream — tokenli video strimi (Range qo'llab-quvvatlanadi)
    if ((req.method === "GET" || req.method === "HEAD") && parts[0] === "api" && parts[1] === "storage-videos" && parts[2] && parts[3] === "stream") {
      return handleStorageVideoStream(req, res, decodeURIComponent(parts[2]));
    }

    // GET /api/admin/users
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && !parts[3]) {
      return handleAdminUsers(req, res, url);
    }

    // GET /api/admin/users/:id — user detali
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[3] && !parts[4]) {
      return handleAdminUserDetail(req, res, parts[3]);
    }

    // PUT /api/admin/users/:id — isAdmin/status yangilash
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[3] && !parts[4]) {
      return handleAdminUpdateUser(req, res, parts[3]);
    }

    // POST /api/admin/users/:id/block
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[3] && parts[4] === "block") {
      return handleAdminBlockUser(req, res, parts[3]);
    }

    // POST /api/admin/users/:id/unblock
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts[3] && parts[4] === "unblock") {
      return handleAdminUnblockUser(req, res, parts[3]);
    }

    // ---- Premium endpoints (protected) ----

    // GET /api/premium/enabled — premium tizimi yoqilganmi (public)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "enabled") {
      return handlePremiumEnabled(req, res);
    }

    // GET /api/premium/plans — premium paketlar ro'yxati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "plans") {
      return handlePremiumPlans(req, res);
    }

    // GET /api/premium/status — foydalanuvchi premium holati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "status") {
      return handlePremiumStatus(req, res);
    }

    // POST /api/premium/purchase — to'lov yaratish
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "purchase") {
      return handlePremiumPurchase(req, res);
    }

    // GET /api/premium/payment/:id — to'lov holati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "payment" && parts[3]) {
      return handlePremiumPaymentStatus(req, res, parts[3]);
    }

    // GET /api/premium/payment-settings — karta ma'lumotlari
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "payment-settings") {
      return handleGetPaymentSettings(req, res);
    }

    // GET /api/premium/my-payments — foydalanuvchining o'z to'lovlar tarixi
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "premium" && parts[2] === "my-payments") {
      return handleMyPayments(req, res);
    }

    // ---- Admin Premium/Payment endpoints ----

    // GET /api/admin/payments — to'lovlar ro'yxati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payments" && !parts[3]) {
      return handleAdminPayments(req, res, url);
    }

    // GET /api/admin/payments/:id — to'lov detali (check rasmi bilan)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payments" && parts[3] && !parts[4]) {
      return handleAdminPaymentDetail(req, res, parts[3]);
    }

    // POST /api/admin/payments/:id/approve — to'lovni tasdiqlash
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payments" && parts[3] && parts[4] === "approve") {
      return handleAdminApprovePayment(req, res, parts[3]);
    }

    // POST /api/admin/payments/:id/reject — to'lovni rad etish
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payments" && parts[3] && parts[4] === "reject") {
      return handleAdminRejectPayment(req, res, parts[3]);
    }

    // GET /api/admin/payment-settings — admin karta sozlamalari
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payment-settings") {
      return handleAdminGetPaymentSettings(req, res);
    }

    // ---- "Biz bilan bog'lanish" ----

    // POST /api/contact — foydalanuvchi xabar yuboradi
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "contact" && !parts[2]) {
      return handleContactSend(req, res);
    }

    // GET /api/admin/contact-messages — xabarlar ro'yxati
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "contact-messages" && !parts[3]) {
      return handleAdminContactList(req, res, url);
    }

    // POST /api/admin/contact-messages/:id/read
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "contact-messages" && parts[3] && parts[4] === "read") {
      return handleAdminContactMarkRead(req, res, parts[3]);
    }

    // POST /api/admin/contact-users/:userId/block
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "contact-users" && parts[3] && parts[4] === "block") {
      return handleAdminContactBlockUser(req, res, parts[3]);
    }

    // POST /api/admin/contact-users/:userId/unblock
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "contact-users" && parts[3] && parts[4] === "unblock") {
      return handleAdminContactUnblockUser(req, res, parts[3]);
    }

    // PUT /api/admin/payment-settings — admin karta sozlamalarini saqlash
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "payment-settings") {
      return handleAdminSavePaymentSettings(req, res);
    }

    // ---- Admin Plans (Paketlar) ----
    // GET /api/admin/plans — barcha paketlar
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "plans" && !parts[3]) {
      return handleAdminListPlans(req, res);
    }
    // POST /api/admin/plans — yangi paket
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "plans" && !parts[3]) {
      return handleAdminCreatePlan(req, res);
    }
    // PUT /api/admin/plans/:id — paketni yangilash
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "plans" && parts[3] && !parts[4]) {
      return handleAdminUpdatePlan(req, res, parts[3]);
    }
    // DELETE /api/admin/plans/:id — paketni o'chirish
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "plans" && parts[3] && !parts[4]) {
      return handleAdminDeletePlan(req, res, parts[3]);
    }
    // PUT /api/admin/plans/:id/movies — paketga kinolarni biriktirish
    if (req.method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "plans" && parts[3] && parts[4] === "movies") {
      return handleAdminAssignPlanMovies(req, res, parts[3]);
    }

    // 404
    return fail(res, 404, "NOT_FOUND", "Endpoint topilmadi");
  } catch (err) {
    if (err.message === "__PAYLOAD_TOO_LARGE__") {
      return fail(res, 413, "PAYLOAD_TOO_LARGE", "So'rov juda katta (maks. 2MB)");
    }
    // Sensitiv stack trace userga ko'rsatilmaydi — faqat server logga yoziladi.
    const requestId = res.getHeader("X-Request-ID");
    logger.error("Server xatosi", { requestId, err });
    return fail(res, 500, "INTERNAL_ERROR", "Server ichki xatosi");
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown + analytics flush
// ---------------------------------------------------------------------------
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[${signal}] To'xtatilmoqda...`);

  const finish = () => {
    logger.info("Server to'xtadi. Xayr! 👋");
    process.exit(0);
  };

  // Analytics buffer'ni bo'shatib yozamiz, so'ng serverni yopamiz.
  repos.analytics
    .flush()
    .then(() => {
      server.close(() => finish());
      // Ochiq connection'lar 5 soniyada yopilmasa majburiy chiqamiz.
      setTimeout(() => finish(), 5000).unref();
    })
    .catch((e) => {
      logger.error("Analytics flush xatosi", { err: e });
      server.close(() => finish());
    });
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Analytics buffer'ni vaqt-vaqti bilan DB'ga yozamiz (playback sekinlashmasin).
let databaseReady = false;
const analyticsTimer = setInterval(() => {
  if (!databaseReady) return;
  repos.analytics.flush().catch((e) => logger.error("[analytics] flush xatosi", { err: e }));
}, ANALYTICS_FLUSH_MS);
analyticsTimer.unref();

// Premium muddati tugagan foydalanuvchilarni avtomatik Free holatiga
// qaytarish. getPremiumStatus() o'qishda ham "lazy" tekshiradi (shuning
// uchun bu timer ishlamay qolsa ham foydalanuvchi tajribasi buzilmaydi),
// lekin DB holatini vaqtida tozalash uchun har soatda ishga tushiriladi.
const PREMIUM_EXPIRY_CHECK_MS = 60 * 60 * 1000; // 1 soat
const premiumExpiryTimer = setInterval(() => {
  if (!databaseReady) return;
  repos.premium.expirePremiumUsers().catch((e) => logger.error("[premium] muddati tugaganlarni tozalash xatosi", { err: e }));
}, PREMIUM_EXPIRY_CHECK_MS);
premiumExpiryTimer.unref();
// Server ishga tushganda ham bir marta darhol tekshiramiz.


// Avtomatik backup (BACKUP_ENABLED=1 bo'lsa).


// ---------------------------------------------------------------------------
// Static file serving — frontend papkasidan fayllarni xizmat qiladi.
// Tunnel/production'da backend bir portda ham API, ham frontend ishlatiladi.
// ---------------------------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function serveStatic(req, res) {
  // FAQAT GET so'rovlari uchun; API endpointlarini tashlab ketamiz.
  if (req.method !== "GET") return false;

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // /api/* route'larini tashlab ketamiz — ularni router hal qiladi.
  if (pathname.startsWith("/api")) return false;

  // Fayl yo'lini aniqlash
  let filePath = path.join(FRONTEND_DIR, pathname === "/" ? "index.html" : pathname);

  // Directory traversal himoyasi
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(FRONTEND_DIR))) return false;

  // Fayl mavjudligini tekshirish
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    // SPA fallback: index.html ga qaytamiz (faqat .html extension bo'lmasa)
    if (!path.extname(pathname)) {
      filePath = path.join(FRONTEND_DIR, "index.html");
    } else {
      return false;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

// Router'dan oldin static file'ni sinab ko'ramiz.
// Asosiy router'da static xizmat qilinmagan bo'lsa, fallback index.html.
const originalHandler = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", async (req, res) => {
  // Avval API route'larni sinab ko'ramiz
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api")) {
    return originalHandler(req, res);
  }
  // Static file — topilmasa, SPA fallback (index.html)
  if (!serveStatic(req, res)) {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      try {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
      } catch (e) {
        res.writeHead(500);
        res.end("Server error");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }
});

// dastlabki ma'lumot to'liq yuklanguncha server so'rov qabul qilmaydi.
module.exports.ready = db.init()
  .then(() => {
    databaseReady = true;
    startAutoBackup();
    require("./src/telegramBackup").startScheduler();
    server.listen(PORT, () => {
      logger.info(`KinoBot API http://localhost:${PORT} portida ishga tushdi`);
      logger.info(`  Dev mode: ${DEV_MODE}`);
      logger.info(`  Admin ID: ${ADMIN_ID || "(o'rnatilmagan)"}`);
      logger.info(`  Admin Key: ${ADMIN_KEY ? "(o'rnatilgan)" : "(o'rnatilmagan)"}`);
      logger.info(`  Ma'lumotlar bazasi: fayl (data/db.json)`);
      logger.info(`  Health:   GET http://localhost:${PORT}/api/health`);
      logger.info(`  Ready:    GET http://localhost:${PORT}/api/ready`);
    });
  })
  .catch((err) => {
    logger.error(`Ma'lumotlar bazasini ishga tushirib bo'lmadi: ${err.message}`);
    process.exit(1);
  });
