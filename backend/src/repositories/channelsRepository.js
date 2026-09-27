// src/repositories/channelsRepository.js
// Majburiy obuna kanallari — admin panelda qo'shiladi/o'chiriladi.
// Webapp ochilganda foydalanuvchi shu kanallarga obuna bo'lganligi
// tekshiriladi (server.js -> checkSubscription, Telegram getChatMember).

const crypto = require("crypto");
const { load, persist } = require("../db");

function ensureList(db) {
  if (!db.settings || typeof db.settings !== "object" || Array.isArray(db.settings)) {
    db.settings = {};
  }
  if (!Array.isArray(db.settings.requiredChannels)) {
    db.settings.requiredChannels = [];
  }
  return db.settings.requiredChannels;
}

// Barcha majburiy kanallar (admin va public foydalanish uchun).
function listChannels() {
  const db = load();
  return ensureList(db).slice();
}

// chatId — Telegram getChatMember uchun ishlatiladigan qiymat: "@username"
// yoki "-100xxxxxxxxxx" ko'rinishida bo'lishi kerak.
function normalizeChatId(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("@")) return v;
  if (/^-?\d+$/.test(v)) return v;
  // "username" (@ siz kiritilgan bo'lsa) -> @username qilib tuzatamiz.
  if (/^[a-zA-Z0-9_]{5,32}$/.test(v)) return `@${v}`;
  return v;
}

// Yangi kanal qo'shadi. chatId majburiy (getChatMember uchun kerak).
// inviteLink — foydalanuvchiga ko'rsatiladigan "obuna bo'lish" havolasi
// (public kanal bo'lsa avtomatik https://t.me/username quriladi).
async function addChannel({ chatId, title, inviteLink }) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return { error: "chatId majburiy (@username yoki -100xxxxxxxxxx)" };
  }
  const db = load();
  const list = ensureList(db);
  if (list.some((c) => c.chatId === normalizedChatId)) {
    return { conflict: true };
  }
  const link =
    inviteLink && String(inviteLink).trim()
      ? String(inviteLink).trim()
      : normalizedChatId.startsWith("@")
        ? `https://t.me/${normalizedChatId.slice(1)}`
        : "";
  const channel = {
    id: "ch_" + crypto.randomBytes(6).toString("hex"),
    chatId: normalizedChatId,
    title: title ? String(title).trim().slice(0, 200) : normalizedChatId,
    inviteLink: link,
    addedAt: new Date().toISOString(),
  };
  list.push(channel);
  await persist();
  return { channel };
}

async function removeChannel(id) {
  const db = load();
  const list = ensureList(db);
  const idx = list.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  await persist();
  return true;
}

module.exports = { listChannels, addChannel, removeChannel, normalizeChatId };
