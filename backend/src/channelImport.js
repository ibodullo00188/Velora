// src/channelImport.js
// Kanal video import funksiyalari.
// Admin kanalda maxsus formatda xabar yuboradi:
//   KOD: <code>
//   NOM: <title>
//   YIL: <year>
//   JANR: <genre1>, <genre2>, ...
//   VA video fayl (document/video)
// Bot avtomatik ravishda videoni yuklab, film yaratadi va kod bilan bog'laydi.

"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const repos = require("./repositories");
const { logAudit } = require("./auditLog");
const { logger } = require("./logger");
const localStorage = require("./localStorage");
const r2 = require("./r2");

// Rasm/Video saqlash uchun serverni tanlash (R2 sozlangan bo'lsa R2, aks holda lokal)
const storage = r2.isConfigured() ? r2 : localStorage;

// ---------------------------------------------------------------------------
// Kanal xabar formatini parse qilish
// ---------------------------------------------------------------------------

// Kutilayotgan format:
// KOD: <code>
// NOM: <title>
// YIL: <year>
// JANR: <genre1>, <genre2>, ...
//
// Barcha maydonlar majburiy emas, lekin KOD va NOM majburiy.
// Video fayl (document/video) xabarda bo'lishi shart.
function parseChannelCaption(caption) {
  if (!caption || typeof caption !== "string") return null;

  const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  const data = {
    code: "",
    title: "",
    year: null,
    genres: [],
    originalTitle: "",
    duration: "",
    description: "",
    rating: 0,
  };

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toUpperCase();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case "KOD":
      case "CODE":
        data.code = value;
        break;
      case "NOM":
      case "TITLE":
        data.title = value;
        break;
      case "ORIGINAL NOM":
      case "ORIGINAL TITLE":
      case "ORIGINAL":
        data.originalTitle = value;
        break;
      case "YIL":
      case "YEAR":
        const y = parseInt(value, 10);
        if (!isNaN(y) && y > 1800 && y < 2100) data.year = y;
        break;
      case "JANR":
      case "GENRE":
      case "JANRLAR":
      case "GENRES":
        data.genres = value.split(",").map((g) => g.trim()).filter(Boolean);
        break;
      case "DAVOMIYLIQ":
      case "DURATION":
        data.duration = value;
        break;
      case "TAVSIF":
      case "DESCRIPTION":
        data.description = value;
        break;
      case "REYTING":
      case "RATING":
        const r = parseFloat(value);
        if (!isNaN(r)) data.rating = Math.max(0, Math.min(10, r));
        break;
    }
  }

  // Majburiy maydonlar tekshiruvi
  if (!data.code || !data.title) {
    return { error: "KOD va NOM maydonlari majburiy" };
  }

  // Kod formatini tozalash (faqat alfanumerik, tire, pastki chiziq)
  data.code = data.code.replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase();
  if (!data.code) {
    return { error: "KOD noto'g'ri formatda" };
  }

  // Janrlarni validatsiya qilish (mavjud janrlar ro'yxatiga moslashtirish)
  const validGenres = repos.genres.list();
  data.genres = data.genres
    .map((g) => {
      const match = validGenres.find((vg) => vg.toLowerCase() === g.toLowerCase());
      return match || g; // Agar topilmasa ham saqlaymiz (yangi janr bo'lishi mumkin)
    })
    .filter(Boolean);

  return data;
}

// ---------------------------------------------------------------------------
// Telegram faylni yuklab olish
// ---------------------------------------------------------------------------

