// src/bannerStore.js
// Bosh sahifa banneri rasmini lokal diskda saqlaydi: data/banner/image.{ext}
//
// Banner kichik fayl bo'lgani uchun poster kabi lokal qoladi va
// `/api/banner/image` route'ida xizmat ko'rsatiladi.

const fs = require("fs");
const path = require("path");

const db = require("./db");
const imagekitStore = require("./imagekitStore");
const { detectImageExt } = require("./posterStore");

const BANNER_IMAGE_ID = "banner";
function imagekitObjectName(ext) {
  return `kinobot/banner.${ext}`;
}

const BANNER_ROOT = path.join(__dirname, "..", "data", "banner");
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
    fs.mkdirSync(BANNER_ROOT, { recursive: true });
  } catch (e) {
    // e'tiborsiz — yozishda yana tekshiriladi
  }
}

// Mavjud banner rasmini topadi.
// Postgres-rejimda: { ext, buffer } | null (DB'dan)
// Fayl-rejimda (avvalgidek): { ext, absPath } | null (diskdan)
async function find() {
  if (db.isPostgres()) {
    const found = await db.findImage(BANNER_IMAGE_ID);
    if (!found) return null;
    return { ext: found.ext, buffer: found.data };
  }
  ensureDir();
  for (const ext of ALLOWED_EXT) {
    const abs = path.join(BANNER_ROOT, `image.${ext}`);
    try {
      if (fs.existsSync(abs)) return { ext, absPath: abs };
    } catch (e) {
      // e'tiborsiz
    }
  }
  return null;
}

// Rasm yozadi. Ustuvorlik: ImageKit (sozlangan bo'lsa) → Postgres → disk.
// ImageKit ishlatilganda { ext, url } qaytadi.
async function save(buffer, ext) {
  if (imagekitStore.isConfigured()) {
    for (const oldExt of ALLOWED_EXT) {
      if (oldExt === ext) continue;
      await imagekitStore.deleteImage(imagekitObjectName(oldExt));
    }
    const url = await imagekitStore.uploadImage(imagekitObjectName(ext), buffer, ext);
    return { ext, url };
  }
  if (db.isPostgres()) {
    await db.saveImage(BANNER_IMAGE_ID, ext, buffer);
    return { ext };
  }
  ensureDir();
  for (const oldExt of ALLOWED_EXT) {
    if (oldExt === ext) continue;
    const p = path.join(BANNER_ROOT, `image.${oldExt}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      // e'tiborsiz
    }
  }
  const abs = path.join(BANNER_ROOT, `image.${ext}`);
  fs.writeFileSync(abs, buffer);
  return { ext, absPath: abs };
}

// Banner rasmini o'chiradi (barcha backend'lardan best-effort).
async function remove() {
  if (imagekitStore.isConfigured()) {
    for (const ext of ALLOWED_EXT) {
      await imagekitStore.deleteImage(imagekitObjectName(ext));
    }
  }
  if (db.isPostgres()) {
    await db.deleteImage(BANNER_IMAGE_ID);
    return;
  }
  const f = await find();
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

module.exports = {
  find,
  save,
  remove,
  mimeFor,
  detectImageExt,
  BANNER_ROOT,
};
