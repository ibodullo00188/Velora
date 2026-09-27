// src/repositories/plansRepository.js
// Premium paketlar va kino-bog'lanishini boshqarish.

const { load, persist } = require("../db");
const crypto = require("crypto");

// Lazy require to avoid circular dependency
function getMoviesRepo() {
  return require("./moviesRepository");
}

// Default paketlar (settings.plans bo'sh bo'lsa fallback)
const DEFAULT_PLANS = [
  { id: "1month", name: "1 oy", durationDays: 30, price: 50000, movieIds: [], isActive: true },
  { id: "3months", name: "3 oy", durationDays: 90, price: 120000, movieIds: [], isActive: true },
  { id: "1year", name: "1 yil", durationDays: 365, price: 400000, movieIds: [], isActive: true },
];

// Settings ichidan plans array'ni olish (agar yo'q bo'lsa default)
function getPlansFromSettings() {
  const db = load();
  const plans = db.settings?.plans;
  if (Array.isArray(plans) && plans.length > 0) {
    return plans;
  }
  // Initialize settings.plans with defaults if empty
  const defaults = DEFAULT_PLANS.map((p, i) => ({ ...p, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  db.settings = db.settings || {};
  db.settings.plans = defaults;
  // Don't persist here - will be persisted on next write
  return defaults;
}

// Barcha faol paketlar
function getPlans() {
  return getPlansFromSettings().filter((p) => p.isActive !== false);
}

// Barcha paketlar (admin uchun, nofaqollar ham)
function getAllPlans() {
  return getPlansFromSettings();
}

// Bitta paketni ID bo'yicha topish
function getPlanById(id) {
  const plans = getPlansFromSettings();
  return plans.find((p) => p.id === id) || null;
}

// Yangi paket yaratish
async function createPlan(data) {
  const db = load();
  db.settings = db.settings || {};
  db.settings.plans = db.settings.plans || [];

  const id = data.id || "plan_" + crypto.randomBytes(6).toString("hex");
  const now = new Date().toISOString();

  const plan = {
    id,
    name: String(data.name || "").trim(),
    durationDays: Number(data.durationDays) || 30,
    price: Number(data.price) || 0,
    movieIds: Array.isArray(data.movieIds) ? data.movieIds.map(String) : [],
    isActive: data.isActive !== false,
    createdAt: now,
    updatedAt: now,
  };

  db.settings.plans.push(plan);
  await persist();
  return plan;
}

// Paket yangilash (partial update)
async function updatePlan(id, data) {
  const db = load();
  db.settings = db.settings || {};
  db.settings.plans = db.settings.plans || [];

  const idx = db.settings.plans.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const plan = db.settings.plans[idx];
  if (data.name !== undefined) plan.name = String(data.name).trim();
  if (data.durationDays !== undefined) plan.durationDays = Number(data.durationDays);
  if (data.price !== undefined) plan.price = Number(data.price);
  if (data.movieIds !== undefined) plan.movieIds = Array.isArray(data.movieIds) ? data.movieIds.map(String) : [];
  if (data.isActive !== undefined) plan.isActive = Boolean(data.isActive);
  plan.updatedAt = new Date().toISOString();

  await persist();
  return plan;
}

// Paket o'chirish (soft delete: isActive=false)
async function deletePlan(id) {
  return updatePlan(id, { isActive: false });
}

// Paketga kinolar biriktirish (movieIds array'ni to'liq almashtiradi)
async function assignMoviesToPlan(planId, movieIds) {
  return updatePlan(planId, { movieIds: Array.isArray(movieIds) ? movieIds.map(String) : [] });
}

// Paketga tegishli kinolar ro'yxati
function getMoviesForPlan(planId) {
  const plan = getPlanById(planId);
  if (!plan) return [];
  return plan.movieIds || [];
}

// Kino uchun mos keluvchi paketlar
function getPlansForMovie(movieId) {
  const plans = getPlans(); // faqat faol
  return plans.filter((p) => {
    const ids = p.movieIds || [];
    return ids.length === 0 || ids.includes(String(movieId));
  });
}

// Foydalanuvchining paketi kino uchun mos keladimi?
function validatePlanCoversMovie(planId, movieId) {
  const plan = getPlanById(planId);
  if (!plan) return false;

  // First check: movie.planIds (movie-level assignment - if movie specifies plans, only those work)
  const moviesRepo = getMoviesRepo();
  const movie = moviesRepo.getById(movieId);
  if (movie && Array.isArray(movie.planIds) && movie.planIds.length > 0) {
    return movie.planIds.includes(String(planId));
  }

  // Second check: plan.movieIds (plan-level assignment)
  const ids = plan.movieIds || [];
  if (ids.length === 0) return true; // Empty = all premium movies
  return ids.includes(String(movieId));
}

// Statistika: har bir paket uchun kino soni
function getPlanStats() {
  const plans = getAllPlans();
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    movieCount: (p.movieIds || []).length,
    isActive: p.isActive !== false,
  }));
}

module.exports = {
  DEFAULT_PLANS,
  getPlans,
  getAllPlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  assignMoviesToPlan,
  getMoviesForPlan,
  getPlansForMovie,
  validatePlanCoversMovie,
  getPlanStats,
};