// Telegram Bot API orqali file_path olish
async function getTelegramFilePath(fileId, botToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file_id: fileId });
    const req = https.request(
      `https://api.telegram.org/bot${botToken}/getFile`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok && parsed.result && parsed.result.file_path) {
              resolve(parsed.result.file_path);
            } else {
              reject(new Error(parsed.description || "file_path topilmadi"));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Telegram serveridan faylni yuklab, buffer sifatida qaytarish
// Agar fayl hajmi juda katta bo'lsa (50MB+), stream orqali saqlash kerak.
// Hozircha oddiy buffer usuli (kichik fayllar uchun).
async function downloadTelegramFile(filePath, botToken, maxSize = 50 * 1024 * 1024) {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Telegram file download failed: HTTP ${res.statusCode}`));
        return;
      }

      const contentLength = parseInt(res.headers["content-length"] || "0", 10);
      if (contentLength > maxSize) {
        reject(new Error(`Fayl hajmi chegaradan o'tdi: ${contentLength} bytes`));
        return;
      }

      const chunks = [];
      let totalSize = 0;

      res.on("data", (chunk) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          res.destroy();
          reject(new Error(`Fayl hajmi chegaradan o'tdi (stream): ${totalSize} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve(Buffer.concat(chunks, totalSize));
      });
    }).on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Video faylni storage'ga saqlash
// ---------------------------------------------------------------------------

// Video faylni storage'ga (R2 yoki lokal) yuklaydi
// return { objectKey, size, storageType }
async function saveVideoToStorage(movieId, quality, videoBuffer, contentType = "video/mp4") {
  const objectKey = storage.buildObjectKey(movieId, quality);

  if (storage === r2) {
    // R2 uchun presigned PUT URL olamiz va fetch bilan yuklaymiz
    const putUrl = r2.presignedPutUrl(objectKey, contentType, { expiresInSeconds: 900 });
    const res = await fetch(putUrl, {
      method: "PUT",
      body: videoBuffer,
      headers: { "Content-Type": contentType },
    });
    if (!res.ok) {
      throw new Error(`R2 upload failed: HTTP ${res.status}`);
    }
    return { objectKey, size: videoBuffer.length, storageType: "r2" };
  } else {
    // Lokal storage uchun temp fayl orqali saqlaymiz
    const p = localStorage.resolvePath(objectKey);
    if (!p) throw new Error("Noto'g'ri objectKey");
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, videoBuffer);
    fs.renameSync(tmp, p);
    return { objectKey, size: videoBuffer.length, storageType: "local" };
  }
}

// ---------------------------------------------------------------------------
// Asosiy import funksiyasi
// ---------------------------------------------------------------------------

/**
 * Kanal xabaridan film yaratish va video import qilish
 * @param {object} opts
 * @param {string} opts.botToken - Bot token
 * @param {object} opts.message - Telegram message object (channel post)
 * @param {string} [opts.adminId] - Admin ID (audit log uchun)
 * @returns {Promise<{movie, code, videoQuality, storageType}>}
 */
async function importFromChannelMessage({ botToken, message, adminId }) {
  // 1. Caption parse qilish
  const caption = message.caption || message.text || "";
  const parsed = parseChannelCaption(caption);
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const { code, title, originalTitle, year, genres, duration, description, rating } = parsed;

  // 2. Kod bilan film allaqachon mavjudligini tekshirish
  const existingByCode = repos.movies.getById(code);
  if (existingByCode) {
    throw new Error(`"${code}" kodi bilan film allaqachon mavjud`);
  }

  // 3. Video faylni aniqlash (document yoki video)
  let fileId = null;
  let fileName = "";
  let mimeType = "video/mp4";

  if (message.video) {
    fileId = message.video.file_id;
    fileName = message.video.file_name || `${code}.mp4`;
    mimeType = message.video.mime_type || "video/mp4";
  } else if (message.document && message.document.mime_type?.startsWith("video/")) {
    fileId = message.document.file_id;
    fileName = message.document.file_name || `${code}.mp4`;
    mimeType = message.document.mime_type;
  } else {
    throw new Error("Xabarda video fayl topilmadi (video yoki document/video kerak)");
  }

  // 4. Telegram dan file_path olish
  const filePath = await getTelegramFilePath(fileId, botToken);

  // 5. Faylni yuklab olish (buffer)
  // Diqqat: katta fayllar uchun bu xotirani to'ldirishi mumkin.
  // Production'da stream orqali yuklash kerak (R2 multipart upload yoki lokal stream).
  const videoBuffer = await downloadTelegramFile(filePath, botToken);

  // 6. Film obyektini yaratish
  const now = new Date().toISOString();
  const movieData = {
    id: code, // Kodni ID sifatida ishlatamiz
    title: title.trim(),
    originalTitle: originalTitle ? originalTitle.trim() : "",
    year: year || 0,
    genres: genres.length ? genres : ["Drama"], // Default janr
    rating: rating || 0,
    duration: duration || "",
    description: description || "",
    poster: "g0",
    posterUrl: "",
    backdropUrl: "",
    videoSources: null,
    status: "active",
    featured: false,
    createdAt: now,
    updatedAt: now,
  };

  const createResult = await repos.movies.create(movieData);
  if (createResult.conflict) {
    throw new Error(`Film yaratib bo'lmadi: ID konflikt`);
  }

  // 7. Videoni storage'ga saqlash (720p sifatida - default quality)
  // Kelajakda bir xil videodan bir necha quality generatsiya qilinishi mumkin (ffmpeg bilan)
  const quality = "720p";
  const saved = await saveVideoToStorage(code, quality, videoBuffer, mimeType);

  // 8. Video manbasini filmga bog'lash
  await repos.movies.attachVideo(code, quality, {
    objectKey: saved.objectKey,
    size: saved.size,
    storageType: saved.storageType,
  });

  // 9. Audit log
  await logAudit({
    adminId: adminId || "channel-import",
    action: "CHANNEL_IMPORT_CREATED_MOVIE",
    entityType: "movie",
    entityId: code,
    newValue: { title, code, quality, size: saved.size, storageType: saved.storageType },
  });

  const movie = repos.movies.getById(code);
  return {
    movie,
    code,
    videoQuality: quality,
    storageType: saved.storageType,
  };
}

// ---------------------------------------------------------------------------
// Kod bilan film qidirish (foydalanuvchi botga kod yuborganida)
// ---------------------------------------------------------------------------

/**
 * Kod bo'yicha film topish
 * @param {string} code - Film kodi
 * @returns {object|null} Film obyekti yoki null
 */
function getMovieByCode(code) {
  if (!code || typeof code !== "string") return null;
  const normalized = code.replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase();
  return repos.movies.getById(normalized);
}

module.exports = {
  parseChannelCaption,
  getTelegramFilePath,
  downloadTelegramFile,
  saveVideoToStorage,
  importFromChannelMessage,
  getMovieByCode,
};