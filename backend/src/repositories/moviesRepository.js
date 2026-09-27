// src/repositories/moviesRepository.js
// Filmlar bo'yicha barcha DB access logikasi + filtr/qidiruv (algoritm o'zgarmaydi).
// server.js bu repository orqali ishlaydi.

const { load, persist } = require("../db");

// Filtr qo'llangan film ro'yxati. Qidiruv algoritmi oldingi server.js'dagi
// kabi saqlanadi — o'zgartirilmaydi (Production V2 chegarasi).
// Pagination: page/limit berilsa qo'llanadi; berilmasa to'liq ro'yxat qaytadi
// (backward compatibility).
// status — standart "active" (ommaviy katalog). "hidden" bilan chaqirilganda
// (faqat parol tekshiruvidan o'tgan so'rovlarda, server.js tomonidan) yashirin
// filmlar qaytadi. Bundan oldin bu funksiya statusni umuman filtrlamas edi —
// bu "hidden"/"inactive" filmlarning ham ommaviy katalogda ko'rinishiga olib
// kelgan xato edi.
function list({ genre, q, yearMin, yearMax, ratingMin, sort, page, limit, status = "active" } = {}) {
  const db = load();
  let list = [...db.movies];

  if (status === "active" || status === "inactive" || status === "hidden") {
    list = list.filter((m) => m.status === status);
  }
  // Katta-kichik harf/bo'sh joyga sezgir emas — eski (erkin matn) janr
  // maydonidan qolgan mos kelmasliklarda ham film ko'rinmay qolmasligi uchun.
  if (genre) {
    const needleGenre = String(genre).trim().toLowerCase();
    list = list.filter((m) => m.genres.some((g) => String(g).trim().toLowerCase() === needleGenre));
  }
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((m) =>
      m.title.toLowerCase().includes(needle) ||
      m.originalTitle.toLowerCase().includes(needle) ||
      m.genres.some((g) => g.toLowerCase().includes(needle)) ||
      String(m.year).includes(needle)
    );
  }
  if (yearMin) {
    const y = Number(yearMin);
    if (y) list = list.filter((m) => m.year >= y);
  }
  if (yearMax) {
    const y = Number(yearMax);
    if (y) list = list.filter((m) => m.year <= y);
  }
  if (ratingMin) {
    const r = Number(ratingMin);
    if (r) list = list.filter((m) => m.rating >= r);
  }

  if (sort === "new") list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else if (sort === "rating") list.sort((a, b) => b.rating - a.rating);
  else if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title));

  return paginate(list, page, limit);
}

// Admin ro'yxati — title/originalTitle/year bo'yicha qidiruv va
// status (active|inactive|hidden) filtri (admin versiyasi).
function adminList({ q, genre, yearMin, yearMax, ratingMin, status, page, limit } = {}) {
  const db = load();
  let list = [...db.movies];

  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((m) =>
      m.title.toLowerCase().includes(needle) ||
      m.originalTitle.toLowerCase().includes(needle) ||
      String(m.year).includes(needle)
    );
  }
  // Katta-kichik harf/bo'sh joyga sezgir emas — eski (erkin matn) janr
  // maydonidan qolgan mos kelmasliklarda ham film ko'rinmay qolmasligi uchun.
  if (genre) {
    const needleGenre = String(genre).trim().toLowerCase();
    list = list.filter((m) => m.genres.some((g) => String(g).trim().toLowerCase() === needleGenre));
  }
  if (yearMin) list = list.filter((m) => m.year >= Number(yearMin));
  if (yearMax) list = list.filter((m) => m.year <= Number(yearMax));
  if (ratingMin) list = list.filter((m) => m.rating >= Number(ratingMin));
  if (status === "active" || status === "inactive" || status === "hidden") {
    list = list.filter((m) => m.status === status);
  }

  return paginate(list, page, limit);
}

function paginate(list, page, limit) {
  if (limit == null) return { movies: list, total: list.length, page: 1, totalPages: 1 };
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 50));
  const start = (pageNum - 1) * limitNum;
  const total = list.length;
  return {
    movies: list.slice(start, start + limitNum),
    total,
    page: pageNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum)),
  };
}

function getById(id) {
  const db = load();
  return db.movies.find((m) => m.id === id) || null;
}

function getByIds(ids) {
  const db = load();
  const set = new Set(ids);
  return db.movies.filter((m) => set.has(m.id));
}

function exists(id) {
  return load().movies.some((m) => m.id === id);
}

function count() {
  return load().movies.length;
}

// O'xshash filmlar — bitta umumiy janr bo'lsa yetarli, maks 6 ta.
function getSimilar(movie, limit = 6) {
  const db = load();
  return db.movies
    .filter((m) => m.id !== movie.id && m.genres.some((g) => movie.genres.includes(g)))
    .slice(0, limit);
}

