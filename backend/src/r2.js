// src/r2.js
// Cloudflare R2 (S3-compatible object storage) uchun minimal klient.
// Tashqi kutubxona yo'q — SigV4 imzolash Node.js crypto bilan bajariladi.
//
// Vazifasi:
//   - presigned PUT URL (browser video faylni to'g'ridan-to'g'ri R2'ga yuklaydi)
//   - presigned GET URL (player uchun vaqtinchalik ko'rish URL)
//   - signed DELETE (backend R2'dagi objectni o'chiradi)
//   - prefix bo'yicha list/delete (film o'chirilganda orphan objectlar cleanup)
//
// R2 bucket private bo'ladi. Secretlar faqat serverda — browser R2'ga hech
// qachon Access Key / Secret bilmaydi, faqat vaqtinchalik presigned URL oladi.
//
// R2 endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
// Bucket host: https://<BUCKET>.<ACCOUNT_ID>.r2.cloudflarestorage.com

"use strict";

const crypto = require("crypto");

const R2_REGION = "auto";
const R2_SERVICE = "s3";
const R2_QUALITIES = ["360p", "480p", "720p", "1080p"];

// ---------------------------------------------------------------------------
// Konfiguratsiya
// ---------------------------------------------------------------------------

// .env'dan R2 sozlamalarini oladi. To'liq bo'lmasa null qaytaradi.
function getConfig() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucketHost: `${bucket}.${accountId}.r2.cloudflarestorage.com`,
  };
}

function isConfigured() {
  return getConfig() !== null;
}

function isValidQuality(q) {
  return R2_QUALITIES.includes(q);
}

// Object key: movies/{movieId}/{quality}.mp4
// movieId'dagi yo'l-ni buzadigan belgilar xavfsiz nomga aylantiriladi.
function buildObjectKey(movieId, quality) {
  return `${buildObjectPrefix(movieId)}${quality}.mp4`;
}

// Film uchun prefix: movies/{movieId}/ — film o'chirilganda cleanup uchun.
function buildObjectPrefix(movieId) {
  const safeId = String(movieId).replace(/[^a-z0-9\-_.]/gi, "-").replace(/-+/g, "-").slice(0, 80);
  return `movies/${safeId}/`;
}

// ---------------------------------------------------------------------------
// SigV4 yordamchilari (AWS Signature Version 4)
// ---------------------------------------------------------------------------

// RFC 3986 URL-encoding (AWS talabi: ~ saqlanadi, bo'sh joy %20).
function uriEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

// Imzolash kaliti: AWS4+secret -> date -> region -> service -> aws4_request
function getSigningKey(secretAccessKey, dateStamp) {
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, R2_REGION);
  const kService = hmac(kRegion, R2_SERVICE);
  return hmac(kService, "aws4_request");
}

