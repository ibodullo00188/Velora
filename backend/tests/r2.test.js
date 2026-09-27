// tests/r2.test.js
// Cloudflare R2 (SigV4) klienti uchun unit testlar.
// Tarmoqqa chiqmaydi — faqat sof funksiyalar va imzo hisoblash tekshiriladi.
//
// node --test har bir test faylini alohida jarayonda ishga tushiradi, shuning
// uchun bu yerda process.env'ni o'zgartirish boshqa testlarga ta'sir qilmaydi.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

process.env.CLOUDFLARE_ACCOUNT_ID = "testaccount123";
process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
process.env.R2_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
process.env.R2_BUCKET_NAME = "kinobot-video";

const r2 = require("../src/r2");

// Deterministik vaqt: 2026-01-15T12:00:00Z
const FIXED = Date.UTC(2026, 0, 15, 12, 0, 0);

const CFG = {
  accountId: "testaccount123",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  bucket: "kinobot-video",
  endpoint: "https://testaccount123.r2.cloudflarestorage.com",
  bucketHost: "kinobot-video.testaccount123.r2.cloudflarestorage.com",
};

// ---------------------------------------------------------------------------
// Konfiguratsiya
// ---------------------------------------------------------------------------

test("getConfig: to'liq env bilan ob'ekt qaytaradi", () => {
  const cfg = r2.getConfig();
  assert.ok(cfg);
  assert.equal(cfg.accountId, "testaccount123");
  assert.equal(cfg.bucket, "kinobot-video");
  assert.equal(cfg.endpoint, "https://testaccount123.r2.cloudflarestorage.com");
  assert.equal(cfg.bucketHost, "kinobot-video.testaccount123.r2.cloudflarestorage.com");
  assert.ok(r2.isConfigured());
});

test("isConfigured: maydon bo'sh bo'lsa false", () => {
  const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    assert.equal(r2.isConfigured(), false);
    assert.equal(r2.getConfig(), null);
  } finally {
    process.env.CLOUDFLARE_ACCOUNT_ID = saved;
  }
});

test("isValidQuality: ruxsat etilgan sifatlar", () => {
  for (const q of ["360p", "480p", "720p", "1080p"]) assert.ok(r2.isValidQuality(q));
  for (const q of ["hd", "2k", "4k", "720", "1080P", ""]) assert.ok(!r2.isValidQuality(q));
  assert.deepEqual(r2.QUALITIES, ["360p", "480p", "720p", "1080p"]);
});

// ---------------------------------------------------------------------------
// Object key qurish
// ---------------------------------------------------------------------------

test("buildObjectKey: movies/{id}/{quality}.mp4", () => {
  assert.equal(r2.buildObjectKey("dune2", "720p"), "movies/dune2/720p.mp4");
  assert.equal(r2.buildObjectPrefix("dune2"), "movies/dune2/");
});

test("buildObjectKey: xavfli belgilar xavfsiz nomga aylantiriladi", () => {
  // Xavfli belgilar almashtiriladi — movieId segmentida hech qanday '/' qolmaydi
  // (object key faqat qat'iy struktura: movies/{id}/{quality}.mp4).
  const k = r2.buildObjectKey("my film/../../etc", "720p");
  assert.equal(k, "movies/my-film-..-..-etc/720p.mp4");
  const idSeg = k.slice("movies/".length, k.lastIndexOf("/"));
  assert.ok(!idSeg.includes("/"), "movieId segmentida '/' bo'lmasligi kerak");
  assert.ok(r2.buildObjectKey("a?b=c&d e", "1080p").startsWith("movies/a-b-c-d-e/1080p.mp4"));
  // uzun id kesiladi (prefix: "movies/" + 80 belgi + "/")
  const long = "x".repeat(200);
  assert.ok(r2.buildObjectPrefix(long).length <= "movies/".length + 80 + 1);
});

// ---------------------------------------------------------------------------
// uriEncode (RFC 3986)
// ---------------------------------------------------------------------------

test("uriEncode: RFC 3986 qoidalari", () => {
  assert.equal(r2.uriEncode("~"), "~"); // tilde saqlanadi
  assert.equal(r2.uriEncode("a b"), "a%20b");
  assert.equal(r2.uriEncode("!()*"), "%21%28%29%2A");
  assert.equal(r2.uriEncode("a&b=c/d"), "a%26b%3Dc%2Fd");
  assert.equal(r2.uriEncode("720p.mp4"), "720p.mp4");
  assert.equal(r2.uriEncode("o'zbek"), "o%27zbek");
});

