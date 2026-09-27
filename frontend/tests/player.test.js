// frontend/tests/player.test.js
// KinoBotPlayer (frontend/js/player.js) uchun testlar.
// Video element va DOM minimal stub bilan simulyatsiya qilinadi:
//   - resolveSources: {url} / {url,quality} / massiv / .m3u8 / .mpd normalizatsiyasi
//   - load: progressive src o'rnatish, manba yo'q bo'lsa empty holat
//   - qualities() / setQuality(): sifatlar ro'yxati va almashish
//   - resume: loadedmetadata da positionSeconds'dan davom ettirish
//   - progress debounce: 5s/10s qoidasi bilan onProgress chaqirilishi

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

require(path.join(__dirname, "helpers", "domStub.js"));

const PLAYER_JS = path.join(__dirname, "..", "js", "player.js");

// --- video element stub ---
function makeVideo() {
  return {
    hidden: true,
    src: "",
    paused: true,
    duration: 0,
    currentTime: 0,
    onloadedmetadata: null,
    ontimeupdate: null,
    onended: null,
    _played: 0,
    play() { this.paused = false; this._played++; return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute(attr) { if (attr === "src") this.src = ""; },
    canPlayType() { return ""; }, // default: HLS native yo'q
  };
}

function makeQualityEl() {
  return { hidden: true, innerHTML: "" };
}

// document stub — faqat player moduli ishlatadigan qismlar.
function installDocument() {
  global.document = {
    _nodes: {},
    getElementById(id) {
      if (!this._nodes[id]) {
        this._nodes[id] = { style: {}, hidden: true, innerHTML: "" };
      }
      return this._nodes[id];
    },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), src: "", onload: null, onerror: null };
    },
    head: { appendChild() {} },
  };
  return global.document;
}

// Promise zanjiridagi .then() callback'larini kutadi (progressive src
// sinxron, ammo _renderQuality/setQuality mikrotask'da ishlaydi).
async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

// player.js'ni toza yuklaydi va { player, video, qualityEl } qaytaradi.
function freshPlayer(opts = {}) {
  delete require.cache[require.resolve(PLAYER_JS)];
  require(PLAYER_JS);
  const player = global.window.KinoBotPlayer;
  const video = opts.video || makeVideo();
  const qualityEl = opts.qualityEl || makeQualityEl();
  player.init(video, qualityEl);
  return { player, video, qualityEl };
}

// --- resolveSources ---
test("resolveSources: {url} -> bitta progressive/Auto manba", () => {
  const { player } = freshPlayer();
  const s = player.resolveSources({ url: "https://x.test/v.mp4" });
  assert.equal(s.length, 1);
  assert.equal(s[0].url, "https://x.test/v.mp4");
  assert.equal(s[0].type, "progressive");
  assert.equal(s[0].label, "Auto");
});

test("resolveSources: {url, quality} va massiv sifatlar", () => {
  const { player } = freshPlayer();
  const one = player.resolveSources({ url: "https://x.test/a.mp4", quality: "1080p" });
  assert.equal(one[0].label, "1080p");

  const many = player.resolveSources([
    { url: "https://x.test/720.mp4", quality: "720p" },
    { url: "https://x.test/1080.mp4", quality: "1080p" },
  ]);
  assert.equal(many.length, 2);
  assert.equal(many[0].label, "720p");
  assert.equal(many[1].label, "1080p");
});

test("resolveSources: .m3u8 -> hls, .mpd -> dash", () => {
  const { player } = freshPlayer();
  const hls = player.resolveSources({ url: "https://x.test/master.m3u8" });
  assert.equal(hls[0].type, "hls");
  const dash = player.resolveSources({ url: "https://x.test/stream.mpd?x=1" });
  assert.equal(dash[0].type, "dash");
});

test("resolveSources: null / bo'sh / noto'g'ri -> []", () => {
  const { player } = freshPlayer();
  assert.deepEqual(player.resolveSources(null), []);
  assert.deepEqual(player.resolveSources({}), []);
  assert.deepEqual(player.resolveSources({ url: "" }), []);
  assert.deepEqual(player.resolveSources([{ url: "" }, { url: "https://x/v.mp4" }]).length, 1);
});

// --- load / progressive ---
test("load: progressive src o'rnatiladi, video ko'rsatiladi", () => {
  const { player, video } = freshPlayer();
  const loaded = player.load({ id: "m1", videoSources: { url: "https://x.test/v.mp4" } }, {});
  assert.equal(loaded, true);
  assert.equal(video.hidden, false);
  assert.equal(video.src, "https://x.test/v.mp4");
});

test("load: manba yo'q bo'lsa false qaytadi va video yashiriladi", () => {
  installDocument();
  const { player, video } = freshPlayer();
  const loaded = player.load({ id: "m2", videoSources: null }, {});
  assert.equal(loaded, false);
  assert.equal(video.hidden, true);
});

test("load: bitta manba bo'lsa quality chip yashirin", () => {
  const { player, video, qualityEl } = freshPlayer();
  player.load({ id: "m3", videoSources: { url: "https://x.test/v.mp4" } }, {});
  assert.equal(qualityEl.hidden, true);
});

