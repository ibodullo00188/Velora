// tests/videoRouting.test.js
// videoRouting.resolveVideoSource — R2 → Kali lokal fallback prioriteti.
//
// Qat'iy prioritet (foydalanuvchi talabiga ko'ra):
//   1. R2 mavjud va ishlayotgan bo'lsa → FAQAT R2 (Kali tekshirilmaydi!)
//   2. R2'da video topilmasa yoki R2 xato bersa → Kali lokal
//   3. Ikkalasida ham yo'q → null (frontend "video mavjud emas" ko'rsatadi)
//
// Tarmoqqa chiqmaydi — r2/local localStorage modullari mock qilinadi.
const { test } = require("node:test");
const assert = require("node:assert");

const { resolveVideoSource } = require("../src/videoRouting");

const MOVIE = "johnwick4";
const QUALITY = "720p";
const STREAM_URL = "https://host/api/movies/johnwick4/video/720p/stream?token=abc";

function makeR2(overrides = {}) {
  return {
    isConfigured: () => true,
    buildObjectKey: (id, q) => `movies/${id}/${q}.mp4`,
    headObject: async () => ({ ok: true, size: 123 }),
    presignedGetUrl: () => "https://r2.example/presigned/get?x=1",
    ...overrides,
  };
}

function makeLocal(overrides = {}) {
  return {
    isConfigured: () => true,
    buildObjectKey: (id, q) => `movies/${id}/${q}.mp4`,
    exists: () => false,
    ...overrides,
  };
}

const buildStreamUrl = (id, q) => STREAM_URL;

function makeLogger() {
  const warns = [];
  return {
    warns,
    warn: (msg, ctx) => warns.push({ msg, ctx }),
  };
}

// ---------------------------------------------------------------------------
// 1. R2 mavjud + ishlaydi → FAQAT R2, Kali ishlatilmaydi (strict priority)
// ---------------------------------------------------------------------------
test("R2 mavjud bo'lsa Kali tekshirilmaydi — qat'iy prioritet", async () => {
  let localChecked = 0;
  const local = makeLocal({
    exists: () => { localChecked++; return true; }, // kali'da video bor ham — lekin ishlatilmasligi kerak
  });
  const r2 = makeR2();

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });

  assert.equal(localChecked, 0, "R2 mavjud bo'lsa Kali'ga umuman murojaat qilinmasligi kerak");
  assert.equal(result.storageType, "r2");
  assert.equal(result.url, "https://r2.example/presigned/get?x=1");
});

// ---------------------------------------------------------------------------
// 2. R2 sozlanmagan → Kali tekshiriladi; Kali'da bor → Kali'dan
// ---------------------------------------------------------------------------
test("R2 sozlanmagan, Kali'da video bor → Kali'dan o'ynatiladi", async () => {
  const r2 = makeR2({ isConfigured: () => false });
  const local = makeLocal({ exists: () => true });

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });

  assert.equal(result.storageType, "local");
  assert.equal(result.url, STREAM_URL);
});

// ---------------------------------------------------------------------------
// 3. R2 sozlangan, lekin object topilmadi → Kali fallback
// ---------------------------------------------------------------------------
test("R2'da object yo'q (HEAD ok=false) → Kali fallback", async () => {
  const r2 = makeR2({ headObject: async () => ({ ok: false, status: 404 }) });
  const local = makeLocal({ exists: () => true });

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });

  assert.equal(result.storageType, "local");
  assert.equal(result.url, STREAM_URL);
});

// ---------------------------------------------------------------------------
// 4. Ikkalasida ham yo'q → null ("video mavjud emas")
// ---------------------------------------------------------------------------
test("R2'da ham Kali'da ham video yo'q → null", async () => {
  // R2 HEAD ok=false (object yo'q), Kali'da ham fayl yo'q.
  const r2 = makeR2({ headObject: async () => ({ ok: false, status: 404 }) });
  const local = makeLocal();

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });
  assert.equal(result, null);
});

test("R2 sozlanmagan, Kali'da ham yo'q → null", async () => {
  const r2 = makeR2({ isConfigured: () => false });
  const local = makeLocal();

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 5. R2 xato berdi (tarmoq/timeout) → Kali fallback + warn log
// ---------------------------------------------------------------------------
test("R2 HEAD tarmoq xatosi (timeout) → Kali fallback", async () => {
  const logger = makeLogger();
  const r2 = makeR2({ headObject: async () => { throw new Error("timeout 3s"); } });
  const local = makeLocal({ exists: () => true });

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl, logger });

  assert.equal(result.storageType, "local");
  assert.equal(result.url, STREAM_URL);
  assert.ok(logger.warns.length >= 1, "R2 xatosi logger'da qayd etilishi kerak");
});

// ---------------------------------------------------------------------------
// 6. R2 HEAD ok, lekin presigned URL yaratilmadi → Kali fallback
// ---------------------------------------------------------------------------
test("R2 presigned URL xatosi → Kali fallback", async () => {
  const logger = makeLogger();
  const r2 = makeR2({ presignedGetUrl: () => { throw new Error("sign fail"); } });
  const local = makeLocal({ exists: () => true });

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl, logger });

  assert.equal(result.storageType, "local");
  assert.equal(result.url, STREAM_URL);
  assert.ok(logger.warns.length >= 1);
});

// ---------------------------------------------------------------------------
// 7. Ikkala storage ham sozlanmagan → null (xizmat mavjud emas)
// ---------------------------------------------------------------------------
test("R2 ham Kali ham sozlanmagan → null", async () => {
  const r2 = makeR2({ isConfigured: () => false });
  const local = makeLocal({ isConfigured: () => false });

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 8. buildStreamUrl chaqiruvi to'g'ri parametrlar bilan bajariladi
// ---------------------------------------------------------------------------
test("Kali fallback'da buildStreamUrl(movieId, quality) chaqiriladi", async () => {
  let called = null;
  const r2 = makeR2({ isConfigured: () => false });
  const local = makeLocal({ exists: () => true });
  const build = (id, q) => { called = { id, q }; return STREAM_URL; };

  const result = await resolveVideoSource({ movieId: MOVIE, quality: QUALITY, r2, local, buildStreamUrl: build });
  assert.deepEqual(called, { id: MOVIE, q: QUALITY });
  assert.equal(result.storageType, "local");
});
