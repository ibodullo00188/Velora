// src/repositories/usersRepository.js
// Foydalanuvchilar bo'yicha barcha DB access logikasi.
// server.js bu repository orqali ishlaydi — SQLite/PostgreSQL'ga o'tishda
// faqat shu fayl o'zgaradi.

const { load, persist } = require("../db");

// Telegram auth'dan kelgan ma'lumot bilan user'ni yaratadi/yangilaydi.
// lastSeenAt ham yangilanadi. BLOCKED user qayta yozilmaydi (status saqlanadi).
// return user
async function upsertFromTelegram(telegramId, tgData = {}) {
  const db = load();
  const id = String(telegramId);
  const now = new Date().toISOString();

  const existing = db.users[id];
  if (existing) {
    existing.telegramId = id;
    existing.username = tgData.username != null ? String(tgData.username) : existing.username;
    existing.firstName = tgData.first_name != null ? String(tgData.first_name) : existing.firstName;
    existing.lastName = tgData.last_name != null ? String(tgData.last_name) : existing.lastName;
    if (tgData.language_code) existing.language = String(tgData.language_code);
    if (tgData.photo_url) existing.photoUrl = String(tgData.photo_url);
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    await persist();
    return existing;
  }

  const user = {
    id,
    telegramId: id,
    username: tgData.username != null ? String(tgData.username) : "",
    firstName: tgData.first_name != null ? String(tgData.first_name) : "",
    lastName: tgData.last_name != null ? String(tgData.last_name) : "",
    photoUrl: tgData.photo_url != null ? String(tgData.photo_url) : "",
    language: tgData.language_code != null ? String(tgData.language_code) : "",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "ACTIVE",
    isAdmin: false,
    isBlocked: false,
  };
  db.users[id] = user;
  await persist();
  return user;
}

// User'ning lastSeenAt'ini yangilaydi (har bir himoyalangan requestda emas —
// chaqiruvchi o'zi qaror qiladi).
async function touchLastSeen(id) {
  const db = load();
  const u = db.users[id];
  if (!u) return null;
  u.lastSeenAt = new Date().toISOString();
  await persist();
  return u;
}

function getUser(id) {
  if (id == null) return null;
  const db = load();
  return db.users[String(id)] || null;
}

function isBlocked(user) {
  if (!user) return false;
  return user.status === "BLOCKED" || Boolean(user.isBlocked);
}

function listUsers() {
  const db = load();
  return Object.values(db.users);
}

function countUsers() {
  return Object.keys(load().users).length;
}

function countActiveUsers() {
  return Object.values(load().users).filter((u) => u.status === "ACTIVE").length;
}

function countBlockedUsers() {
  return Object.values(load().users).filter((u) => isBlocked(u)).length;
}

// Yangi qo'shilgan (masalan, so'nggi 7/30 kun) userlar soni.
function countNewUsers({ since }) {
  const sinceTs = new Date(since).getTime();
  return Object.values(load().users).filter((u) => new Date(u.createdAt).getTime() >= sinceTs).length;
}

// Admin user'ni block qiladi (ACTIVE → BLOCKED).
// return user | null
async function block(id) {
  const db = load();
  const u = db.users[String(id)];
  if (!u) return null;
  u.status = "BLOCKED";
  u.isBlocked = true;
  u.updatedAt = new Date().toISOString();
  await persist();
  return u;
}

// Admin user'ni blockdan chiqaradi (BLOCKED → ACTIVE).
async function unblock(id) {
  const db = load();
  const u = db.users[String(id)];
  if (!u) return null;
  u.status = "ACTIVE";
  u.isBlocked = false;
  u.updatedAt = new Date().toISOString();
  await persist();
  return u;
}

async function setAdmin(id, isAdmin) {
  const db = load();
  const u = db.users[String(id)];
  if (!u) return null;
  u.isAdmin = Boolean(isAdmin);
  u.updatedAt = new Date().toISOString();
  await persist();
  return u;
}

// User haqida asosiy statistika (admin panel uchun).
function getUserStats(id) {
  const db = load();
  const userId = String(id);
  const favs = db.favorites[userId] || [];
  const hist = db.history[userId] || [];
  const completedCount = hist.filter((h) => h.completed).length;
  const totalWatchSeconds = hist.reduce((sum, h) => sum + (Number(h.positionSeconds) || 0), 0);
  return {
    favoritesCount: favs.length,
    historyCount: hist.length,
    completedCount,
    totalWatchSeconds,
  };
}

module.exports = {
  upsertFromTelegram,
  touchLastSeen,
  getUser,
  isBlocked,
  listUsers,
  countUsers,
  countActiveUsers,
  countBlockedUsers,
  countNewUsers,
  block,
  unblock,
  setAdmin,
  getUserStats,
};
