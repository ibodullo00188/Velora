// src/autoMovie.js
// channelAutoSave.js orqali storage kanalga video saqlanganda, uni darhol
// (poster/janrsiz, minimal) "film" sifatida katalogga qo'shadi — shunda
// u ODDIY FOYDALANUVCHILARGA HAM darhol ko'rinadi (status: "active"),
// TelePlay'dagi "botga video yuborilsa darhol paydo bo'ladi" tajribasiga
// yaqinlashtirish uchun.
//
// Admin keyinchalik mavjud "Film tahrirlash" formasida shu yozuvga
// poster/janr/tavsif qo'shishi mumkin — bu avtomatik yozuvni buzmaydi,
// faqat to'ldiradi.

"use strict";

const repos = require("./repositories");

// "#KOD Film nomi" yoki oddiy caption'dan sarlavha ajratib oladi;
// bo'lmasa fayl nomidan, u ham bo'lmasa umumiy sarlavha ishlatiladi.
function buildTitle({ caption, fileName }) {
  let title = String(caption || "")
    .replace(/^#\s*[A-Za-z0-9_-]{1,20}\s*/, "")
    .trim();
  if (!title && fileName) {
    title = String(fileName).replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  }
  if (!title) {
    title = "Nomsiz video " + new Date().toLocaleDateString("uz-UZ");
  }
  return title.slice(0, 150);
}

function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}s ${m}daq` : `${m} daq`;
}

// entry — storageVideos.js yozuvi ({ id, caption, fileName, durationSeconds, ... })
// Har doim "480p" quality kaliti ostida bitta manba yaratiladi (Telegram
// fayli qayta kodlanmagan — bitta original sifat).
async function createMovieFromStorageVideo(entry) {
  const title = buildTitle(entry);

  const result = await repos.movies.create({
    title,
    year: new Date().getFullYear(),
    genres: [],
    rating: 0,
    duration: formatDuration(entry.durationSeconds),
    description: entry.caption || "",
    status: "active", // hammaga darhol ko'rinadi
    videoSources: {
      "480p": {
        objectKey: `telegram:${entry.id}`,
        storageType: "telegram",
        storageVideoId: entry.id,
      },
    },
  });

  return result && result.movie ? result.movie : null;
}

module.exports = { createMovieFromStorageVideo };
