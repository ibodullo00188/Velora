// src/mtproto.js
// Telegram MTProto klienti (GramJS) — Bot API'dan farqli, MTProto orqali
// ulanadi. Sabab: Bot API'da fayl yuklab olish 20MB bilan cheklangan,
// MTProto'da bunday cheklov yo'q (katta video fayllarni strim qilish /
// kanaldan-kanalga nusxalash uchun shu kerak).
//
// Bot TOKEN bilan MTProto'ga kiradi (client.start({ botAuthToken })) —
// alohida telefon raqami / login kodi kerak emas, faqat qo'shimcha
// TELEGRAM_API_ID va TELEGRAM_API_HASH (my.telegram.org'dan, bepul,
// istalgan Telegram akkauntga tegishli bo'lishi mumkin — bu shunchaki
// "ilova" identifikatori, alohida user login emas).
//
// Ushbu modul BUTUNLAY IXTIYORIY: agar TELEGRAM_API_ID / TELEGRAM_API_HASH
// .env'da bo'sh bo'lsa, mavjud bot.js va server.js funksiyalari (kod
// xaritasi, broadcast, R2/lokal video) hech qanday o'zgarishsiz avvalgidek
// ishlayveradi — bu modul faqat qo'shimcha "avtomatik saqlash" xususiyati
// yoqilganda ishga tushadi.
//
// SESSIYA PULI: bitta MTProto sessiyada ko'p odam bir vaqtda video ko'rsa
// Telegram flood-control (FLOOD_WAIT) tez ishga tushadi. Shuning uchun
// video-strim (telegramStream.js) uchun bir nechta mustaqil bot-sessiya
// ("pool") ishlatiladi — har biri o'z BOT_TOKEN'i va o'z session-fayli
// bilan. Asosiy BOT_TOKEN pool'ning 0-indeksi hisoblanadi, qo'shimcha
// tokenlar STREAM_BOT_TOKENS orqali (vergul bilan ajratilgan) qo'shiladi.
// channelAutoSave.js va bot.js hamon faqat 0-indeksdagi (asosiy) sessiyani
// ishlatadi — getClient() eski xatti-harakatini saqlaydi.

"use strict";

const fs = require("fs");
const path = require("path");

let TelegramClient, StringSession;
try {
  // Lazy require — "telegram" (gramjs) paketi o'rnatilmagan bo'lsa ham
  // (masalan bu xususiyat ishlatilmayotgan deploy'da) qolgan backend
  // yiqilib qolmasin.
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
} catch (e) {
  TelegramClient = null;
  StringSession = null;
}

const API_ID = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : 0;
const API_HASH = process.env.TELEGRAM_API_HASH ? String(process.env.TELEGRAM_API_HASH).trim() : "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";

const SESSION_PATH = path.join(__dirname, "..", "data", "telegram-mtproto-session.txt");

// Token puli: index 0 — asosiy BOT_TOKEN (moslik uchun eski session-fayl
// nomi bilan), keyingilari — STREAM_BOT_TOKENS'dan (vergul bilan ajratilgan).
function buildTokenPool() {
  const extra = String(process.env.STREAM_BOT_TOKENS || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return [BOT_TOKEN, ...extra];
}

const TOKENS = buildTokenPool();

// Har bir sessiya uchun mustaqil ulanish holati (client + ishga tushish
// promise'i) — pool'dagi bitta sessiyaning holati boshqasiga ta'sir qilmasin.
const sessionStates = TOKENS.map(() => ({ client: null, startingPromise: null }));

// Har bir sessiya nechta strim so'rovini XIZMAT QILGANI (muvaffaqiyatli
// qaytarilgan safar) — monitoring uchun, round-robin haqiqatan yukni
// taqsimlayotganini ko'rsatadi. Server qayta ishga tushsa 0'dan boshlanadi.
const requestCounts = TOKENS.map(() => 0);

function sessionPathFor(index) {
  if (index === 0) return SESSION_PATH; // eski nom — moslik uchun
  return path.join(__dirname, "..", "data", `telegram-mtproto-session-${index}.txt`);
}

function isEnabled() {
  return !!(TelegramClient && API_ID && API_HASH && TOKENS.some(Boolean));
}

// Pool'da nechta token sozlanganini qaytaradi (bo'sh qatorlar hisobga
// olinmaydi) — test/monitoring uchun.
function poolSize() {
  return TOKENS.filter(Boolean).length;
}

// Pool'dagi nechta sessiya HOZIR ulangan (monitoring/health-check uchun).
// Sessiyalar lazy ulanadi (birinchi video so'ralganda), shuning uchun
// server yangi ishga tushgan bo'lsa bu 0 qaytarishi normal holat.
function connectedCount() {
  return sessionStates.filter((s) => s.client && s.client.connected).length;
}

// Har bir sessiya bo'yicha to'liq holat — monitoring uchun (masalan
// bir nechta bot HAQIQATAN ishlatilayotganini tekshirish: agar faqat
// index 0'da requests o'sib, qolganlari 0'da qolsa — pool ishlamayapti).
function getSessionStats() {
  return TOKENS.map((token, index) => ({
    index,
    configured: Boolean(token),
    connected: Boolean(sessionStates[index].client && sessionStates[index].client.connected),
    requests: requestCounts[index],
  }));
}

function readSavedSession(sessionPath) {
  try {
    return fs.readFileSync(sessionPath, "utf-8").trim();
  } catch (e) {
    return "";
  }
}

function saveSession(sessionPath, sessionString) {
  try {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, sessionString, "utf-8");
  } catch (e) {
    console.warn("MTProto session saqlashda xato:", e.message);
  }
}