// ---------------------------------------------------------------------------
// Imzo kaliti (AWS dokumentatsiyadagi ketma-ketlik)
// ---------------------------------------------------------------------------

test("getSigningKey: AWS HMAC ketma-ketligiga mos", () => {
  // AWS hujjatlaridagi aniq bosqichlar — alohida, mustaqil yozilgan:
  // kDate -> kRegion -> kService -> kSigning
  const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  const dateStamp = "20260115";
  const kDate = crypto.createHmac("sha256", "AWS4" + secret).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update("auto").digest();
  const kService = crypto.createHmac("sha256", kRegion).update("s3").digest();
  const expected = crypto.createHmac("sha256", kService).update("aws4_request").digest();

  assert.deepEqual(r2.getSigningKey(secret, dateStamp), expected);
  // Turli sanada turli kalit
  assert.notDeepEqual(r2.getSigningKey(secret, "20260116"), expected);
});

// ---------------------------------------------------------------------------
// buildPresignedUrl
// ---------------------------------------------------------------------------

test("presigned PUT URL: strukturasi va imzo parametrlari", () => {
  const url = r2.buildPresignedUrl(CFG, "PUT", "movies/dune2/720p.mp4", { nowMs: FIXED });
  assert.ok(url.startsWith("https://kinobot-video.testaccount123.r2.cloudflarestorage.com/movies/dune2/720p.mp4?"));

  const q = new URL(url).searchParams;
  assert.equal(q.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(q.get("X-Amz-Credential"), "AKIDEXAMPLE/20260115/auto/s3/aws4_request");
  assert.equal(q.get("X-Amz-Date"), "20260115T120000Z");
  assert.equal(q.get("X-Amz-Expires"), "900");
  assert.equal(q.get("X-Amz-SignedHeaders"), "host");
  const sig = q.get("X-Amz-Signature");
  assert.ok(/^[0-9a-f]{64}$/.test(sig), "imzo 64 hex belgidan iborat");
});

test("presigned GET URL: default muddat 300s", () => {
  const url = r2.presignedGetUrl("movies/dune2/720p.mp4", { nowMs: FIXED });
  assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "300");
});

test("presigned URL deterministik (berilgan nowMs bilan)", () => {
  const a = r2.buildPresignedUrl(CFG, "GET", "movies/x.mp4", { nowMs: FIXED });
  const b = r2.buildPresignedUrl(CFG, "GET", "movies/x.mp4", { nowMs: FIXED });
  assert.equal(a, b);
});

test("presigned URL: secret/kalit/vaqt o'zgarsa imzo o'zgaradi", () => {
  const base = r2.buildPresignedUrl(CFG, "GET", "movies/x.mp4", { nowMs: FIXED });
  const sig = (u) => new URL(u).searchParams.get("X-Amz-Signature");

  const otherSecret = { ...CFG, secretAccessKey: "DIFFERENT-SECRET" };
  assert.notEqual(sig(r2.buildPresignedUrl(otherSecret, "GET", "movies/x.mp4", { nowMs: FIXED })), sig(base));

  const otherKey = { ...CFG, accessKeyId: "OTHERKEY" };
  assert.notEqual(sig(r2.buildPresignedUrl(otherKey, "GET", "movies/x.mp4", { nowMs: FIXED })), sig(base));

  assert.notEqual(sig(r2.buildPresignedUrl(CFG, "GET", "movies/x.mp4", { nowMs: FIXED + 60000 })), sig(base));
});

test("presigned URL: imzo URL'dagi parametrlarga mos (mustaqil qayta hisoblash)", () => {
  const url = r2.buildPresignedUrl(CFG, "PUT", "movies/dune2/720p.mp4", { nowMs: FIXED });
  const { sig, expected } = verifySignature(url, CFG, "PUT", "movies/dune2/720p.mp4");
  assert.equal(sig, expected);
});

test("presigned URL: maxsus belgili key to'g'ri kodlanadi", () => {
  const key = "movies/menin filmim/720p.mp4";
  const url = r2.buildPresignedUrl(CFG, "PUT", key, { nowMs: FIXED });
  assert.ok(url.includes("/movies/menin%20filmim/720p.mp4?"), url);
  // Imzo hali ham URL'dagi (kodlangan) parametrlarga mos
  const { sig, expected } = verifySignature(url, CFG, "PUT", key);
  assert.equal(sig, expected);
});

