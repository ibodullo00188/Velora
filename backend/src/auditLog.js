// src/auditLog.js
// Admin audit log — har bir muhim admin action yoziladi.
//
// Yozuv formati:
//   { id, adminId, action, entityType, entityId, timestamp, oldValue?, newValue? }
//
// Audit log oddiy user'ga ko'rinmaydi — faqat admin endpoint orqali.

const crypto = require("crypto");
const { load, persist } = require("./db");
const { logger } = require("./logger");

const MAX_ENTRIES = 2000; // cheksiz o'smasligi uchun limit

function genId() {
  return crypto.randomBytes(6).toString("hex");
}

// Action'ni loglaydi va DB'ga yozadi.
// return auditEntry
async function logAudit({ adminId, action, entityType, entityId, oldValue, newValue } = {}) {
  const entry = {
    id: genId(),
    adminId: adminId != null ? String(adminId) : "",
    action,
    entityType: entityType || "",
    entityId: entityId != null ? String(entityId) : "",
    timestamp: new Date().toISOString(),
  };
  if (oldValue !== undefined) entry.oldValue = oldValue;
  if (newValue !== undefined) entry.newValue = newValue;

  const db = load();
  db.auditLog.push(entry);
  if (db.auditLog.length > MAX_ENTRIES) {
    db.auditLog = db.auditLog.slice(-MAX_ENTRIES);
  }
  await persist();

  // Logger'ga ham yozish (info level)
  logger.info("Admin audit log", { adminId, action, entityType, entityId, entryId: entry.id });
  return entry;
}

// Eng yangidan eskiga tartiblangan audit yozuvlari (ixtiyoriy filter).
function listAudit({ action, entityType, entityId, limit = 200 } = {}) {
  const db = load();
  let entries = [...db.auditLog].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (action) entries = entries.filter((e) => e.action === action);
  if (entityType) entries = entries.filter((e) => e.entityType === entityType);
  if (entityId) entries = entries.filter((e) => e.entityId === entityId);
  return entries.slice(0, limit);
}

function clearAudit() {
  const db = load();
  db.auditLog = [];
  return persist();
}

module.exports = { logAudit, listAudit, clearAudit, MAX_ENTRIES };
