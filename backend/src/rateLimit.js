// src/rateLimit.js
// Oddiy xotiradagi rate limiter (qo'pol ta'sirlarni cheklash uchun).
// Productionda Redis kabi markazlashtirilgan yechimga o'zgartirish mumkin.

function createRateLimiter({ windowMs = 60_000, max = 240 } = {}) {
  const hits = new Map();

  // Vaqti o'tgan yozuvlarni tozalab, Map cheksiz o'sib ketishini oldini olamiz.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (now - rec.start > windowMs) hits.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  if (timer.unref) timer.unref();

  function check(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return { allowed: true, remaining: max - 1, retryAfter: 0 };
    }
    rec.count += 1;
    if (rec.count > max) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((windowMs - (now - rec.start)) / 1000) };
    }
    return { allowed: true, remaining: max - rec.count, retryAfter: 0 };
  }
  // Server javob headerlarida X-RateLimit-Limit qo'yishi uchun max'ni olib yuradi.
  check.max = max;
  return check;
}

module.exports = { createRateLimiter };