// --- hls ---
test("load: .m3u8 + native HLS -> video.src orqali", () => {
  const video = makeVideo();
  video.canPlayType = () => "maybe";
  const { player } = freshPlayer({ video });
  player.load({ id: "m4", videoSources: { url: "https://x.test/master.m3u8" } }, {});
  assert.equal(video.src, "https://x.test/master.m3u8");
});

test("load: .m3u8 + hls.js -> Hls instanciasi ishlatiladi", async () => {
  const calls = [];
  global.window.Hls = class MockHls {
    constructor() { this.calls = []; }
    loadSource(url) { calls.push(["loadSource", url]); }
    attachMedia(video) { calls.push(["attachMedia", video]); }
    destroy() { calls.push(["destroy"]); }
  };
  const video = makeVideo(); // canPlayType -> "" (native yo'q)
  const { player } = freshPlayer({ video });
  player.load({ id: "m5", videoSources: { url: "https://x.test/master.m3u8" } }, {});
  await tick();
  assert.ok(calls.some((c) => c[0] === "loadSource"));
  assert.equal(video.src, ""); // src o'rnatilmaydi, hls.js boshqaradi
  delete global.window.Hls;
});

// --- qualities / setQuality ---
test("qualities: barcha sifatlar label + active flag bilan", () => {
  const { player } = freshPlayer();
  player.load({ id: "m6", videoSources: [
    { url: "https://x.test/720.mp4", quality: "720p" },
    { url: "https://x.test/1080.mp4", quality: "1080p" },
  ] }, {});
  const q = player.qualities();
  assert.equal(q.length, 2);
  assert.equal(q[0].label, "720p");
  assert.equal(q[0].active, true);
  assert.equal(q[1].active, false);
});

test("setQuality: pozitsiyani saqlab boshqa manbaga o'tadi", async () => {
  const { player, video, qualityEl } = freshPlayer();
  player.load({ id: "m7", videoSources: [
    { url: "https://x.test/720.mp4", quality: "720p" },
    { url: "https://x.test/1080.mp4", quality: "1080p" },
  ] }, {});
  video.currentTime = 500;
  player.setQuality(1);
  await tick();
  assert.equal(video.src, "https://x.test/1080.mp4");
  assert.equal(video.currentTime, 500);
  assert.equal(player.qualities()[1].active, true);
  assert.ok(qualityEl.innerHTML.includes("1080p"));
  assert.ok(qualityEl.innerHTML.includes("active"));
});

// --- resume ---
test("resume: loadedmetadata da resumeAt pozitsiyasiga o'tadi", () => {
  const { player, video } = freshPlayer();
  player.load({ id: "m8", videoSources: { url: "https://x.test/v.mp4" } }, { resumeAt: 120 });
  video.duration = 600;
  assert.equal(video.currentTime, 0); // hali metadata yo'q
  video.onloadedmetadata(); // metadata keldi
  assert.equal(video.currentTime, 120);
  assert.equal(video._played, 1);
});

test("resume: resumeAt 0 bo'lsa boshidan o'ynaydi", () => {
  const { player, video } = freshPlayer();
  player.load({ id: "m9", videoSources: { url: "https://x.test/v.mp4" } }, { resumeAt: 0 });
  video.duration = 600;
  video.onloadedmetadata();
  assert.equal(video.currentTime, 0);
});

// --- progress debounce ---
test("progress: 5s/10s debounce qoidasi bilan onProgress chaqiriladi", () => {
  const calls = [];
  const { player, video } = freshPlayer();
  player.load({ id: "m10", videoSources: { url: "https://x.test/v.mp4" } }, {
    onProgress: (pct, pos) => calls.push([pct, pos]),
  });
  video.duration = 600;

  // 30s -> pct=5 (30/600), first save (lastSaveAt=0 -> yetarli vaqt o'tgan)
  video.currentTime = 30;
  player.lastPos = 0;
  player.lastSaveAt = 0;
  video.ontimeupdate();
  assert.deepEqual(calls, [[5, 30]]);

  // 31s -> delta <5 -> chaqirilmaydi
  video.currentTime = 31;
  video.ontimeupdate();
  assert.equal(calls.length, 1);

  // 45s -> delta 14 >=5, vaqt o'tgan -> chaqiriladi (pct=8)
  video.currentTime = 45;
  player.lastSaveAt = 0;
  video.ontimeupdate();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [8, 45]);
});

test("progress: oxirgi saqlashdan 10s o'tmagan bo'lsa chaqirilmaydi", () => {
  const calls = [];
  const { player, video } = freshPlayer();
  player.load({ id: "m11", videoSources: { url: "https://x.test/v.mp4" } }, {
    onProgress: (pct, pos) => calls.push([pct, pos]),
  });
  video.duration = 600;
  player.lastPos = 0;
  player.lastSaveAt = Date.now(); // hozirgina saqlandi
  video.currentTime = 60;
  video.ontimeupdate();
  assert.equal(calls.length, 0);
});

test("onended: callback chaqiriladi", () => {
  let ended = 0;
  const { player, video } = freshPlayer();
  player.load({ id: "m12", videoSources: { url: "https://x.test/v.mp4" } }, { onEnded: () => ended++ });
  video.onended();
  assert.equal(ended, 1);
});
