// src/repositories/contactRepository.js
// "Biz bilan bog'lanish" bo'limi orqali yuborilgan xabarlar bo'yicha DB access.
// Bu bloklash ("blockedContactUsers") faqat aloqa formasidan foydalanishga
// ta'sir qiladi — botning umumiy ishlatilishiga (users.isBlocked) tegmaydi.

const { load, persist } = require("../db");
const crypto = require("crypto");

// Yangi aloqa xabari yaratish
// return message
async function createMessage({ userId, userName, username, text }) {
  const db = load();
  const id = "msg_" + crypto.randomBytes(8).toString("hex");
  const now = new Date().toISOString();

  const message = {
    id,
    userId: String(userId),
    userName: userName != null ? String(userName) : "",
    username: username != null ? String(username) : "",
    text: String(text || "").slice(0, 2000),
    createdAt: now,
    status: "new", // new | read
  };

  db.contactMessages.push(message);
  await persist();
  return message;
}

// Xabarlar ro'yxati (admin uchun), eng yangisi birinchi
function listMessages({ page, limit } = {}) {
  const db = load();
  const sorted = [...db.contactMessages].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  if (!page && !limit) return { messages: sorted, total: sorted.length, page: 1, totalPages: 1 };
  const p = Math.max(1, Number(page) || 1);
  const l = Math.max(1, Math.min(100, Number(limit) || 20));
  const start = (p - 1) * l;
  return {
    messages: sorted.slice(start, start + l),
    total: sorted.length,
    page: p,
    totalPages: Math.max(1, Math.ceil(sorted.length / l)),
  };
}

// Xabarni "o'qilgan" deb belgilash
async function markRead(id) {
  const db = load();
  const msg = db.contactMessages.find((m) => m.id === id);
  if (!msg) return null;
  msg.status = "read";
  await persist();
  return msg;
}

// O'qilmagan xabarlar soni (admin badge uchun)
function countUnread() {
  const db = load();
  return db.contactMessages.filter((m) => m.status === "new").length;
}

// ---- Aloqa formasidan bloklash (faqat shu forma uchun) ----
function isContactBlocked(userId) {
  const db = load();
  return db.blockedContactUsers.includes(String(userId));
}

async function blockContactUser(userId) {
  const db = load();
  const id = String(userId);
  if (!db.blockedContactUsers.includes(id)) db.blockedContactUsers.push(id);
  await persist();
  return true;
}

async function unblockContactUser(userId) {
  const db = load();
  const id = String(userId);
  db.blockedContactUsers = db.blockedContactUsers.filter((x) => x !== id);
  await persist();
  return true;
}

function listBlockedContactUsers() {
  const db = load();
  return db.blockedContactUsers.slice();
}

module.exports = {
  createMessage,
  listMessages,
  markRead,
  countUnread,
  isContactBlocked,
  blockContactUser,
  unblockContactUser,
  listBlockedContactUsers,
};
