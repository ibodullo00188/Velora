// src/repositories/genresRepository.js
// Janrlar bo'yicha DB access logikasi.
//
// Janrlar oddiy stringlar ro'yxati (db.genres). Deaktivlashtirilgan janrlar
// alohida db.deactivatedGenres massivida saqlanadi — film'larning genres
// maydoni buzilmaydi, faqat jamoat ro'yxatida yashirinadi.

const { load, persist } = require("../db");

// Jamoat (public) ro'yxati — deaktivlashgan janrlar chiqarib tashlanadi.
function list() {
  const db = load();
  const deactivated = new Set(db.deactivatedGenres || []);
  return db.genres.filter((g) => !deactivated.has(g));
}

// Admin ro'yxati — hamma janrlar active holati bilan qaytadi.
function adminList() {
  const db = load();
  const deactivated = new Set(db.deactivatedGenres || []);
  return db.genres.map((g) => ({ name: g, active: !deactivated.has(g) }));
}

function exists(name) {
  return load().genres.includes(name);
}

// Yangi janr qo'shadi. Duplikat bo'lsa { conflict: true } qaytaradi.
async function create(name) {
  const db = load();
  const trimmed = String(name || "").trim();
  if (!trimmed) return { invalid: true };
  if (db.genres.includes(trimmed)) return { conflict: true };
  db.genres.push(trimmed);
  await persist();
  return { genre: trimmed };
}

// Janrni o'chiradi. Topilmasa null.
async function remove(name) {
  const db = load();
  const idx = db.genres.indexOf(name);
  if (idx < 0) return null;
  const [removed] = db.genres.splice(idx, 1);
  // Deaktivlar ro'yxatidan ham tozalash
  const di = db.deactivatedGenres.indexOf(name);
  if (di >= 0) db.deactivatedGenres.splice(di, 1);
  await persist();
  return removed;
}

// Janrni deaktiv qiladi (yashiradi). Topilmasa null.
async function deactivate(name) {
  const db = load();
  if (!db.genres.includes(name)) return null;
  if (!db.deactivatedGenres.includes(name)) {
    db.deactivatedGenres.push(name);
    await persist();
  }
  return { name, active: false };
}

// Janrni qayta faollashtiradi. Allaqachon faol bo'lsa { already: true }.
async function activate(name) {
  const db = load();
  if (!db.genres.includes(name)) return null;
  const idx = db.deactivatedGenres.indexOf(name);
  if (idx < 0) return { name, active: true, already: true };
  db.deactivatedGenres.splice(idx, 1);
  await persist();
  return { name, active: true };
}

module.exports = { list, adminList, exists, create, remove, deactivate, activate };
