// src/channelAutoSave.js
// Manba kanalga (CHANNEL_ID) video/hujjat-video tashlanganda, uni avtomatik
// ravishda alohida "storage" kanalga (STORAGE_CHANNEL_ID) MTProto orqali
// nusxalaydi — muallif/manba belgisisiz ("copy", forward emas), Bot API
// kabi 20MB cheklovisiz, fayl qayta yuklanmasdan (Telegram serverida
// nusxalanadi).
//
// Bu mavjud "#kod" (channelCodes.js) va "*" (broadcast) funksiyalari bilan
// PARALEL ishlaydi — ularni almashtirmaydi. bot.js'dagi handleChannelPost
// ichida qo'shimcha (additive) chaqiriladi.
//
// Ishga tushishi uchun .env'da quyidagilar to'ldirilishi kerak:
//   TELEGRAM_API_ID, TELEGRAM_API_HASH  (my.telegram.org)
//   STORAGE_CHANNEL_ID                  (bot admin bo'lgan alohida kanal)
// Bo'lmasa — funksiya jim o'tkazib yuboradi, boshqa hech nima o'zgarmaydi.

"use strict";

const mtproto = require("./mtproto");
const storageVideos = require("./storageVideos");
const autoMovie = require("./autoMovie");
const repos = require("./repositories");
const posterStore = require("./posterStore");
const { getTelegramFilePath, downloadTelegramFile } = require("./channelImport");

// Poster uchun yuklab olinadigan thumb hajmi chegarasi (admin qo'lda yuklashdagi
// bilan bir xil — server.js'dagi POSTER_MAX_DECODED'ga mos). Telegram thumb'lari
// odatda bir necha o'n KB bo'ladi, bu faqat xavfsizlik chegarasi.
const POSTER_THUMB_MAX_BYTES = 2 * 1024 * 1024;

const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID
  ? String(process.env.STORAGE_CHANNEL_ID).trim()
  : "";

function isEnabled() {
  return mtproto.isEnabled() && !!STORAGE_CHANNEL_ID;
}

// Bot API channel_post obyektida video/hujjat-video bor-yo'qligini aniqlaydi
// va tavsif ma'lumotlarini qaytaradi (storageVideos yozuviga qo'yish uchun).
function extractMedia(msg) {
  if (msg.video) {
    // Telegram video xabarlarida odatda avtomatik generatsiya qilingan kichik
    // JPEG "thumb" (preview kadr) keladi — Bot API 6.6+ buni "thumbnail" deb
    // ataydi, eski versiyalar/kutubxonalar "thumb" deb qaytarishi mumkin,
    // shuning uchun ikkalasini ham tekshiramiz.
    const thumb = msg.video.thumbnail || msg.video.thumb || null;
    return {
      mediaType: "video",
      fileName: msg.video.file_name || "",
      fileSize: msg.video.file_size || 0,
      mimeType: msg.video.mime_type || "video/mp4",
      durationSeconds: msg.video.duration || 0,
      thumbFileId: thumb ? thumb.file_id : "",
    };
  }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("video/")) {
    const thumb = msg.document.thumbnail || msg.document.thumb || null;
    return {
      mediaType: "document",
      fileName: msg.document.file_name || "",
      fileSize: msg.document.file_size || 0,
      mimeType: msg.document.mime_type || "",
      durationSeconds: 0,
      thumbFileId: thumb ? thumb.file_id : "",
    };
  }
  return null;
}

// Telegramning o'zi generatsiya qilgan video-thumb'ini Bot API orqali yuklab
// olib, to'g'ridan-to'g'ri filmning posteri sifatida saqlaydi. Hech qanday
// video-kadr ajratish (ffmpeg va h.k.) shart emas — thumb Telegram tomonidan
// tayyor keladi.
//
// SOF QO'SHIMCHA qadam: xato bo'lsa (thumb yo'q, tarmoq xatosi, rasm emas)
// — indamay `false` qaytaradi, filmning o'zi (gradient bilan) baribir
// yaratilgan bo'lib qoladi va hech narsa buzilmaydi.
async function trySavePosterFromThumb(botToken, movieId, thumbFileId) {
  if (!botToken || !movieId || !thumbFileId) return false;
  try {
    const filePath = await getTelegramFilePath(thumbFileId, botToken);
    const buffer = await downloadTelegramFile(filePath, botToken, POSTER_THUMB_MAX_BYTES);
    const ext = posterStore.detectImageExt(buffer);
    if (!ext) return false;
    const saved = await posterStore.savePoster(movieId, buffer, ext);
    const posterUrl = saved.url || `/api/movies/${encodeURIComponent(movieId)}/poster`;
    await repos.movies.update(movieId, { posterUrl });
    console.log(`🖼️  Poster avtomatik saqlandi (Telegram thumb'idan): movieId=${movieId}`);
    return posterUrl;
  } catch (e) {
    console.error("trySavePosterFromThumb xatosi (e'tiborsiz qoldiriladi):", e.message);
    return false;
  }
}