// Yangi film yaratadi (id serverda generatsiya qilinadi, agar berilmasa).
// return { movie } | { conflict: true }
async function create(movieData) {
  const db = load();
  const id = movieData.id || movieData.title.toLowerCase()
    .replace(/[^a-z0-9а-яөүўқғҳжцәі]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) + "-" + require("crypto").randomBytes(3).toString("hex");

  if (db.movies.some((m) => m.id === id)) return { conflict: true };

  const now = new Date().toISOString();
  const movie = {
    id,
    title: String(movieData.title).trim(),
    originalTitle: movieData.originalTitle ? String(movieData.originalTitle).trim() : "",
    year: Number(movieData.year),
    genres: (movieData.genres || []).map((g) => String(g).trim()),
    rating: Math.max(0, Math.min(10, Number(movieData.rating) || 0)),
    duration: movieData.duration ? String(movieData.duration).trim() : "",
    description: movieData.description != null ? String(movieData.description) : "",
    poster: movieData.poster || "g0",
    posterUrl: movieData.posterUrl ? String(movieData.posterUrl) : "",
    backdropUrl: movieData.backdropUrl ? String(movieData.backdropUrl) : "",
    videoSources: movieData.videoSources || null,
    status: ["active", "inactive", "hidden"].includes(movieData.status) ? movieData.status : "active",
    featured: Boolean(movieData.featured),
    trending: Boolean(movieData.trending),
    trendingOrder: Number.isFinite(Number(movieData.trendingOrder)) ? Number(movieData.trendingOrder) : 0,
    trendingBannerUrl: movieData.trendingBannerUrl ? String(movieData.trendingBannerUrl) : "",
    isPremium: Boolean(movieData.isPremium),
    planIds: Array.isArray(movieData.planIds) ? movieData.planIds.map(String) : [],
    createdAt: now,
    updatedAt: now,
  };
  db.movies.unshift(movie);
  await persist();
  return { movie };
}

// Partial update — faqat berilgan maydonlar yangilanadi.
// return movie | null (film topilmasa)
async function update(id, patch) {
  const db = load();
  const movie = db.movies.find((m) => m.id === id);
  if (!movie) return null;

  const updatable = [
    "title", "originalTitle", "year", "genres", "rating", "duration",
    "description", "poster", "posterUrl", "backdropUrl", "videoSources",
    "status", "featured", "isPremium", "planIds", "trending", "trendingOrder", "trendingBannerUrl",
  ];
  for (const key of updatable) {
    if (patch[key] === undefined) continue;
    if (key === "genres" && Array.isArray(patch[key])) {
      movie[key] = patch[key].map((g) => String(g).trim());
    } else if (key === "rating") {
      movie[key] = Math.max(0, Math.min(10, Number(patch[key]) || 0));
    } else if (key === "year") {
      movie[key] = Number(patch[key]);
    } else if (key === "featured" || key === "trending" || key === "isPremium") {
      movie[key] = Boolean(patch[key]);
    } else if (key === "planIds" && Array.isArray(patch[key])) {
      movie[key] = patch[key].map(String);
    } else if (key === "trendingOrder") {
      movie[key] = Number.isFinite(Number(patch[key])) ? Number(patch[key]) : 0;
    } else if (key !== "videoSources") {
      movie[key] = String(patch[key] ?? "");
    } else {
      movie[key] = patch[key];
    }
  }
  movie.updatedAt = new Date().toISOString();
  await persist();
  return movie;
}

// O'chirish — faqat status belgilash emas, to'liq o'chirish.
// return movie | null
async function remove(id) {
  const db = load();
  const idx = db.movies.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const [removed] = db.movies.splice(idx, 1);
  await persist();
  return removed;
}

// -- R2 video manbalari -----------------------------------------------
// videoSources formati:
//   eski:   { url: "https://..." }  yoki  [{url, quality}]
//   R2:     { "720p": { objectKey, size, uploadedAt }, "1080p": {...} }
// Eski `url` manbasi saqlanadi — yangi quality key'lari qo'shiladi.

// Video manbasini bog'laydi (upload tugagach). return movie | null.
async function attachVideo(id, quality, { objectKey, size, storageType }) {
  const db = load();
  const movie = db.movies.find((m) => m.id === id);
  if (!movie) return null;
  let vs = {};
  if (movie.videoSources && typeof movie.videoSources === "object" && !Array.isArray(movie.videoSources)) {
    vs = { ...movie.videoSources };
  }
  vs[quality] = {
    objectKey,
    size: Math.max(0, Number(size) || 0),
    uploadedAt: new Date().toISOString(),
    ...(storageType ? { storageType } : {}),
  };
  movie.videoSources = vs;
  movie.updatedAt = new Date().toISOString();
  await persist();
  return movie;
}

// Video manbasini olib tashlaydi (R2 objecti ham o'chiriladi). return movie | null.
async function detachVideo(id, quality) {
  const db = load();
  const movie = db.movies.find((m) => m.id === id);
  if (!movie) return null;
  if (movie.videoSources && typeof movie.videoSources === "object" && movie.videoSources[quality]) {
    delete movie.videoSources[quality];
    movie.updatedAt = new Date().toISOString();
    await persist();
  }
  return movie;
}

// R2 object key'lari ro'yxati (film o'chirilganda cleanup uchun).
function listVideoKeys(movie) {
  if (!movie || !movie.videoSources || typeof movie.videoSources !== "object" || Array.isArray(movie.videoSources)) {
    return [];
  }
  return Object.values(movie.videoSources)
    .filter((v) => v && typeof v.objectKey === "string")
    .map((v) => v.objectKey);
}

module.exports = {
  list,
  adminList,
  getById,
  getByIds,
  exists,
  count,
  getSimilar,
  create,
  update,
  remove,
  attachVideo,
  detachVideo,
  listVideoKeys,
};
