// src/imagekitStore.js
// ImageKit.io (Media Library) uchun minimal klient — tashqi SDK yo'q,
// faqat Node.js https/crypto bilan (loyihaning r2.js/firebaseStore.js
// bilan bir xil uslubi).
//
// Autentifikatsiya: ImageKit private API kaliti bilan HTTP Basic Auth
// (username = private key, password = bo'sh, ya'ni "private_key:").
//
// Ishlash tartibi:
//   1) Yuklash: POST https://upload.imagekit.io/api/v1/files/upload
//      (multipart/form-data) — useUniqueFileName=false + overwriteFile=true
//      bilan, shu sababli bir xil objectName qayta yuklansa eskisi
//      o'rniga yoziladi (Firebase'dagi kabi qayta-qayta nusxa yaratmaydi).
//      Javobda to'liq ochiq (public) "url" maydoni qaytadi.
//   2) O'chirish: fileId kerak, u esa faqat yuklashda yoki "list files"
//      so'rovida qaytadi — shuning uchun avval yo'l (folder+fileName)
//      bo'yicha qidiriladi (GET /v1/files), so'ng DELETE /v1/files/{id}.

"use strict";

const https = require("https");
const crypto = require("crypto");

const UPLOAD_HOST = "upload.imagekit.io";
const API_HOST = "api.imagekit.io";

function getConfig() {
  const privateKey = (process.env.IMAGEKIT_PRIVATE_KEY || "").trim();
  // masalan: https://ik.imagekit.io/sizning_id
  const urlEndpoint = (process.env.IMAGEKIT_URL_ENDPOINT || "").trim().replace(/\/+$/, "");
  if (!privateKey || !urlEndpoint) return null;
  return { privateKey, urlEndpoint };
}

function isConfigured() {
  return getConfig() !== null;
}

function authHeader(privateKey) {
  return `Basic ${Buffer.from(`${privateKey}:`).toString("base64")}`;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, body: buf });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

// "kinobot/posters/123.jpg" -> { folder: "/kinobot/posters", fileName: "123.jpg" }
function splitObjectName(objectName) {
  const clean = String(objectName || "").replace(/^\/+/, "");
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return { folder: "/", fileName: clean };
  return { folder: `/${clean.slice(0, idx)}`, fileName: clean.slice(idx + 1) };
}

// objectName: masalan "kinobot/posters/{movieId}.jpg" yoki "kinobot/banner.jpg"
// return: doimiy ochiq (public) yuklab olish URL'i
async function uploadImage(objectName, buffer, ext) {
  const cfg = getConfig();
  if (!cfg) throw new Error("ImageKit sozlanmagan");
  const { folder, fileName } = splitObjectName(objectName);
  const mime = MIME[ext] || "application/octet-stream";

  const boundary = `kinobot_${crypto.randomBytes(16).toString("hex")}`;
  const fields = {
    fileName,
    folder,
    useUniqueFileName: "false",
    overwriteFile: "true",
  };

  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`, "utf8")
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`,
      "utf8"
    )
  );
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--`, "utf8"));
  const body = Buffer.concat(parts);

  const res = await httpsRequest(
    {
      hostname: UPLOAD_HOST,
      path: "/api/v1/files/upload",
      method: "POST",
      headers: {
        Authorization: authHeader(cfg.privateKey),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    },
    body
  );

  let parsed;
  try {
    parsed = JSON.parse(res.body.toString("utf8"));
  } catch (e) {
    throw new Error(`ImageKit yuklash javobi JSON emas (status ${res.statusCode})`);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(parsed.message || `ImageKit yuklash xatosi (${res.statusCode})`);
  }

  return parsed.url;
}

// Berilgan objectName bo'yicha fileId'ni topadi (yo'l + nom bo'yicha qidiradi).
async function findFileId(objectName, privateKey) {
  const { folder, fileName } = splitObjectName(objectName);
  const qs = new URLSearchParams({
    path: folder,
    searchQuery: `name="${fileName}"`,
    limit: "5",
  }).toString();
  const res = await httpsRequest({
    hostname: API_HOST,
    path: `/v1/files?${qs}`,
    method: "GET",
    headers: { Authorization: authHeader(privateKey) },
  });
  let parsed;
  try {
    parsed = JSON.parse(res.body.toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const match = parsed.find((f) => f && f.name === fileName);
  return match ? match.fileId : null;
}

async function deleteImage(objectName) {
  const cfg = getConfig();
  if (!cfg) return; // sozlanmagan — jim o'tamiz (boshqa backend ishlatilayotgan bo'lishi mumkin)
  try {
    const fileId = await findFileId(objectName, cfg.privateKey);
    if (!fileId) return;
    await httpsRequest({
      hostname: API_HOST,
      path: `/v1/files/${fileId}`,
      method: "DELETE",
      headers: { Authorization: authHeader(cfg.privateKey) },
    });
  } catch (e) {
    // e'tiborsiz — rasm allaqachon yo'q bo'lishi mumkin
  }
}

// Berilgan URL aynan shu ImageKit endpoint'imizdan ("kinobot/" papkasidan)
// ekanligini tekshiradi — tashqi qo'lda kiritilgan poster URL'larini
// tasodifan tozalab qo'ymaslik uchun.
function isOurUrl(url) {
  const cfg = getConfig();
  if (!cfg || typeof url !== "string") return false;
  return url.startsWith(`${cfg.urlEndpoint}/kinobot/`);
}

module.exports = {
  isConfigured,
  uploadImage,
  deleteImage,
  isOurUrl,
};
