// src/channelCodes.js
// SODDA kanal-kod xaritasi (eski KOD:/NOM:/YIL: formatidagi channelImport.js'ga
// alternativ — u webapp katalogiga to'liq metadata bilan film qo'shadi,
// bu esa botning o'zida to'g'ridan-to'g'ri video yuborish uchun).
//
// Foydalanish:
//   Admin kanalga video yuboradi, caption/text: "#1" (yoki "#VIP2" va h.k.)
//   Bot shu postni (channelId + messageId) "1" kodiga bog'laydi.
//   Foydalanuvchi botga "1" deb yozsa, bot copyMessage orqali xuddi shu
//   postni foydalanuvchiga yuboradi — qayta yuklab/saqlab o'tirmaydi,
//   Telegram'ning o'zi orqali nusxa ko'chiradi (tez, hajmi cheklanmagan).

"use strict";

const { load, persist } = require("./db");

function normalizeCode(code) {
  return String(code || "").trim().replace(/^#/, "").toUpperCase();
}

function ensureMap(db) {
  if (!db.settings || typeof db.settings !== "object" || Array.isArray(db.settings)) {
    db.settings = {};
  }
  if (!db.settings.channelCodes || typeof db.settings.channelCodes !== "object") {
    db.settings.channelCodes = {};
  }
  return db.settings.channelCodes;
}

// Kod -> { channelId, messageId, caption, savedAt } saqlaydi (mavjud bo'lsa ustidan yozadi).
async function saveCode(code, { channelId, messageId, caption }) {
  const norm = normalizeCode(code);
  if (!norm) throw new Error("Kod bo'sh bo'lishi mumkin emas");
  const db = load();
  const map = ensureMap(db);
  map[norm] = {
    channelId: String(channelId),
    messageId: Number(messageId),
    caption: caption ? String(caption).slice(0, 200) : "",
    savedAt: new Date().toISOString(),
  };
  await persist();
  return map[norm];
}

function getCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const db = load();
  const map = ensureMap(db);
  return map[norm] || null;
}

function listCodes() {
  const db = load();
  const map = ensureMap(db);
  return Object.entries(map)
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

async function deleteCode(code) {
  const norm = normalizeCode(code);
  const db = load();
  const map = ensureMap(db);
  if (!map[norm]) return false;
  delete map[norm];
  await persist();
  return true;
}

module.exports = { normalizeCode, saveCode, getCode, listCodes, deleteCode };
