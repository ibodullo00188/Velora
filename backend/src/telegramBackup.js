"use strict";
// Encrypted, authenticated snapshots; never include tokens or MTProto sessions.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const db = require("./db");
const MAGIC = Buffer.from("KINOBAK1");
const MAX_FILE = 19 * 1024 * 1024; // Below Telegram Bot API download limit.
const MAX_JSON = 100 * 1024 * 1024;
const DATA_ROOT = path.dirname(db.getDbPath());
let busy = false;
let retryAfter = 0;
let lastSlot = 0;
const pending = new Map();
function channelId() { return process.env.BACKUP_CHANNEL_ID || process.env.STORAGE_CHANNEL_ID || process.env.CHANNEL_ID || ""; }
function enabled() { return !["0", "false"].includes(process.env.TELEGRAM_BACKUP_ENABLED) && Boolean(channelId() && process.env.BOT_TOKEN); }
function key() {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.BOT_TOKEN;
  if (!secret) throw new Error("Backup shifrlash kaliti sozlanmagan");
  return crypto.createHash("sha256").update("kinobot-backup-v1:" + secret).digest();
}
function validateDatabase(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Database obyekt emas");
  for (const field of ["movies", "genres", "auditLog"]) {
    if (!Array.isArray(data[field])) throw new Error(`Database: ${field} massiv emas`);
  }
  for (const field of ["users", "favorites", "history", "analytics"]) {
    if (!data[field] || typeof data[field] !== "object" || Array.isArray(data[field])) throw new Error(`Database: ${field} obyekt emas`);
  }
  if (data.movies.some(m => !m || !m.id || !m.title)) throw new Error("Film ma'lumotlari yaroqsiz");
  return data;
}
function slotAt(now = Date.now()) {
  // 09:00 and 21:00 UTC+5 = 04:00 and 16:00 UTC.
  const day = Math.floor(now / 86400000) * 86400000;
  if (now >= day + 16 * 3600000) return day + 16 * 3600000;
  if (now >= day + 4 * 3600000) return day + 4 * 3600000;
  return day - 8 * 3600000;
}
function snapshot() {
  if (!fs.existsSync(db.getDbPath())) throw new Error("Database fayli yo'q; avval restore qiling");
  const data = validateDatabase(JSON.parse(fs.readFileSync(db.getDbPath(), "utf8")));
  const assets = {};
  for (const dir of ["banner", "posters"]) {
    const root = path.join(DATA_ROOT, dir);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(name)) continue;
      const file = path.join(root, name);
      if (fs.lstatSync(file).isFile()) assets[`${dir}/${name}`] = fs.readFileSync(file).toString("base64");
    }
  }
  return { format: "kinobot-backup", version: 1, createdAt: new Date().toISOString(), database: data, assets };
}
function encode(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > MAX_JSON) throw new Error("Backup ochilgan hajmi 100 MB dan oshdi");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(MAGIC);
  const payload = Buffer.concat([cipher.update(zlib.gzipSync(json)), cipher.final()]);
  const result = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), payload]);
  if (result.length > MAX_FILE) throw new Error("Backup 19 MB dan oshdi. Rasmlarni ImageKit'ga ko'chiring");
  return result;
}
function decode(buffer) {
  if (buffer.length > MAX_FILE || !buffer.subarray(0, 8).equals(MAGIC)) throw new Error("Backup formati yoki hajmi yaroqsiz");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buffer.subarray(8, 20));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(buffer.subarray(20, 36));
  const compressed = Buffer.concat([decipher.update(buffer.subarray(36)), decipher.final()]);
  const value = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: MAX_JSON }).toString("utf8"));
  if (value.format !== "kinobot-backup" || value.version !== 1 || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Backup versiyasi yaroqsiz");
  validateDatabase(value.database);
  if (!value.assets || typeof value.assets !== "object" || Array.isArray(value.assets)) throw new Error("Rasmlar ro'yxati yaroqsiz");
  for (const [name, content] of Object.entries(value.assets)) {
    if (!/^(banner|posters)\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(name) || typeof content !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error("Rasm fayli yaroqsiz");
  }
  return value;
}
async function api(method, body) {
  const form = body instanceof FormData;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
      method: "POST", body: form ? body : JSON.stringify(body),
      headers: form ? undefined : { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw new Error(`Telegram ${method}: tarmoq xatosi`); }
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: so'rov bajarilmadi (${result.error_code || response.status})`);
  return result.result;
}
async function download(fileId) {
  const file = await api("getFile", { file_id: fileId });
  if (file.file_size > MAX_FILE || !file.file_path) throw new Error("Backup hajmi katta yoki fayl yo'q");
  let response;
  try { response = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(60000) }); }
  catch { throw new Error("Backup yuklab olinmadi"); }
  if (!response.ok) throw new Error("Backup yuklab olinmadi");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FILE) throw new Error("Backup hajmi katta");
    chunks.push(chunk);
  }
  return decode(Buffer.concat(chunks));
}
function applySnapshot(value) {
  // All downloads/validation finish before this synchronous commit boundary.
  validateDatabase(value.database);
  const rollback = fs.existsSync(db.getDbPath()) ? snapshot() : null;
  if (rollback) {
    const root = path.join(path.dirname(db.getDbPath()), "backups");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, `pre-restore-${Date.now()}.kbak`), encode(rollback));
  }
  const staged = [];
  try {
    for (const [name, content] of Object.entries(value.assets)) {
      const dest = path.join(DATA_ROOT, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".restore-tmp";
      fs.writeFileSync(tmp, Buffer.from(content, "base64"));
      staged.push({ tmp, dest, previous: fs.existsSync(dest) ? fs.readFileSync(dest) : null });
    }
    for (const dir of ["banner", "posters"]) {
      const root = path.join(DATA_ROOT, dir);
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(name) || Object.hasOwn(value.assets, `${dir}/${name}`)) continue;
        const dest = path.join(root, name);
        if (fs.lstatSync(dest).isFile()) staged.push({ dest, previous: fs.readFileSync(dest), tmp: null });
      }
    }
    for (const entry of staged) {
      if (entry.tmp) fs.renameSync(entry.tmp, entry.dest);
      else fs.unlinkSync(entry.dest);
    }
    value.database.settings = value.database.settings || {};
    value.database.settings.telegramBackup = { lastSlot: slotAt(), restoredAt: new Date().toISOString(), sourceCreatedAt: value.createdAt };
    db.replaceDatabase(value.database);
  } catch (err) {
    for (const entry of staged) {
      if (entry.previous) fs.writeFileSync(entry.dest, entry.previous);
      else if (fs.existsSync(entry.dest)) fs.unlinkSync(entry.dest);
      if (entry.tmp && fs.existsSync(entry.tmp)) fs.unlinkSync(entry.tmp);
    }
    throw err;
  }
  lastSlot = slotAt();
}
async function flush() { await require("./repositories").analytics.flush(); }
async function sendBackup() {
  if (busy) throw new Error("Backup/restore hozir bajarilmoqda");
  busy = true;
  try {
    await flush();
    const value = snapshot();
    const form = new FormData();
    form.set("chat_id", channelId());
    form.set("caption", `KinoBot backup · ${value.createdAt}\nFilmlar: ${value.database.movies.length} · Foydalanuvchilar: ${Object.keys(value.database.users).length}`);
    form.set("document", new Blob([encode(value)]), `kinobot-${value.createdAt.replace(/[:.]/g, "-")}.kbak`);
    const message = await api("sendDocument", form);
    lastSlot = slotAt();
    const state = db.load();
    state.settings.telegramBackup = { lastSlot, messageId: message.message_id, createdAt: value.createdAt };
    await db.persist();
    return value;
  } finally { busy = false; }
}
async function initializeLocal() {
  // Never fetch or restore a remote backup automatically.
  if (fs.existsSync(db.getDbPath())) {
    try {
      const data = validateDatabase(JSON.parse(fs.readFileSync(db.getDbPath(), "utf8")));
      lastSlot = Number(data.settings?.telegramBackup?.lastSlot) || slotAt();
      return;
    } catch {
      fs.renameSync(db.getDbPath(), db.getDbPath() + `.corrupt-${Date.now()}`);
    }
  }
  lastSlot = slotAt();
  db.resetForTest();
  db.load();
  await db.persist();
  console.log("[backup] Lokal database yaratildi. Eski ma'lumotlar uchun admin backup faylni botga forward qilib tiklashi mumkin.");
}
async function tick(now = Date.now()) {
  if (!enabled() || busy || now < retryAfter || slotAt(now) <= lastSlot) return;
  try { await sendBackup(); }
  catch (e) {
    retryAfter = now + 5 * 60000;
    console.error("[backup]", e.message);
    if (process.env.ADMIN_ID) {
      try { await api("sendMessage", { chat_id: process.env.ADMIN_ID, text: `Backup xatosi: ${e.message}. 5 daqiqadan keyin qayta uriniladi.` }); } catch {}
    }
  }
}
function startScheduler() {
  if (!enabled()) return () => {};
  tick();
  const timer = setInterval(() => tick(), 60000);
  timer.unref();
  return () => clearInterval(timer);
}
async function handleAdminMessage(msg) {
  const text = (msg.text || msg.caption || "").trim();
  const buttonCommands = {
    "💾 Backup yaratish": "/backup",
    "♻️ Backupni qayta tiklash": "/restore",
  };
  const command = buttonCommands[text] || text.split(/\s/)[0].split("@")[0];
  const isFile = /\.kbak$/i.test(msg.document?.file_name || "");
  if (!["/backup", "/restore", "/restore_confirm", "/restore_cancel"].includes(command) && !isFile) return false;
  if (msg.chat.type !== "private" || String(msg.from?.id) !== String(process.env.ADMIN_ID || "")) return true;
  const reply = text => api("sendMessage", { chat_id: msg.chat.id, text });
  try {
    if (command === "/backup") {
      if (!enabled()) throw new Error("Backup kanali sozlanmagan yoki backup o'chirilgan");
      await sendBackup(); await reply("✅ Yangi backup kanalga yuborildi.");
    } else if (command === "/restore_cancel") {
      pending.delete(msg.from.id); await reply("Tiklash bekor qilindi.");
    } else if (command === "/restore_confirm") {
      const item = pending.get(msg.from.id);
      const nonce = text.split(/\s+/)[1];
      if (!item || item.expires < Date.now() || nonce !== item.nonce) throw new Error("Tasdiqlash eskirgan yoki kod noto'g'ri. /restore ni qayta yuboring");
      if (busy) throw new Error("Backup/restore hozir bajarilmoqda");
      busy = true;
      try {
        const value = await download(item.fileId);
        await flush();
        applySnapshot(value);
        pending.delete(msg.from.id);
        await reply(`✅ ${value.createdAt} dagi backup tiklandi. Filmlar: ${value.database.movies.length}`);
      } finally { busy = false; }
    } else {
      const document = isFile ? msg.document : msg.reply_to_message?.document;
      if (!document) throw new Error("Kanaldagi oxirgi .kbak faylni shu botga forward qiling. Bot sana va tarkibni ko'rsatib, tasdiqlashingizni so'raydi");
      if (document.file_size > MAX_FILE) throw new Error("Backup 19 MB dan katta");
      const value = await download(document.file_id);
      const nonce = crypto.randomBytes(4).toString("hex");
      pending.set(msg.from.id, { fileId: document.file_id, nonce, expires: Date.now() + 10 * 60000 });
      await reply(`Backup: ${value.createdAt}\nFilmlar: ${value.database.movies.length}\nFoydalanuvchilar: ${Object.keys(value.database.users).length}\nJoriy baza shu nusxa bilan almashtiriladi. 10 daqiqada tasdiqlang:\n/restore_confirm ${nonce}\nBekor qilish: /restore_cancel`);
    }
  } catch (e) { await reply(`❌ ${e.message}`); }
  return true;
}
module.exports = { validateDatabase, slotAt, snapshot, encode, decode, applySnapshot, sendBackup, initializeLocal, startScheduler, handleAdminMessage, tick };
