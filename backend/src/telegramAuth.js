// src/telegramAuth.js
// Telegram Web App yuborgan `initData` satrini bot tokeni yordamida
// tasdiqlaydi. Bu firibgarlik/qalbakilashtirishning oldini oladi.
// Hujjat: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app

const crypto = require("crypto");

const MAX_AGE_SECONDS = 86400; // 24 soat

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {string} initData - Telegram.WebApp.initData qiymati (frontenddan keladi)
 * @param {string} botToken - BotFather bergan token (.env dagi BOT_TOKEN)
 * @returns {{ ok: boolean, user: object|null, reason?: string }}
 */
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return { ok: false, user: null, reason: "initData yoki botToken yo'q" };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, user: null, reason: "hash topilmadi" };
  // hash SHA-256 hex digesti bo'lishi shart (qat'iy 64 belgi) — boshqa shakllar
  // (masalan base64 yoki qisqa nonce) xavfsizlikdan tashqari yuk sifatida rad etiladi.
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return { ok: false, user: null, reason: "hash formati noto'g'ri" };
  }
  params.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeEqual(computedHash, hash)) {
    return { ok: false, user: null, reason: "Imzo mos kelmadi (soxta so'rov bo'lishi mumkin)" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Number.isNaN(authDate)) {
    return { ok: false, user: null, reason: "auth_date yo'q" };
  }
  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > MAX_AGE_SECONDS) {
    return { ok: false, user: null, reason: "initData eskirgan" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (e) {
    user = null;
  }
  if (!user || typeof user.id === "undefined") {
    return { ok: false, user: null, reason: "user ma'lumoti topilmadi" };
  }
  // Telegram ID'lari katta musbat butun sonlar — boshqa qiymatlar rad etiladi.
  if (!Number.isInteger(user.id) || user.id <= 0) {
    return { ok: false, user: null, reason: "user.id noto'g'ri formatda" };
  }

  return { ok: true, user };
}

module.exports = { verifyTelegramInitData };
