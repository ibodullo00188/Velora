// backend/src/localStorage.js
// R2 sozlanmaganida video fayllarni kompyuterga (lokal disk) saqlash uchun
// alternativ. Fayllar `backend/data/videos/{movieId}/{quality}.mp4` da turadi.
//
// R2 bilan bir xil objectKey formatidan foydalanadi (movies/{id}/{quality}.mp4),
// shuning uchun DB'dagi videoSources bir xil ko'rinishda qoladi va R2'ga o'tilganda
// hech narsa o'zgartirish shart emas.
//
// API r2.js ga o'xshash qilib yozilgan — server.js ikkalasini birdek chaqiradi.

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const LOCAL_QUALITIES = ["360p", "480p", "720p", "1080p"];

// Video fayllar saqlanadigan papka:
//   1) LOCAL_VIDEOS_DIR muhit o'zgaruvchisi bo'lsa — shu yo'l.
//   2) Aks holda — backend/ videos/ (project root'dagi videos papkasi).
// R2 bilan bir xil objectKey formatidan foydalanadi (movies/{id}/{quality}.mp4),
// shuning uchun DB'dagi videoSources bir xil ko'rinishda qoladi.
const VIDEOS_ROOT = process.env.LOCAL_VIDEOS_DIR
  ? path.resolve(process.env.LOCAL_VIDEOS_DIR)
  : path.join(__dirname, "..", "..", "videos");

// Key -> diskdagi haqiqiy fayl yo'li. "movies/{id}/{quality}.mp4" formatini
// qabul qiladi. Boshqa narsa (path traversal) kelganda null qaytaradi.
function resolvePath(objectKey) {
  if (typeof objectKey !== "string") return null;
  const m = /^movies\/([^/]+)\/([^/]+\.mp4)$/.exec(objectKey);
  if (!m) return null;
  const movieId = m[1];
  if (!/^[a-zA-Z0-9_-]+$/.test(movieId)) return null;
  return path.join(VIDEOS_ROOT, movieId, m[2]);
}

function ensureDir() {
  fs.mkdirSync(VIDEOS_ROOT, { recursive: true });
}

function isConfigured() {
  try {
    ensureDir();
    fs.accessSync(VIDEOS_ROOT, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isValidQuality(q) {
  return LOCAL_QUALITIES.includes(q);
}

function buildObjectKey(movieId, quality) {
  return `movies/${movieId}/${quality}.mp4`;
}

function buildObjectPrefix(movieId) {
  return `movies/${movieId}/`;
}

function exists(objectKey) {
  const p = resolvePath(objectKey);
  return p !== null && fs.existsSync(p);
}

async function stat(objectKey) {
  const p = resolvePath(objectKey);
  if (!p) return null;
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

async function remove(objectKey) {
  const p = resolvePath(objectKey);
  if (!p) return { ok: false, status: 400 };
  try {
    await fsp.unlink(p);
    return { ok: true };
  } catch (e) {
    if (e.code === "ENOENT") return { ok: true };
    return { ok: false, error: e };
  }
}

// Film butunlay o'chirilganda uning barcha quality'larini tozalaydi.
async function removeByMovieId(movieId) {
  const dir = path.join(VIDEOS_ROOT, movieId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Upload: request body ni to'g'ridan-to'g'ri faylga yozadi (xotiraga olmasdan).
// Avval temp faylga yozadi, keyin rename qiladi — yarim yuklangan fayl
// haqiqiy nom bilan qolib ketmaydi.
// return Promise<{ok, size?}> — ok:false bo'lsa error xabari keltiriladi.
function saveStream(req, objectKey) {
  const p = resolvePath(objectKey);
  return new Promise((resolve, reject) => {
    if (!p) return reject(new Error("Noto'g'ri objectKey"));
    ensureDir();
    const dir = path.dirname(p);
    const tmp = path.join(dir, `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return reject(e);
    }

    const ws = fs.createWriteStream(tmp, { flags: "w" });
    let size = 0;

    req.on("error", (e) => {
      ws.destroy();
      fs.unlink(tmp, () => {});
      reject(e);
    });

    req.pipe(ws);

    ws.on("error", (e) => {
      fs.unlink(tmp, () => {});
      reject(e);
    });

    ws.on("finish", () => {
      ws.close();
      fs.rename(tmp, p, (err) => {
        if (err) {
          fs.unlink(tmp, () => {});
          return reject(err);
        }
        resolve({ ok: true, size });
      });
    });

    // Hajmni vaqtincha o'sishini kuzatish uchun (oxirida stat orqali aniq olamiz,
    // lekin progress uchun ham qo'l keladi).
    req.on("data", (chunk) => {
      size += chunk.length;
    });
  });
}

// Stream: video faylni Range so'rovlari bilan xizmat qiladi (seeking ishlaydi).
// HTTP status'ni va Content-Range header'larini o'zi yozadi.
//
// VIDEO_READ_CHUNK: fayldan o'qib client'ga yoziladigan har bir bo'lakning
// hajmi. Node'dagi default 64KB juda kichik — server socket'ga har safar
// 64KB yozadi, tunnel (cloudflared) ustida kichik-kichik bo'laklar sifatida
// yetib boradi. Natijada brauzer o'tkazuvchanlikni past deb o'lchaydi va
// kichik Range so'rovlar yuboradi → video "qisqa qism-qism" keladi.
// 1MB ga oshirilsa server ma'lumotni katta, uzluksiz qismlarda yetkazadi —
// brauzer kattaroq qismlarni so'raydi va video uzluksizroq o'ynaydi.
const VIDEO_READ_CHUNK = 1024 * 1024;

function stream(req, res, objectKey) {
  const p = resolvePath(objectKey);
  if (!p || !fs.existsSync(p)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Video topilmadi" } }));
    return false;
  }

  const stat = fs.statSync(p);
  const total = stat.size;
  const range = req.headers.range;
  const mime = "video/mp4";

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start, end;
    if (m && m[1] === "" && m[2] !== "") {
      // Suffix range: "bytes=-N" → faylning OXIRGI N bayti.
      // Browser'lar moov (metadata) oxirida bo'lgan MP4'ni o'qish uchun shunday
      // so'rov yuboradi — buni noto'g'ri boshqarish videoni o'ynatmaydi.
      const suffix = parseInt(m[2], 10);
      start = Number.isNaN(suffix) || suffix <= 0 ? 0 : Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = m && m[1] ? parseInt(m[1], 10) : 0;
      end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    }
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    });
    fs.createReadStream(p, { start, end, highWaterMark: VIDEO_READ_CHUNK }).pipe(res);
    return true;
  }

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
  });
  fs.createReadStream(p, { highWaterMark: VIDEO_READ_CHUNK }).pipe(res);
  return true;
}

module.exports = {
  VIDEOS_ROOT,
  QUALITIES: LOCAL_QUALITIES,
  isConfigured,
  isValidQuality,
  buildObjectKey,
  buildObjectPrefix,
  resolvePath,
  exists,
  stat,
  remove,
  removeByMovieId,
  saveStream,
  stream,
};
