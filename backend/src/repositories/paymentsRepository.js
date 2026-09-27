// src/repositories/paymentsRepository.js
// To'lovlar bo'yicha barcha DB access logikasi.

const { load, persist } = require("../db");
const crypto = require("crypto");
const { getPlanById } = require("./plansRepository");

// Yangi to'lov yaratish
// return payment
async function createPayment(userId, plan, checkImageData) {
  const db = load();
  const planData = getPlanById(plan);
  if (!planData) {
    throw new Error("PLAN_NOT_FOUND");
  }
  const id = "pay_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();

  const payment = {
    id,
    userId: String(userId),
    plan,
    amount: planData.price,
    status: "pending",
    checkImageData,
    createdAt: now,
    reviewedAt: null,
    reviewedBy: null,
  };

  db.payments[id] = payment;
  await persist();
  return payment;
}

// To'lovni olish
function getPayment(id) {
  const db = load();
  return db.payments[id] || null;
}

// Foydalanuvchining to'lovlari ro'yxati
function getUserPayments(userId) {
  const db = load();
  return Object.values(db.payments)
    .filter(p => p.userId === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Barcha to'lovlar ro'yxati (admin uchun)
function listPayments(filter = {}) {
  const db = load();
  let payments = Object.values(db.payments);

  if (filter.status) {
    payments = payments.filter(p => p.status === filter.status);
  }

  return payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// To'lovni tasdiqlash
async function approvePayment(paymentId, adminId) {
  const db = load();
  const payment = db.payments[paymentId];
  if (!payment) return null;
  if (payment.status !== "pending") return null;

  // Foydalanuvchi hali DB'da yo'q bo'lsa (masalan hech qachon /api/profile
  // chaqirilmagan holat) — jim muvaffaqiyat qaytarish o'rniga aniq xato
  // beramiz, aks holda to'lov "approved" bo'lib qoladi-yu, Premium hech
  // qachon berilmaydi (aniqlash qiyin bo'lgan jim xato).
  const user = db.users[payment.userId];
  if (!user) {
    return { error: "USER_NOT_FOUND" };
  }

  const planData = getPlanById(payment.plan);
  if (!planData) {
    return { error: "PLAN_NOT_FOUND" };
  }

  payment.status = "approved";
  payment.reviewedAt = new Date().toISOString();
  payment.reviewedBy = String(adminId);

  // Foydalanuvchiga premium berish. Agar hozir ham faol Premium bo'lsa
  // (masalan muddati tugashiga bir necha kun qolgan bo'lsa-yu, foydalanuvchi
  // yangi paket sotib olsa), yangi muddat "hozirdan" emas — QOLGAN muddat
  // tugagan joydan boshlab qo'shiladi. Avval har doim "hozirdan" hisoblanardi
  // — bu foydalanuvchining muddati tugamagan kunlarini yo'qotib qo'yardi.
  {
    const now = Date.now();
    const currentExpiresAt = user.premium && user.premium.expiresAt
      ? new Date(user.premium.expiresAt).getTime()
      : 0;
    const startFrom = currentExpiresAt > now ? currentExpiresAt : now;
    const duration = planData.durationDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(startFrom + duration).toISOString();

    user.premium = {
      status: "active",
      plan: payment.plan,
      expiresAt,
      activatedAt: (user.premium && user.premium.activatedAt) || new Date().toISOString(),
    };
    user.updatedAt = new Date().toISOString();
  }

  await persist();
  return payment;
}

// To'lovni rad etish
async function rejectPayment(paymentId, adminId) {
  const db = load();
  const payment = db.payments[paymentId];
  if (!payment) return null;
  if (payment.status !== "pending") return null;

  payment.status = "rejected";
  payment.reviewedAt = new Date().toISOString();
  payment.reviewedBy = String(adminId);

  await persist();
  return payment;
}

// Kutilayotgan to'lovlar soni
function countPendingPayments() {
  const db = load();
  return Object.values(db.payments).filter(p => p.status === "pending").length;
}

// To'lov statistikasi
function getPaymentStats() {
  const db = load();
  const payments = Object.values(db.payments);
  return {
    total: payments.length,
    pending: payments.filter(p => p.status === "pending").length,
    approved: payments.filter(p => p.status === "approved").length,
    rejected: payments.filter(p => p.status === "rejected").length,
    totalAmount: payments.filter(p => p.status === "approved").reduce((sum, p) => sum + p.amount, 0),
  };
}

module.exports = {
  createPayment,
  getPayment,
  getUserPayments,
  listPayments,
  approvePayment,
  rejectPayment,
  countPendingPayments,
  getPaymentStats,
};