test("presigned URL: xato kalit turi/xato maydon uchun ishlamaydi", () => {
  // Key ichida ? bo'lsa ham imzo URL bilan mos qolishi kerak (query ajratuvchi emas)
  const key = "movies/a?b/720p.mp4";
  const url = r2.buildPresignedUrl(CFG, "GET", key, { nowMs: FIXED });
  const { sig, expected } = verifySignature(url, CFG, "GET", key);
  assert.equal(sig, expected);
});

// ---------------------------------------------------------------------------
// buildSignedHeaders (backend fetch)
// ---------------------------------------------------------------------------

test("signed headers: Authorization formati va SignedHeaders ro'yxati", () => {
  const out = r2.buildSignedHeaders(CFG, "DELETE", "movies/dune2/720p.mp4", { nowMs: FIXED });
  assert.ok(out.url.startsWith("https://kinobot-video.testaccount123.r2.cloudflarestorage.com/movies/dune2/720p.mp4"));
  assert.equal(out.headers["X-Amz-Date"], "20260115T120000Z");
  assert.equal(out.headers["X-Amz-Content-Sha256"], crypto.createHash("sha256").update("").digest("hex"));
  assert.match(out.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260115\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

test("signed headers: query parametrlar canonical requestga kiradi", () => {
  const q = { "list-type": "2", prefix: "movies/dune2/" };
  const out = r2.buildSignedHeaders(CFG, "GET", "", { query: q, nowMs: FIXED });
  assert.ok(out.url.includes("list-type=2"));
  assert.ok(out.url.includes("prefix=movies%2Fdune2%2F"));
  assert.ok(out.url.startsWith("https://kinobot-video.testaccount123.r2.cloudflarestorage.com/?"));
});

// ---------------------------------------------------------------------------
// R2 bilan bog'lanish (tarmoqsiz) — presigned URL'lar R2'ni talab qilmaydi
// ---------------------------------------------------------------------------

test("presignedPutUrl/presignedGetUrl env'dan konfiguratsiya oladi", () => {
  const put = r2.presignedPutUrl("movies/dune2/720p.mp4", "video/mp4");
  assert.ok(put.startsWith("https://kinobot-video.testaccount123.r2.cloudflarestorage.com/"));
  const get = r2.presignedGetUrl("movies/dune2/720p.mp4");
  assert.equal(new URL(get).searchParams.get("X-Amz-Expires"), "300");
});

test("presignedPutUrl: R2 sozlanmagan bo'lsa xato beradi", () => {
  const saved = process.env.R2_BUCKET_NAME;
  delete process.env.R2_BUCKET_NAME;
  try {
    assert.throws(() => r2.presignedPutUrl("movies/x.mp4", "video/mp4"), /R2 konfiguratsiyasi/);
  } finally {
    process.env.R2_BUCKET_NAME = saved;
  }
});

// ---------------------------------------------------------------------------
// Yordamchi: presigned URL imzosini URL'ning O'Z parametrlaridan mustaqil
// qayta hisoblash. Bu canonical query'da parametr tushib qolsa / URL'da
// ortiqcha parametr bo'lsa / tartib noto'g'ri bo'lsa — ushlaydi.
// ---------------------------------------------------------------------------
function verifySignature(url, cfg, method, key) {
  const u = new URL(url);
  const q = {};
  for (const [k, v] of u.searchParams.entries()) q[k] = v;
  const sig = q["X-Amz-Signature"];
  delete q["X-Amz-Signature"];

  const amzDate = q["X-Amz-Date"];
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;

  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const encodedKey = key.split("/").map(enc).join("/");
  const canonicalQueryString = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonicalHeaders = `host:${cfg.bucketHost}\n`;
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = [method, `/${encodedKey}`, canonicalQueryString, canonicalHeaders, "host", payloadHash].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest, "utf-8").digest("hex"),
  ].join("\n");

  const kDate = crypto.createHmac("sha256", "AWS4" + cfg.secretAccessKey).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update("auto").digest();
  const kService = crypto.createHmac("sha256", kRegion).update("s3").digest();
  const signingKey = crypto.createHmac("sha256", kService).update("aws4_request").digest();
  const expected = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf-8").digest("hex");

  return { sig, expected };
}