// GramJS'da forward'ni "muallifsiz nusxa" (Telegram ilovasidagi "Copy" bilan
// bir xil, "Forwarded from" yorlig'isiz) qilish uchun dropAuthor: true
// bilan Api.messages.ForwardMessages chaqiriladi.
async function copyMessageViaMtproto(client, { fromChannelId, toChannelId, messageId }) {
  const { Api } = require("telegram");

  const fromEntity = await client.getEntity(normalizePeer(fromChannelId));
  const toEntity = await client.getEntity(normalizePeer(toChannelId));

  const result = await client.invoke(
    new Api.messages.ForwardMessages({
      fromPeer: fromEntity,
      toPeer: toEntity,
      id: [messageId],
      randomId: [require("crypto").randomBytes(8).readBigInt64BE()],
      dropAuthor: true,
      dropMediaCaptions: false,
    })
  );

  // Natijadagi yangi xabar ID'sini topamiz (Updates ichidan).
  const updates = result.updates || [];
  for (const u of updates) {
    if (u.className === "UpdateNewChannelMessage" || u.className === "UpdateNewMessage") {
      if (u.message && u.message.id) return u.message.id;
    }
  }
  return null;
}

// "@username" yoki "-100xxxxxxxxxx" ko'rinishidagi ID'ni GramJS kutgan
// formatga moslaydi (kanal ID'lari uchun -100 prefiksni olib tashlaydi,
// chunki GramJS getEntity xom kanal ID'ni shunday kutadi).
function normalizePeer(raw) {
  const v = String(raw).trim();
  if (v.startsWith("@")) return v;
  if (v.startsWith("-100")) return v; // GramJS -100... ko'rinishini ham to'g'ridan-to'g'ri qabul qiladi
  return v;
}

// Asosiy funksiya — bot.js'ning handleChannelPost'idan chaqiriladi.
// `msg` — Telegram Bot API channel_post obyekti (video/document bilan).
// `code` — agar "#kod" bilan bog'langan bo'lsa (ixtiyoriy, faqat yozuvga
//          qo'shish uchun, funksional jihatdan kerak emas).
// `notify` — (ixtiyoriy) async (text) => void — adminga xabar yuborish
//            uchun bot.js'dagi apiRequest("sendMessage", ...) callback'i.
async function autoSaveToStorageChannel(msg, { code, notify, botToken } = {}) {
  if (!isEnabled()) return null;

  const media = extractMedia(msg);
  if (!media) return null; // video emas — saqlanadigan narsa yo'q

  const sourceChannelId = msg.chat.id;
  const sourceMessageId = msg.message_id;

  const already = storageVideos.findBySource(sourceChannelId, sourceMessageId);
  if (already) return already;

  const client = await mtproto.getClient();
  if (!client) return null;

  try {
    const newMessageId = await copyMessageViaMtproto(client, {
      fromChannelId: sourceChannelId,
      toChannelId: STORAGE_CHANNEL_ID,
      messageId: sourceMessageId,
    });

    if (!newMessageId) {
      console.warn("channelAutoSave: storage kanalga nusxalashda xabar ID topilmadi");
      return null;
    }

    const entry = await storageVideos.addEntry({
      sourceChannelId,
      sourceMessageId,
      storageChannelId: STORAGE_CHANNEL_ID,
      storageMessageId: newMessageId,
      code: code || "",
      caption: (msg.caption || msg.text || "").trim(),
      ...media,
    });

    console.log(
      `✅ Video storage kanalga saqlandi: src_msg=${sourceMessageId} -> storage_msg=${newMessageId}`
    );

    // Darhol (poster/janrsiz) minimal "film" yozuvi yaratamiz — shunda
    // ODDIY FOYDALANUVCHILAR ham katalogda darhol ko'radi. Xato bo'lsa
    // (masalan repos/db muammosi) — storageVideos yozuvi baribir saqlangan
    // bo'ladi, admin keyin qo'lda ham film yaratishi mumkin.
    let movie = null;
    try {
      movie = await autoMovie.createMovieFromStorageVideo(entry);
      if (movie) {
        await storageVideos.linkMovie(entry.id, movie.id);
        console.log(`🎬 Avtomatik film yaratildi: "${movie.title}" (id=${movie.id})`);

        // Poster: Telegram video/hujjatning o'z ichidagi tayyor thumb'i
        // (agar bo'lsa) darhol filmga poster sifatida biriktiriladi — admin
        // hech narsa qilishi shart emas, web-app'da rasm avtomatik ko'rinadi.
        if (media.thumbFileId && botToken) {
          const posterUrl = await trySavePosterFromThumb(botToken, movie.id, media.thumbFileId);
          if (posterUrl) movie.posterUrl = posterUrl;
        }
      }
    } catch (e) {
      console.error("autoMovie xatosi (storageVideos yozuvi baribir saqlangan):", e.message);
    }

    if (typeof notify === "function") {
      await notify(
        `📥 Video avtomatik saqlandi va katalogga qo'shildi.\n` +
          `Nomi: ${movie ? movie.title : "(film yaratilmadi)"}\n` +
          `Manba xabar: ${sourceMessageId} → Storage xabar: ${newMessageId}` +
          (code ? `\nKod: ${code}` : "")
      ).catch(() => {});
    }

    return entry;
  } catch (e) {
    console.error("channelAutoSave xatosi:", e.message);
    if (typeof notify === "function") {
      await notify(`❌ Videoni storage kanalga saqlashda xatolik: ${e.message}`).catch(() => {});
    }
    return null;
  }
}

module.exports = { isEnabled, autoSaveToStorageChannel };
