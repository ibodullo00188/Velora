// src/storageVideos.js
// Storage kanalga avtomatik nusxalangan videolar ro'yxati.
// channelCodes.js'dagi kabi bitta "kod"ga emas — bu yerda HAR BIR video
// (kod bilan ham, kodsiz ham) ro'yxatga tushadi, keyinchalik admin panelda
// "Kanal videolari" ro'yxatini ko'rsatish va veb-pleyerda strim qilish
// uchun ishlatiladi (channelId + messageId orqali).
//
// Saqlash joyi channelCodes.js bilan bir xil naqsh: db.settings ichida,
// alohida db.json schema/migratsiyasiga tegmasdan.

"use strict";

const crypto = require("crypto");
const { load, persist } = require("./db");

function ensureList(db) {
  if (!db.settings || typeof db.settings !== "object" || Array.isArray(db.settings)) {
    db.settings = {};
  }
  if (!Array.isArray(db.settings.storageVideos)) {
    db.settings.storageVideos = [];
  }
  return db.settings.storageVideos;
}

// Manba kanal+xabar bo'yicha allaqachon saqlanganini tekshiradi (qayta
// nusxalashning oldini olish uchun — masalan bot qayta ishga tushganda
// eski update'lar takror kelib qolsa).
function findBySource(sourceChannelId, sourceMessageId) {
  const db = load();
  const list = ensureList(db);
  return (
    list.find(
      (v) =>
        String(v.sourceChannelId) === String(sourceChannelId) &&
        Number(v.sourceMessageId) === Number(sourceMessageId)
    ) || null
  );
}

// Yangi yozuv qo'shadi.
async function addEntry({
  sourceChannelId,
  sourceMessageId,
  storageChannelId,
  storageMessageId,
  code,
  caption,
  fileName,
  fileSize,
  mimeType,
  mediaType,
  durationSeconds,
}) {
  const existing = findBySource(sourceChannelId, sourceMessageId);
  if (existing) return existing;

  const db = load();
  const list = ensureList(db);
  const entry = {
    id: "sv_" + crypto.randomBytes(6).toString("hex"),
    sourceChannelId: String(sourceChannelId),
    sourceMessageId: Number(sourceMessageId),
    storageChannelId: String(storageChannelId),
    storageMessageId: Number(storageMessageId),
    code: code ? String(code).toUpperCase() : "",
    caption: caption ? String(caption).slice(0, 300) : "",
    fileName: fileName ? String(fileName).slice(0, 300) : "",
    fileSize: Number(fileSize) || 0,
    mimeType: mimeType ? String(mimeType).slice(0, 100) : "",
    mediaType: mediaType ? String(mediaType).slice(0, 20) : "video",
    durationSeconds: Number(durationSeconds) || 0,
    movieId: "", // autoMovie.js orqali yaratilgan filmga bog'lanadi (linkMovie)
    savedAt: new Date().toISOString(),
  };
  list.push(entry);
  await persist();
  return entry;
}

// Avtomatik yaratilgan "film" yozuvi bilan bog'lash (autoMovie.js chaqiradi).
async function linkMovie(id, movieId) {
  const db = load();
  const list = ensureList(db);
  const entry = list.find((v) => v.id === id);
  if (!entry) return null;
  entry.movieId = String(movieId);
  await persist();
  return entry;
}

// Ro'yxat — admin panelda "Kanal videolari" uchun (eng yangisi birinchi).
function listEntries({ limit } = {}) {
  const db = load();
  const list = ensureList(db)
    .slice()
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return typeof limit === "number" ? list.slice(0, limit) : list;
}

function getById(id) {
  const db = load();
  return ensureList(db).find((v) => v.id === id) || null;
}

async function removeById(id) {
  const db = load();
  const list = ensureList(db);
  const idx = list.findIndex((v) => v.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  await persist();
  return true;
}

module.exports = { findBySource, addEntry, linkMovie, listEntries, getById, removeById };