// Pool'dagi berilgan index'dagi klientni ishga tushiradi (allaqachon ishga
// tushgan bo'lsa — mavjudini qaytaradi). Xatolikda `null` qaytaradi va
// konsolga yozadi — chaqiruvchi tomon shunchaki shu sessiyani o'tkazib
// yuboradi, qolgan bot ishlashda davom etadi.
async function getSessionClient(index) {
  const token = TOKENS[index];
  if (!TelegramClient || !API_ID || !API_HASH || !token) return null;

  const state = sessionStates[index];
  if (state.client && state.client.connected) return state.client;
  if (state.startingPromise) return state.startingPromise;

  const sessionPath = sessionPathFor(index);

  state.startingPromise = (async () => {
    try {
      const savedSession = readSavedSession(sessionPath);
      const session = new StringSession(savedSession);
      const c = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 5,
      });

      await c.start({
        botAuthToken: token,
      });

      const sessionString = c.session.save();
      if (sessionString && sessionString !== savedSession) {
        saveSession(sessionPath, sessionString);
      }

      state.client = c;
      console.log(`MTProto klient ulandi (sessiya #${index}${index === 0 ? ", asosiy" : ""}).`);
      return state.client;
    } catch (e) {
      console.error(`MTProto klient ulanmadi (sessiya #${index}):`, e.message);
      state.client = null;
      return null;
    } finally {
      state.startingPromise = null;
    }
  })();

  return state.startingPromise;
}

// Eski API — HAR DOIM asosiy (index 0) sessiyani qaytaradi. bot.js va
// channelAutoSave.js shu funksiyadan foydalanishda davom etadi.
async function getClient() {
  return getSessionClient(0);
}

// Video-strim uchun: round-robin bilan navbatdagi sessiyani qaytaradi
// (0 → 1 → 2 → ... → 0 → ...). Navbatdagi sessiya ulanmasa/xato bersa,
// pool to'liq aylanguncha keyingisi sinab ko'riladi; hech biri ishlamasa
// null qaytadi.
let rrIndex = 0;
async function getStreamClient() {
  const total = TOKENS.length;
  if (total === 0) return null;

  for (let i = 0; i < total; i++) {
    const index = (rrIndex + i) % total;
    if (!TOKENS[index]) continue;
    try {
      const c = await getSessionClient(index);
      if (c) {
        rrIndex = (index + 1) % total;
        requestCounts[index] += 1;
        return c;
      }
    } catch (e) {
      console.warn(`MTProto strim sessiyasi #${index} xato berdi, keyingisiga o'tilmoqda:`, e.message);
    }
  }

  rrIndex = (rrIndex + 1) % total;
  return null;
}

// BARCHA pool sessiyalarini to'xtatadi (nomi eski qolgan — ichida hammasi
// disconnect qilinadi).
async function stopClient() {
  for (const state of sessionStates) {
    if (state.client) {
      try {
        await state.client.disconnect();
      } catch (e) {
        /* e'tiborsiz */
      }
      state.client = null;
    }
  }
}

module.exports = { isEnabled, getClient, stopClient, getStreamClient, poolSize, connectedCount, getSessionStats };
