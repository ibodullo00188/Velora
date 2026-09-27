// src/repositories/analyticsRepository.js
// Analytics layer.
//
// Eventlar xotirada bufferlanadi va vaqt-vaqti bilan DB'ga yoziladi
// (server.js interval orqali flush() chaqiradi). Bu playback/katalog
// ishlashini sekinlashtirmaydi — bufferEvent sinxron va O(1).
//
// DB strukturasi (db.analytics):
//   { days: { "YYYY-MM-DD": { [eventType]: count } },
//     moviePlays: { [movieId]: { count, lastPlayedAt } } }
//
// Event turlari: userRegistered, userOpenedApp, movieOpened,
//   playbackStarted, playbackCompleted, playbackFailed,
//   favoriteAdded, favoriteRemoved, historyUpdated

const { load, persist } = require("../db");
const usersRepo = require("./usersRepository");
const paymentsRepo = require("./paymentsRepository");
const contactRepo = require("./contactRepository");

const EVENT_TYPES = new Set([
  "userRegistered", "userOpenedApp", "movieOpened",
  "playbackStarted", "playbackCompleted", "playbackFailed",
  "favoriteAdded", "favoriteRemoved", "historyUpdated",
  // Bular allaqachon kod ichida bufferEvent() bilan yuborilardi, lekin shu
  // ro'yxatda yo'qligi sababli jimgina tashlab yuborilardi (statistikaga
  // umuman yozilmasdi): video Telegram orqali yuborilishi, to'lov
  // hodisalari, kontakt xabari.
  "videoDelivered", "paymentCreated", "paymentApproved", "paymentRejected",
  "contactMessageSent",
]);

// In-memory buffer (flush'gacha)
let buffer = [];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

// Sinxron, bloklamaydi.
function bufferEvent(type, { userId, movieId } = {}) {
  if (!EVENT_TYPES.has(type)) return false;
  buffer.push({ type, userId: userId != null ? String(userId) : null, movieId: movieId || null });
  return true;
}

function bufferSize() {
  return buffer.length;
}

// Buffer'ni DB'ga birlashtiradi va persist qiladi.
async function flush() {
  if (buffer.length === 0) return 0;
  const events = buffer;
  buffer = [];

  const db = load();
  const now = todayKey();
  if (!db.analytics.days[now]) db.analytics.days[now] = {};

  for (const ev of events) {
    const day = db.analytics.days[now];
    day[ev.type] = (day[ev.type] || 0) + 1;
    // "Eng ko'p ko'rilgan filmlar" — avval faqat eski pleyer strimi
    // ("playbackStarted") hisobga olinardi. Yangi tizimda video Telegram
    // orqali forward qilinadi ("videoDelivered"), shuning uchun aynan shu
    // hodisa ham xuddi shunday hisoblanishi kerak — aks holda statistika
    // yangi tizimda hech qachon yangilanmay qoladi.
    if ((ev.type === "playbackStarted" || ev.type === "videoDelivered") && ev.movieId) {
      if (!db.analytics.moviePlays[ev.movieId]) db.analytics.moviePlays[ev.movieId] = { count: 0, lastPlayedAt: null };
      db.analytics.moviePlays[ev.movieId].count += 1;
      db.analytics.moviePlays[ev.movieId].lastPlayedAt = new Date().toISOString();
    }
  }
  await persist();
  return events.length;
}

function resetBuffer() {
  buffer = [];
}

// N kun ichidagi total event count (eventType bo'yicha).
function countEvents(eventType, days) {
  const db = load();
  const daysToInclude = days == null ? null : Math.max(1, days);
  let total = 0;
  for (const [d, counts] of Object.entries(db.analytics.days)) {
    if (daysToInclude != null) {
      const age = dayDiffDays(d);
      if (age > daysToInclude) continue;
    }
    total += counts[eventType] || 0;
  }
  return total;
}

function dayDiffDays(dStr) {
  const d = new Date(dStr + "T00:00:00Z");
  const now = new Date();
  return Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - d.getTime()) / 86400000);
}

// Oxirgi N kunlik daily activity (kunlik total eventlar).
function dailyActivity(days = 7) {
  const db = load();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKey(i);
    const counts = db.analytics.days[key] || {};
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    out.push({ date: key, events: total, ...counts });
  }
  return out;
}

// Eng ko'p ko'rilgan filmlar (playbackStarted bo'yicha).
function mostWatched(limit = 5) {
  const db = load();
  return Object.entries(db.analytics.moviePlays)
    .map(([movieId, v]) => ({ movieId, count: v.count, lastPlayedAt: v.lastPlayedAt }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Umumiy statistika — admin panel uchun.
// days: null=all-time, 1=today, 7, 30...
function getStats({ days } = {}) {
  const db = load();
  const isAllTime = days == null;
  const d = days == null ? 0 : Math.max(1, days);

  const sum = (type) => countEvents(type, isAllTime ? null : d);
  const daysCovered = isAllTime ? null : d;

  return {
    period: isAllTime ? "all" : `${d}d`,
    totalMovies: db.movies.length,
    totalGenres: db.genres.length,
    totalUsers: usersRepo.countUsers(),
    activeUsers: usersRepo.countActiveUsers(),
    blockedUsers: usersRepo.countBlockedUsers(),
    newUsers: isAllTime ? usersRepo.countUsers() : usersRepo.countNewUsers({ since: dateKey(d) }),
    totalFavorites: Object.values(db.favorites).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0),
    totalHistory: Object.values(db.history).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0),
    // Admin panel tab badge'lari uchun (Premium / Xabarlar).
    pendingPayments: paymentsRepo.listPayments({ status: "pending" }).length,
    unreadMessages: contactRepo.countUnread(),
    events: {
      userRegistered: sum("userRegistered"),
      userOpenedApp: sum("userOpenedApp"),
      movieOpened: sum("movieOpened"),
      playbackStarted: sum("playbackStarted"),
      playbackCompleted: sum("playbackCompleted"),
      playbackFailed: sum("playbackFailed"),
      favoriteAdded: sum("favoriteAdded"),
      favoriteRemoved: sum("favoriteRemoved"),
      historyUpdated: sum("historyUpdated"),
    },
    mostWatched: mostWatched(5),
    dailyActivity: isAllTime ? dailyActivity(7) : dailyActivity(daysCovered),
  };
}

module.exports = { bufferEvent, flush, resetBuffer, getStats, countEvents, bufferSize, EVENT_TYPES };
