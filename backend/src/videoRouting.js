// src/videoRouting.js
// Video playback manbasini tanlash: R2 birinchi, Kali lokal ikkinchi.
//
// Priority (qat'iy):
//   1. R2 sozlangan va video object mavjud → R2 presigned URL
//   2. Kali serverda lokal video fayl mavjud → stream URL (tokenli)
//   3. Ikkalasida ham yo'q → null (frontend "video mavjud emas" ko'rsatadi)
//
// R2 HEAD tekshiruvi 3s timeout bilan — tarmoq xatosi yoki R2 yo'qolsa,
// Kali fallback avtomatik ishlaydi.

"use strict";

const R2_CHECK_TIMEOUT_MS = 3_000;

/**
 * @param {object} opts
 * @param {string}  opts.movieId   — film ID
 * @param {string}  opts.quality   — 360p / 480p / 720p / 1080p
 * @param {object}  opts.r2        — src/r2 moduli (yoki mock)
 * @param {object}  opts.local     — src/localStorage moduli (yoki mock)
 * @param {function} opts.buildStreamUrl — (movieId, quality) => string (tokenli URL)
 * @param {function} [opts.logger]       — optional logger.warn/info
 * @returns {Promise<{storageType: string, url: string} | null>}
 */
async function resolveVideoSource({ movieId, quality, r2, local, buildStreamUrl, logger }) {
  if (r2.isConfigured()) {
    let r2Exists = false;
    try {
      const head = await r2.headObject(r2.buildObjectKey(movieId, quality), { timeoutMs: R2_CHECK_TIMEOUT_MS });
      r2Exists = !!(head && head.ok);
    } catch (e) {
      if (logger && typeof logger.warn === "function") {
        logger.warn("R2 HEAD tekshiruvida xato — Kali fallback", { movieId, quality, error: e.message });
      }
    }

    if (r2Exists) {
      try {
        const url = r2.presignedGetUrl(r2.buildObjectKey(movieId, quality), { expiresInSeconds: 300 });
        return { storageType: "r2", url };
      } catch (e) {
        if (logger && typeof logger.warn === "function") {
          logger.warn("R2 presigned URL xatosi", { movieId, quality, error: e.message });
        }
      }
    }
  }

  // Kali lokal video
  if (local && local.isConfigured()) {
    const lk = local.buildObjectKey(movieId, quality);
    if (local.exists(lk)) {
      const url = buildStreamUrl(movieId, quality);
      return { storageType: "local", url };
    }
  }

  return null;
}

module.exports = { resolveVideoSource, R2_CHECK_TIMEOUT_MS };
