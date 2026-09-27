// src/logger.js
// Strukturlog (JSON) — kuzatuvchanlik (observability) uchun.
// Har bir log bitta JSON qatori: { time, level, msg, requestId?, userId?, ...extras }
const fs = require("fs");
const path = require("path");

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const LOG_FILE = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : null;

function formatTime() {
  return new Date().toISOString();
}

function writeLine(obj) {
  const line = JSON.stringify(obj);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
    } catch {
      // Agar faylga yozib bo'lmasa, console'ga yozamiz (fallback).
      console.log(line);
    }
  } else {
    console.log(line);
  }
}

function log(level, msg, extras = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    time: formatTime(),
    level,
    msg,
    ...extras,
  };
  // error levelda stack trace ham yozamiz.
  if (level === "error" && extras.err instanceof Error) {
    entry.err = { message: extras.err.message, stack: extras.err.stack };
  }
  writeLine(entry);
}

const logger = {
  debug: (msg, extras) => log("debug", msg, extras),
  info: (msg, extras) => log("info", msg, extras),
  warn: (msg, extras) => log("warn", msg, extras),
  error: (msg, extras) => log("error", msg, extras),
  // Qo'shimcha yordamchi: xatolik obyekti bilan chaqirish uchun.
  // logger.error("msg", { err: new Error(...) })
};

module.exports = { logger, LOG_LEVELS, MIN_LEVEL };