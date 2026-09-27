// src/password.js
// Admin panel parolini xavfsiz saqlash uchun scrypt (Node.js built-in crypto).
// Tashqi kutubxona kerak emas — bcrypt/argon o'rniga standart Node scrypt.
//
// Saqlash formati: "scrypt:$N:$r:$p:$saltHex:$hashHex"
//  - N/r/p — scrypt parametrlari (osonlikcha kelajakda oshirish mumkin)
//  - salt — har bir parol uchun tasodifiy (16 bayt)
//  - hash — scrypt natijasi (64 bayt)
//
// verifyPassword timingSafeEqual ishlatadi (timing hujum himoyasi).

const crypto = require("crypto");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split(":");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const [, nStr, rStr, pStr, salt, expectedHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch (e) {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  } catch (e) {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
