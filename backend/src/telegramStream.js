// src/telegramStream.js
// Storage kanalga saqlangan (channelAutoSave.js orqali) videoni HTTP Range
// so'rovlari bilan to'g'ridan-to'g'ri Telegram'dan (MTProto) veb-pleyerga
// strim qiladi — localStorage.js'dagi `stream()` bilan bir xil HTTP
// semantikasi (206 Partial Content, Content-Range, seeking), lekin fayl
// diskda emas, Telegram'da turadi.
//
// MUHIM: GramJS'ning iterDownload() metodi `offset` va `fileSize` uchun
// big-integer obyektlarini kutadi (ichida .add()/.divide() chaqiriladi).
// Oddiy JS soni berilsa "fileSize.add is not a function" xatosi chiqadi va
// strim jimgina ishlamay qoladi — shuning uchun quyida bigInt() ishlatiladi.

"use strict";

const bigInt = require("big-integer");
const mtproto = require("./mtproto");

// GramJS ichida MAX_CHUNK_SIZE = 512KB — bundan katta requestSize jimgina
// 512KB ga qisqartiriladi. Agar bu yerda 1MB qoldirilsa, alignedOffset 1MB
// chegarasida hisoblanadi-yu, GramJS 512KB bilan ishlaydi — mos kelmaydi va
// har seek'da ortiqcha ma'lumot yuklanadi. Shuning uchun aynan 512KB.
const REQUEST_CHUNK = 512 * 1024; // 4096 ga karrali bo'lishi shart

function isEnabled() {
  return mtproto.isEnabled();
}

function normalizePeer(raw) {
  const v = String(raw).trim();
  if (v.startsWith("@")) return v;
  return v;
}

// entry — storageVideos.js yozuvi: { storageChannelId, storageMessageId, fileSize, mimeType }
async function streamStorageVideo(req, res, entry) {
  if (!isEnabled()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_CONFIGURED", message: "Telegram strim sozlanmagan" } }));
    return;
  }

  const client = await mtproto.getStreamClient();
  if (!client) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "TELEGRAM_UNAVAILABLE", message: "Telegram'ga ulanib bo'lmadi" } }));
    return;
  }

  let message;
  try {
    const peer = normalizePeer(entry.storageChannelId);
    const messages = await client.getMessages(peer, { ids: [entry.storageMessageId] });
    message = Array.isArray(messages) ? messages[0] : messages;
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "FETCH_FAILED", message: e.message } }));
    return;
  }

  if (!message || !message.media) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Video Telegram'da topilmadi" } }));
    return;
  }

  // Fayl hajmini avval DB yozuvidan (entry.fileSize) olamiz — Telegram
  // media obyektidan olishga qaraganda tezroq va barqarorroq. Bo'lmasa
  // media obyektidan hisoblaymiz (document.size).
  let total = Number(entry.fileSize) || 0;
  if (!total) {
    try {
      const doc = message.media.document || message.media;
      total = Number(doc && doc.size) || 0;
    } catch (e) {
      total = 0;
    }
  }
  if (!total) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "UNKNOWN_SIZE", message: "Fayl hajmini aniqlab bo'lmadi" } }));
    return;
  }

  const mime = entry.mimeType || "video/mp4";
  const range = req.headers.range;

  let start = 0;
  let end = total - 1;
  let status = 200;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m && m[1] === "" && m[2] !== "") {
      const suffix = parseInt(m[2], 10);
      start = Number.isNaN(suffix) || suffix <= 0 ? 0 : Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = m && m[1] ? parseInt(m[1], 10) : 0;
      end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    }
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    status = 206;
  }

  const length = end - start + 1;

  res.writeHead(status, {
    "Content-Type": mime,
    "Content-Length": length,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  // GramJS chunk'lari REQUEST_CHUNK chegaralarida keladi — so'ralgan
  // range boshi/oxiri chegaraga to'g'ri kelmasa, ortiqcha baytlarni
  // kesib tashlaymiz (TelePlay'dagi stream_file bilan bir xil mantiq).
  const alignedOffset = Math.floor(start / REQUEST_CHUNK) * REQUEST_CHUNK;
  const skipAtStart = start - alignedOffset;
  let bytesSent = 0;
  let destroyed = false;

  req.on("close", () => {
    destroyed = true;
  });

  // res.write() `false` qaytarsa — mijoz (pleyer) bizdan sekinroq o'qiyapti.
  // Buni e'tiborsiz qoldirsak, Telegram'dan kelayotgan barcha chunk'lar
  // Node'ning ichki buferida to'planib, katta kino uchun xotirani yeb qo'yadi.
  // Shuning uchun "drain" hodisasini kutamiz.
  function writeChunk(buf) {
    return new Promise((resolve) => {
      if (res.write(buf)) return resolve();
      res.once("drain", resolve);
    });
  }

  try {
    const iterable = client.iterDownload({
      file: message.media,
      offset: bigInt(alignedOffset),
      requestSize: REQUEST_CHUNK,
      fileSize: bigInt(total),
    });

    let firstChunk = true;
    for await (let chunk of iterable) {
      if (destroyed) break;

      if (firstChunk) {
        if (skipAtStart > 0) chunk = chunk.subarray(skipAtStart);
        firstChunk = false;
      }

      const remaining = length - bytesSent;
      if (chunk.length > remaining) {
        chunk = chunk.subarray(0, remaining);
      }

      if (chunk.length > 0) {
        await writeChunk(Buffer.from(chunk));
        bytesSent += chunk.length;
      }

      if (bytesSent >= length) break;
    }
  } catch (e) {
    console.error("telegramStream xatosi:", e.message);
  } finally {
    if (!destroyed) res.end();
  }
}

module.exports = { isEnabled, streamStorageVideo };
