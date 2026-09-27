// tests/localStorage.test.js
// localStorage moduli — Kali lokal video saqlash.
//   - resolvePath: path traversal himoyasi
//   - saveStream: faylga stream yozish
//   - stream: HTTP Range qo'llab-quvvatlashi (seek/forward/backward)
//   - removeByMovieId: film papkasini tozalash
//
// Hermetik: LOCAL_VIDEOS_DIR vaqtinchalik papkaga ko'rsatiladi (tarmoqqa chiqmaydi).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kinobot-local-"));
process.env.LOCAL_VIDEOS_DIR = TMP;

const localStorage = require("../src/localStorage");

let server;
let base;

before(async () => {
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const m = /^\/stream\/([^/]+)\/([^/]+)$/.exec(req.url);
      if (!m) { res.writeHead(404); res.end(); return; }
      localStorage.stream(req, res, localStorage.buildObjectKey(m[1], m[2]));
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on("error", reject);
  });

  // Test video fayl: 360p (100 bayt) — 1080p alohida fayl sifatida.
  const payload = Buffer.from("0123456789".repeat(10)); // 100 bayt
  fs.mkdirSync(path.join(TMP, "film-1"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "film-1", "360p.mp4"), payload);
  fs.writeFileSync(path.join(TMP, "film-1", "1080p.mp4"), Buffer.alloc(8, 7));
});

after(() => {
  if (server) server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// resolvePath: xavfsizlik
// ---------------------------------------------------------------------------
test("resolvePath: to'g'ri key -> fayl yo'li", () => {
  const p = localStorage.resolvePath("movies/film-1/360p.mp4");
  assert.equal(p, path.join(TMP, "film-1", "360p.mp4"));
});

test("resolvePath: path traversal rad etiladi", () => {
  assert.equal(localStorage.resolvePath("movies/../../etc/passwd.mp4"), null);
  assert.equal(localStorage.resolvePath("movies/a/../../../b.mp4"), null);
  assert.equal(localStorage.resolvePath("../movies/x/360p.mp4"), null);
  assert.equal(localStorage.resolvePath("movies/x/360p"), null);       // .mp4 yo'q
  assert.equal(localStorage.resolvePath("movies/x/360p.mp4/extra"), null);
  assert.equal(localStorage.resolvePath("movies/x/360p.exe"), null);   // noto'g'ri kengaytma
  assert.equal(localStorage.resolvePath("boshqa/x/360p.mp4"), null);   // prefix movies/ emas
  assert.equal(localStorage.resolvePath("movies/../x/360p.mp4"), null);
  assert.equal(localStorage.resolvePath(42), null);
});

// ---------------------------------------------------------------------------
// exists / stat
// ---------------------------------------------------------------------------
test("exists/stat: mavjud va yo'q fayl", async () => {
  assert.ok(localStorage.exists("movies/film-1/360p.mp4"));
  const s = await localStorage.stat("movies/film-1/360p.mp4");
  assert.equal(s.size, 100);
  assert.ok(!localStorage.exists("movies/film-1/720p.mp4"));
  assert.equal(await localStorage.stat("movies/film-1/720p.mp4"), null);
});

// ---------------------------------------------------------------------------
// HTTP Range — asosiy talab: seek/forward/backward ishlashi shart
// ---------------------------------------------------------------------------
test("stream: Range'siz 200 + to'liq content + Accept-Ranges", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf.toString("utf8"), "0123456789".repeat(10));
});

test("stream: Range bytes=0-9 -> 206, faqat 10 bayt", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=0-9" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 0-9/100");
  assert.equal(res.headers.get("content-length"), "10");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString("utf8"), "0123456789");
});

test("stream: o'rtadan Range bytes=50-74 (seek forward)", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=50-74" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 50-74/100");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 25);
  // "0123456789" 5-martadan boshlanadi: index 50 -> '0'
  assert.equal(buf.toString("utf8"), "0123456789012345678901234");
});

test("stream: ochiq Range bytes=90- (seek backward, oxirigacha)", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=90-" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 90-99/100");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString("utf8"), "0123456789");
});

test("stream: oxiri chegaradan oshsa ham 206 (end total-1 gacha kesiladi)", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=95-9999" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 95-99/100");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString("utf8"), "56789");
});

test("stream: start > end -> 416 + Content-Range bytes */total", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=50-10" } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), "bytes */100");
});

// Suffix range: browser'lar moov (metadata) oxirida turgan MP4'ni o'qish uchun
// "bytes=-N" so'rov yuboradi — faylning OXIRGI N baytini qaytarish kerak.
test("stream: suffix range bytes=-25 -> oxirgi 25 bayt (moov o'qish)", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=-25" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 75-99/100");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 25);
  // Oxirgi 25 belgi: index 75 -> '5' ("0123456789".repeat(10) ichida 75%10=5)
  assert.equal(buf.toString("utf8"), "5678901234567890123456789");
});

test("stream: suffix range butun fayldan katta (bytes=-9999) -> to'liq 200-to'g'ri 206", async () => {
  const res = await fetch(`${base}/stream/film-1/360p`, { headers: { Range: "bytes=-9999" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 0-99/100");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 100);
});

test("stream: fayl topilmasa -> 404 JSON", async () => {
  const res = await fetch(`${base}/stream/film-1/720p`);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, "NOT_FOUND");
});

// ---------------------------------------------------------------------------
// saveStream (upload)
// ---------------------------------------------------------------------------
test("saveStream: Readable'ni faylga yozadi va hajmni qaytaradi", async () => {
  const objectKey = "movies/film-2/480p.mp4";
  const data = Buffer.from("salom dunyo 480p video");
  const req = Readable.from([data]);
  const result = await localStorage.saveStream(req, objectKey);
  assert.ok(result.ok);
  const st = await localStorage.stat(objectKey);
  assert.equal(st.size, data.length);
  assert.equal(fs.readFileSync(path.join(TMP, "film-2", "480p.mp4")).toString("utf8"), data.toString("utf8"));
});

// ---------------------------------------------------------------------------
// removeByMovieId — film o'chirilganda butun papka tozalanadi
// ---------------------------------------------------------------------------
test("removeByMovieId: barcha quality'lar o'chiriladi", async () => {
  assert.ok(await localStorage.removeByMovieId("film-1"));
  assert.ok(!localStorage.exists("movies/film-1/360p.mp4"));
  assert.ok(!localStorage.exists("movies/film-1/1080p.mp4"));
  assert.ok(!fs.existsSync(path.join(TMP, "film-1")));
  // Mavjud bo'lmagan film uchun ham xatosiz
  assert.ok(await localStorage.removeByMovieId("yoq-film"));
});