function amzDateTime(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Presigned URL qurish (browser to'g'ridan-to'g'ri PUT/GET qila oladi).
// nowMs — testlar uchun determinizm (production'da berilmaydi).
function buildPresignedUrl(cfg, method, key, { expiresInSeconds = 900, nowMs } = {}) {
  const now = nowMs ? new Date(nowMs) : new Date();
  const amzDate = amzDateTime(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const encodedKey = key.split("/").map(uriEncode).join("/");

  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(Number(expiresInSeconds) || 900))),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const canonicalHeaders = `host:${cfg.bucketHost}\n`;
  const signedHeaders = "host";
  // Presigned URL'da payload hash serverda noma'lum (browser yuklaydi).
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    `/${encodedKey}`,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(cfg.secretAccessKey, dateStamp);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  return `https://${cfg.bucketHost}/${encodedKey}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// Backend fetch uchun imzolangan so'rov headerlari (DELETE, LIST, HEAD).
// nowMs — testlar uchun.
function buildSignedHeaders(cfg, method, key, { query = {}, nowMs, timeoutMs } = {}) {
  const now = nowMs ? new Date(nowMs) : new Date();
  const amzDate = amzDateTime(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const payloadHash = sha256Hex(""); // bo'sh body

  const encodedKey = key.split("/").map(uriEncode).join("/");

  const canonicalQueryString = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const extra = { "host": cfg.bucketHost, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const canonicalHeaders = Object.keys(extra).sort().map((k) => `${k}:${extra[k]}\n`).join("");
  const signedHeaders = Object.keys(extra).sort().join(";");

  const canonicalRequest = [
    method,
    `/${encodedKey}`,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(cfg.secretAccessKey, dateStamp);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const querySuffix = canonicalQueryString ? `?${canonicalQueryString}` : "";
  return {
    url: `https://${cfg.bucketHost}/${encodedKey}${querySuffix}`,
    headers: {
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      "Authorization":
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signature,
    amzDate,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function presignedPutUrl(key, contentType, opts) {
  const cfg = getConfig();
  if (!cfg) throw new Error("R2 konfiguratsiyasi yetishmayapti");
  return buildPresignedUrl(cfg, "PUT", key, { ...(opts || {}) });
}

function presignedGetUrl(key, opts) {
  const cfg = getConfig();
  if (!cfg) throw new Error("R2 konfiguratsiyasi yetishmayapti");
  return buildPresignedUrl(cfg, "GET", key, { expiresInSeconds: 300, ...(opts || {}) });
}

function signedRequestFetch(method, key, { query = {}, timeoutMs = 10_000, nowMs } = {}) {
  const cfg = getConfig();
  if (!cfg) throw new Error("R2 konfiguratsiyasi yetishmayapti");
  const { url, headers } = buildSignedHeaders(cfg, method, key, { query, nowMs });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { method, headers, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

// R2'dagi objectni o'chiradi. Natija: { status, ok }.
async function deleteObject(key, opts) {
  const res = await signedRequestFetch("DELETE", key, opts);
  return { status: res.status, ok: res.ok };
}

// R2'dagi object mavjudligini tekshiradi (upload tugagach confirm uchun).
// Natija: { status, ok, size, lastModified } — mavjud bo'lmasa ok=false.
async function headObject(key, opts) {
  const res = await signedRequestFetch("HEAD", key, opts);
  if (!res.ok) return { status: res.status, ok: false };
  return {
    status: res.status,
    ok: true,
    size: Number(res.headers.get("content-length")) || 0,
    lastModified: res.headers.get("last-modified") || "",
  };
}

// Prefix ostidagi object key'larni ListObjectsV2 orqali oladi.
async function listObjects(prefix, opts) {
  const res = await signedRequestFetch("GET", "", { query: { "list-type": "2", prefix }, ...(opts || {}) });
  if (!res.ok) {
    throw new Error(`R2 list muvaffaqiyatsiz: HTTP ${res.status}`);
  }
  const xml = await res.text();
  const keys = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    keys.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  return keys;
}

// Prefix ostidagi barcha objectlarni o'chiradi (movie delete cleanup).
// Orphan objectlar (DB'da yo'q, lekin R2'da qolgan) ham o'chiriladi.
// return: o'chirilgan objectlar soni
async function deleteObjectsByPrefix(prefix, opts) {
  let keys;
  try {
    keys = await listObjects(prefix, opts);
  } catch (e) {
    // List bosilmasa (R2 o'chirilgan bo'lsa) xato — chaqiruvchi hal qilsin.
    throw e;
  }
  for (const key of keys) {
    try {
      await deleteObject(key, opts);
    } catch (e) {
      // Bitta object o'chmasa to'xtamaymiz — qolganlarini davom ettiramiz.
    }
  }
  return keys.length;
}

module.exports = {
  QUALITIES: R2_QUALITIES,
  isConfigured,
  getConfig,
  isValidQuality,
  buildObjectKey,
  buildObjectPrefix,
  presignedPutUrl,
  presignedGetUrl,
  headObject,
  deleteObject,
  listObjects,
  deleteObjectsByPrefix,
  // test/ichki
  buildPresignedUrl,
  buildSignedHeaders,
  getSigningKey,
  uriEncode,
};
