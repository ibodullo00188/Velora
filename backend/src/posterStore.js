// src/posterStore.js
// Film posterlarini lokal diskda saqlaydi: data/posters/{movieId}.{ext}
//
// Video R2'da saqlansa ham posterlar lokal qoladi — kichik fayllar,
// shu orqali ular `/api/movies/:id/poster` route'ida xizmat ko'rsatiladi.
// Bu server veb-app bilan bir xil origin'da bo'lgani uchun rasm ham
// shu origin'da ko'rinadi (tunnel orqali ham ishlaydi).

const fs = require("fs");
const path = require("path");

const db = require("./db");
const imagekitStore = require("./imagekitStore");

const POSTERS_ROOT = path.join(__dirname, "..", "data", "posters");
const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp", "gif"];

const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function ensureDir() {
  try {
    fs.mkdirSync(POSTERS_ROOT, { recursive: true });
  } catch (e) {
    // e'tiborsiz — yozishda yana tekshiriladi
  }
}

// movieId'ni fayl nomi uchun xavfsiz qiladi (chegara belgilar olib tashlanadi).
function safeId(movieId) {
  return String(movieId || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function imageId(movieId) {
  return `poster:${safeId(movieId)}`;
}

function imagekitObjectName(movieId, ext) {
  return `kinobot/posters/${safeId(movieId)}.${ext}`;
}

// Mavjud poster faylini topadi (faqat Postgres/disk fallback uchun —
// ImageKit'ga yuklangan posterlar to'liq URL sifatida movie.posterUrl'da
// saqlanadi, shuning uchun bu funksiya orqali qidirilmaydi).
// Postgres-rejimda: { ext, buffer } | null (DB'dan)
// Fayl-rejimda (avvalgidek): { ext, absPath } | null (diskdan)
async function findForMovie(movieId) {
  if (db.isPostgres()) {
    const found = await db.findImage(imageId(movieId));
    if (!found) return null;
    return { ext: found.ext, buffer: found.data };
  }
  ensureDir();
  const base = safeId(movieId);
  for (const ext of ALLOWED_EXT) {
    const abs = path.join(POSTERS_ROOT, `${base}.${ext}`);
    try {
      if (fs.existsSync(abs)) return { ext, absPath: abs };
    } catch (e) {
      // e'tiborsiz
    }
  }
  return null;
}

// Poster yozadi. Ustuvorlik: ImageKit (sozlangan bo'lsa, tashqi
// doimiy URL bilan) → Postgres (DB'ga, deploy'da yo'qolmasligi uchun) →
// disk (lokal). ImageKit ishlatilganda { ext, url } qaytadi — chaqiruvchi
// shu url'ni to'g'ridan-to'g'ri posterUrl sifatida saqlashi kerak.
async function savePoster(movieId, buffer, ext) {
  if (imagekitStore.isConfigured()) {
    // Eski kengaytmadagi obyektlarni tozalash (bir vaqtda bitta poster turi
    // qoladi) — best-effort, xato bo'lsa ham yuklashni to'xtatmaydi.
    for (const oldExt of ALLOWED_EXT) {
      if (oldExt === ext) continue;
      await imagekitStore.deleteImage(imagekitObjectName(movieId, oldExt));
    }
    const url = await imagekitStore.uploadImage(imagekitObjectName(movieId, ext), buffer, ext);
    return { ext, url };
  }
  if (db.isPostgres()) {
    await db.saveImage(imageId(movieId), ext, buffer);
    return { ext };
  }
  ensureDir();
  const base = safeId(movieId);
  // Eski kengaytmalarni tozalash — bir vaqtda bitta poster turi qoladi.
  for (const oldExt of ALLOWED_EXT) {
    if (oldExt === ext) continue;
    const p = path.join(POSTERS_ROOT, `${base}.${oldExt}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      // e'tiborsiz
    }
  }
  const abs = path.join(POSTERS_ROOT, `${base}.${ext}`);
  fs.writeFileSync(abs, buffer);
  return { ext, absPath: abs };
}

// Film o'chirilganda posterini ham olib tashlaydi (barcha backend'lardan
// best-effort — orqada qolgan eski rasm bo'lsa ham tozalanadi).
async function removeByMovieId(movieId) {
  if (imagekitStore.isConfigured()) {
    for (const ext of ALLOWED_EXT) {
      await imagekitStore.deleteImage(imagekitObjectName(movieId, ext));
    }
  }
  if (db.isPostgres()) {
    await db.deleteImage(imageId(movieId));
    return;
  }
  const f = await findForMovie(movieId);
  if (!f) return;
  try {
    fs.unlinkSync(f.absPath);
  } catch (e) {
    // e'tiborsiz
  }
}

function mimeFor(ext) {
  return MIME[ext] || "application/octet-stream";
}

// Rasm bufferining haqiqiy ekanligini tekshiradi (magic bytes).
// return ext | null
function detectImageExt(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  // GIF: "GIF8"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "gif";
  // WEBP: "RIFF" .... "WEBP"
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "webp";
  return null;
}

module.exports = {
  findForMovie,
  savePoster,
  removeByMovieId,
  mimeFor,
  detectImageExt,
  POSTERS_ROOT,
};
