// src/repositories/historyRepository.js
// Ko'rish tarixi bo'yicha DB access logikasi.
//
// Yozuv: { movieId, progressPct (0-100), positionSeconds, completed,
//         watchedAt, lastWatchedAt }
//
// Frontend progress'ni har bir sekundda yubormaydi — debounce'ni frontend
// qiladi, backend esa oxirgi holatni saqlaydi. Yangi yozuv avvalgisini
// to'liq almashtiradi (per-movie yagona yozuv) — duplikat bo'lmaydi.

const { load, persist } = require("../db");

function listRaw(userId) {
  const db = load();
  const arr = db.history[String(userId)] || [];
  return Array.isArray(arr) ? arr : [];
}

// Tarix ro'yxati — film obyektlari bilan join qilingan, oxirgi ko'rilgan birinchi.
function list(userId) {
  const entries = listRaw(userId)
    .slice()
    .sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt));
  const db = load();
  return entries
    .map((h) => ({ ...h, movie: db.movies.find((m) => m.id === h.movieId) }))
    .filter((h) => h.movie);
}

function get(userId, movieId) {
  return listRaw(userId).find((h) => h.movieId === movieId) || null;
}

// Progress'ni saqlaydi. Agar progress >= 95% bo'lsa completed deb belgilanadi.
// return entry
async function save(userId, movieId, { progressPct, positionSeconds } = {}) {
  const db = load();
  const uid = String(userId);
  if (!db.history[uid]) db.history[uid] = [];

  const pct = Math.max(0, Math.min(100, Number(progressPct) || 0));
  const pos = Math.max(0, Number(positionSeconds) || 0);
  const now = new Date().toISOString();

  let entry = db.history[uid].find((h) => h.movieId === movieId);
  if (!entry) {
    entry = { movieId, progressPct: 0, positionSeconds: 0, completed: false, watchedAt: now, lastWatchedAt: now };
    db.history[uid].push(entry);
  }
  entry.progressPct = pct;
  entry.positionSeconds = pos;
  entry.lastWatchedAt = now;
  if (pct >= 95) entry.completed = true;
  await persist();
  return entry;
}

// Film ko'rishni boshlash (position 0 bo'lgan yangi/eskirgan yozuv).
async function markStarted(userId, movieId) {
  const existing = get(userId, movieId);
  if (existing) return existing;
  return save(userId, movieId, { progressPct: 0, positionSeconds: 0 });
}

function count() {
  const db = load();
  return Object.values(db.history).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0
  );
}

// Continue Watching uchun — progress 1..94% bo'lgan, oxirgi ko'rilgan filmlar.
function getContinueWatching(userId, limit = 10) {
  return list(userId)
    .filter((h) => h.progressPct > 0 && h.progressPct < 95)
    .slice(0, limit);
}

module.exports = { listRaw, list, get, save, markStarted, count, getContinueWatching };
