// backend/tests/analytics.test.js
// AnalyticsRepository testlari: getStats, countEvents, mostWatched, dailyActivity

"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
let originalDb = null;

function backupDb() {
  if (fs.existsSync(DB_PATH)) {
    originalDb = fs.readFileSync(DB_PATH, "utf-8");
  }
}

function restoreDb() {
  if (originalDb !== null) {
    fs.writeFileSync(DB_PATH, originalDb, "utf-8");
    originalDb = null;
  }
}

function loadTestDb() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  return db;
}

beforeEach(() => {
  backupDb();
  // Minimal test DB
  const db = {
    movies: [
      { id: "m1", title: "Film 1", genres: ["Drama"], year: 2020, rating: 7.5 },
      { id: "m2", title: "Film 2", genres: ["Action"], year: 2021, rating: 8.0 },
    ],
    genres: ["Drama", "Action"],
    users: [
      { id: "u1", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "ACTIVE" },
      { id: "u2", createdAt: new Date(Date.now() - 86400000 * 5).toISOString(), lastSeenAt: new Date().toISOString(), status: "ACTIVE" },
      { id: "u3", createdAt: new Date(Date.now() - 86400000 * 10).toISOString(), lastSeenAt: new Date(Date.now() - 86400000 * 2).toISOString(), status: "BLOCKED" },
    ],
    favorites: { u1: ["m1"], u2: ["m2"] },
    history: { u1: [{ movieId: "m1", progressPct: 50 }], u2: [{ movieId: "m2", progressPct: 100 }] },
    analytics: {
      days: {
        [new Date().toISOString().slice(0, 10)]: { playbackStarted: 5, movieOpened: 10 },
        [new Date(Date.now() - 86400000).toISOString().slice(0, 10)]: { playbackStarted: 3, movieOpened: 7 },
      },
      moviePlays: {
        m1: { count: 5, lastPlayedAt: new Date().toISOString() },
        m2: { count: 3, lastPlayedAt: new Date().toISOString() },
      },
    },
    admin: { key: "test-key", auditLog: [] },
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  // Clear require cache to reload with new data
  delete require.cache[require.resolve("../src/db")];
  delete require.cache[require.resolve("../src/repositories/analyticsRepository")];
  delete require.cache[require.resolve("../src/repositories/usersRepository")];
});

afterEach(() => {
  restoreDb();
});

test("getStats: umumiy statistikani qaytaradi", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats({ days: 7 });

  assert.equal(stats.period, "7d");
  assert.equal(stats.totalMovies, 2);
  assert.equal(stats.totalGenres, 2);
  assert.ok(typeof stats.totalUsers === "number");
  assert.ok(typeof stats.activeUsers === "number");
  assert.ok(typeof stats.blockedUsers === "number");
  assert.ok(typeof stats.totalFavorites === "number");
  assert.ok(typeof stats.totalHistory === "number");
});

test("getStats: days=null barcha davr uchun", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats({ days: null });

  assert.equal(stats.period, "all");
  assert.ok(stats.events);
});

test("getStats: events obyekti to'g'ri hisoblanadi", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats({ days: 7 });

  assert.ok(typeof stats.events.playbackStarted === "number");
  assert.ok(typeof stats.events.movieOpened === "number");
  assert.ok(stats.events.playbackStarted >= 0);
});

test("getStats: mostWatched massiv qaytaradi", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats();

  assert.ok(Array.isArray(stats.mostWatched));
  assert.ok(stats.mostWatched.length <= 5);
  if (stats.mostWatched.length > 0) {
    assert.ok("movieId" in stats.mostWatched[0]);
    assert.ok("count" in stats.mostWatched[0]);
  }
});

test("getStats: mostWatched tartibi count bo'yicha kamayuvchi", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats();
  const mw = stats.mostWatched;

  for (let i = 1; i < mw.length; i++) {
    assert.ok(mw[i - 1].count >= mw[i].count, "mostWatched kamayuvchi tartibda emas");
  }
});

test("getStats: dailyActivity massiv qaytaradi", () => {
  const { getStats } = require("../src/repositories/analyticsRepository");
  const stats = getStats({ days: 7 });

  assert.ok(Array.isArray(stats.dailyActivity));
  assert.ok(stats.dailyActivity.length <= 7);
  if (stats.dailyActivity.length > 0) {
    assert.ok("date" in stats.dailyActivity[0]);
    assert.ok("events" in stats.dailyActivity[0]);
  }
});

test("countEvents: event sonini to'g'ri hisoblaydi", () => {
  const { countEvents } = require("../src/repositories/analyticsRepository");
  const count = countEvents("playbackStarted", 7);

  assert.ok(typeof count === "number");
  assert.ok(count >= 0);
});
