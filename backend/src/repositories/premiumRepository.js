// src/repositories/premiumRepository.js
// Premium holatni boshqarish logikasi.

const { load, persist } = require("../db");
const { getPlans, getPlanById } = require("./plansRepository");

// Foydalanuvchi premium holatini olish
function getPremiumStatus(userId) {
  const db = load();
  const user = db.users[String(userId)];
  if (!user) return { status: "free", plan: null, expiresAt: null, isActive: false };

  const premium = user.premium || { status: "free", plan: null, expiresAt: null };

  // Muddati o'tgan bo'lsa, free qilish
  if (premium.status === "active" && premium.expiresAt) {
    const expiresAt = new Date(premium.expiresAt).getTime();
    if (expiresAt < Date.now()) {
      return { status: "free", plan: null, expiresAt: null, isActive: false, expired: true };
    }
    return { ...premium, isActive: true };
  }

  return { ...premium, isActive: false };
}

// Premium aktivmi?
function isPremiumActive(userId) {
  const status = getPremiumStatus(userId);
  return status.isActive === true;
}

// Premium muddatini yangilash (admin tomonidan)
async function extendPremium(userId, plan, durationDays) {
  const db = load();
  const user = db.users[String(userId)];
  if (!user) return null;

  const now = Date.now();
  const currentExpires = user.premium?.expiresAt ? new Date(user.premium.expiresAt).getTime() : 0;
  const startFrom = currentExpires > now ? currentExpires : now;
  const expiresAt = new Date(startFrom + durationDays * 24 * 60 * 60 * 1000).toISOString();

  user.premium = {
    status: "active",
    plan,
    expiresAt,
    activatedAt: user.premium?.activatedAt || new Date().toISOString(),
  };
  user.updatedAt = new Date().toISOString();

  await persist();
  return user.premium;
}

// Premium ni bekor qilish
async function revokePremium(userId) {
  const db = load();
  const user = db.users[String(userId)];
  if (!user) return null;

  user.premium = { status: "free", plan: null, expiresAt: null, activatedAt: null };
  user.updatedAt = new Date().toISOString();

  await persist();
  return user;
}

// Muddati o'tgan premiumlarni tozalash (cron job uchun)
async function expirePremiumUsers() {
  const db = load();
  const now = Date.now();
  let expiredCount = 0;

  for (const user of Object.values(db.users)) {
    if (user.premium?.status === "active" && user.premium?.expiresAt) {
      const expiresAt = new Date(user.premium.expiresAt).getTime();
      if (expiresAt < now) {
        user.premium = { status: "free", plan: null, expiresAt: null, activatedAt: null };
        user.updatedAt = new Date().toISOString();
        expiredCount++;
      }
    }
  }

  if (expiredCount > 0) {
    await persist();
  }

  return expiredCount;
}

// Premium foydalanuvchilar soni
function countPremiumUsers() {
  const db = load();
  return Object.values(db.users).filter(u => isPremiumActive(u.id)).length;
}

// Karta ma'lumotlarini olish
function getPaymentSettings() {
  const db = load();
  const settings = db.settings?.paymentSettings;
  if (!settings || typeof settings !== "object") {
    return { cardNumber: "", cardHolder: "" };
  }
  return {
    cardNumber: settings.cardNumber || "",
    cardHolder: settings.cardHolder || "",
  };
}

// Karta ma'lumotlarini saqlash
async function savePaymentSettings(cardNumber, cardHolder) {
  const db = load();
  db.settings = db.settings || {};
  db.settings.paymentSettings = {
    cardNumber: String(cardNumber || ""),
    cardHolder: String(cardHolder || ""),
    updatedAt: new Date().toISOString(),
  };
  await persist();
  return db.settings.paymentSettings;
}

// Premium paketlar ro'yxati (foydalanuvchi interfeysi uchun) — dynamic from settings
function getPremiumPlans() {
  return getPlans().map((p) => ({
    id: p.id,
    name: p.name,
    duration: p.durationDays,
    price: p.price,
  }));
}

module.exports = {
  getPremiumPlans,
  getPremiumStatus,
  isPremiumActive,
  extendPremium,
  revokePremium,
  expirePremiumUsers,
  countPremiumUsers,
  getPaymentSettings,
  savePaymentSettings,
};
