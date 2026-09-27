// src/repositories/favoritesRepository.js
// Sevimlilar bo'yicha DB access logikasi.
// Duplikat favorite bo'lmasligi kafolatlanadi; toggle atomic.
//
// NOTE: JSON-DB single-instance bo'lgani uchun toggle read-modify-write
// ketma-ketligi event loop'da to'liq bajariladi (await'lar orasida boshqa
// toggle kirib keta olmaydi — barchasi yagona Node process'da).

const { load, persist } = require("../db");

function listIds(userId) {
  const db = load();
  const arr = db.favorites[String(userId)] || [];
  return Array.isArray(arr) ? arr : [];
}

function isFavorite(userId, movieId) {
  return listIds(userId).includes(movieId);
}

// Sevimlilar ro'yxati — film obyektlari bilan join qilingan.
function list(userId) {
  const ids = listIds(userId);
  const db = load();
  return db.movies.filter((m) => ids.includes(m.id));
}

// Favorite qo'shadi. Agar allaqachon mavjud bo'lsa no-op (duplikat yo'q).
// return { isFavorite: true }
async function add(userId, movieId) {
  const db = load();
  const uid = String(userId);
  if (!db.favorites[uid]) db.favorites[uid] = [];
  if (!db.favorites[uid].includes(movieId)) {
    db.favorites[uid].push(movieId);
    await persist();
  }
  return { isFavorite: true };
}

// Favorite olib tashlaydi. Mavjud bo'lmasa no-op.
// return { isFavorite: false }
async function remove(userId, movieId) {
  const db = load();
  const uid = String(userId);
  const arr = db.favorites[uid] || [];
  const idx = arr.indexOf(movieId);
  if (idx >= 0) {
    arr.splice(idx, 1);
    await persist();
  }
  return { isFavorite: false };
}

// Toggle — optimistic UI uchun { isFavorite, added } qaytaradi.
async function toggle(userId, movieId) {
  if (isFavorite(userId, movieId)) {
    await remove(userId, movieId);
    return { isFavorite: false, added: false };
  }
  await add(userId, movieId);
  return { isFavorite: true, added: true };
}

function count() {
  const db = load();
  return Object.values(db.favorites).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0
  );
}

module.exports = { listIds, isFavorite, list, add, remove, toggle, count };
