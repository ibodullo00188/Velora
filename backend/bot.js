// bot.js
// KinoBot uchun Telegram bot:
//   /start   — sodda salomlashuv xabari (webapp Menu tugmasi orqali ochiladi)
//   /help    — buyruqlar ro'yxati
//   /admin   — admin panel (faqat ADMIN_ID bo'lsa; aks holda muloyim rad etish)
//
// Kanal orqali sodda kod-video yuborish (channelCodes.js):
//   Admin kanalga video yuboradi, caption/text: "#1" (yoki "#VIP2" kabi)
//     -> bot shu postni "1" kodiga bog'laydi (fayl qayta yuklanmaydi).
//   Foydalanuvchi botga "1" deb yozsa -> bot copyMessage bilan xuddi shu
//     videoni foydalanuvchiga yuboradi.
//   Admin kanalga "*" bilan boshlangan istalgan xabar/rasm yuborsa
//     -> bot uni botning barcha (bloklanmagan) foydalanuvchilariga
//        broadcast qiladi.
//
// WebApp'ga kirish endi har bir xabarda alohida tugma sifatida emas,
// Telegram'ning global "Menu" tugmasi (matn input yonida, pastda) orqali
// ochiladi — matni "Movie" qilib o'rnatilgan (setChatMenuButton).
//
// Faqat Node.js ichki modullaridan foydalanadi (https) — tashqi kutubxona yo'q.
// Long polling (getUpdates) — webhook/HTTPS server shart emas.
// Tarmoq xatolari va 409 Conflict uchun exponential backoff.
// SIGINT/SIGTERM bilan toza (graceful) to'xtash.
//
// Ishga tushirish:  node bot.js
// Talab qilinadi (.env faylda): BOT_TOKEN, WEBAPP_URL, ADMIN_ID (ixtiyoriy), CHANNEL_ID (ixtiyoriy)

const https = require("https");
const fs = require("fs");
const path = require("path");

// --- .env yuklovchi (server.js dagi bilan bir xil) -------------------------
(function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : "";
const CHANNEL_ID = process.env.CHANNEL_ID ? String(process.env.CHANNEL_ID) : ""; // Kanal ID (@kanalusername yoki -100xxxxxx)

if (!BOT_TOKEN) {
  console.error("XATO: .env faylda BOT_TOKEN topilmadi.");
  process.exit(1);
}
if (!WEBAPP_URL || !WEBAPP_URL.startsWith("https://")) {
  console.error(
    "XATO: .env faylda WEBAPP_URL https:// bilan boshlanishi kerak " +
      "(Telegram WebApp faqat HTTPS manzillarni qabul qiladi)."
  );
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- Kanal-kod xaritasi va foydalanuvchilar ro'yxati (broadcast uchun) ------
const db = require("./src/db");
const channelCodes = require("./src/channelCodes");
const repos = require("./src/repositories");
const channelAutoSave = require("./src/channelAutoSave");
const mtproto = require("./src/mtproto");

// --- Graceful shutdown holati ----------------------------------------------
// SIGINT/SIGTERM kelganda pollLoop to'xtaydi va jarayon toza chiqadi.
let shuttingDown = false;
let activeReq = null; // hozirgi https so'rov — shutdown'da bekor qilinadi

// --- Kichik yordamchi: Telegram Bot API'ga so'rov yuborish -----------------
function apiRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(
      `${API_BASE}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (activeReq === req) activeReq = null;
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    activeReq = req;
    req.on("error", (e) => {
      if (activeReq === req) activeReq = null;
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff: 1->1x, 2->2x, 3->4x ... (maksimum 30s + jitter).
// Jitter — bir vaqtda ko'p bot bir xil daqiqada urinmasligi uchun.
function backoffDelay(attempt, baseMs) {
  const exp = Math.min(baseMs * 2 ** (attempt - 1), 30000);
  return exp + Math.floor(Math.random() * 500);
}

// --- Global Menu tugmasi (WebApp) -------------------------------------------
// Har bir xabarda alohida inline tugma emas — Telegram'ning pastdagi
// "Menu" tugmasi (matn kiritish maydoni yonida) global sifatida WebApp'ga
// ishora qiladi, matni "Movie" deb ko'rsatiladi.
async function setMenuButton() {
  const res = await apiRequest("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Movie", web_app: { url: WEBAPP_URL } },
  });
  if (!res.ok) {
    console.warn("setChatMenuButton xatosi:", res.description || res);
    return;
  }
  console.log(`Menu tugmasi o'rnatildi: "Movie" -> ${WEBAPP_URL}`);
}

// --- Xabarlar ----------------------------------------------------------------
// HTML parse_mode bilan yuborilganda foydalanuvchi ismidagi maxsus belgilar
// (&, <, >) markup'ni buzib qo'ymasligi uchun tozalanadi.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Salomlashuv xabari:
//   Matn ostida (pastida) WebApp'ni ochuvchi inline tugma bilan yuboriladi.
//   (Oldin bundan tashqari chatning pastki qismida doimiy ko'rinib turadigan
//   qo'shimcha "pastki panel" (reply keyboard) tugmasi ham o'rnatilardi —
//   ortiqcha/dublikat bo'lgani uchun olib tashlandi. WebApp'ga kirish endi
//   shu inline tugma va global Menu tugmasi (setMenuButton) orqali amalga
//   oshiriladi.)
async function sendWelcome(chatId, firstName) {
  const name = firstName ? escapeHtml(firstName) : "";
  const greeting = name ? `Assalomu alaykum, ${name}! 👋` : "Assalomu alaykum! 👋";
  const text =
    `${greeting}\n\n` +
    `🎬 Bu yerda sevimli filmlaringizni qulay va tez tomosha qilishingiz mumkin.\n\n` +
    `🍿 Siz uchun:\n` +
    `• 🎥 Filmlar va seriallar\n` +
    `• 🔴 Jonli videolar\n` +
    `• 🌐 Qulay WebApp orqali tomosha qilish\n` +
    `• 🔎 Kerakli filmni tezkor qidirish\n\n` +
    `Tomosha qilish uchun quyidagi <b>Movie</b> tugmasini bosing.\n\n` +
    `✨ Yaxshi tomosha tilaymiz!`;

  await apiRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ text: "🎬 Movie", web_app: { url: WEBAPP_URL } }]],
    },
  });
}

async function sendHelp(chatId) {
  await apiRequest("sendMessage", {
    chat_id: chatId,
    text:
      `📖 Yordam\n\n` +
      `Mavjud buyruqlar:\n` +
      `/start — botni ishga tushirish\n` +
      `/help — bu yordam xabari\n` +
      `/admin — admin panel (faqat adminlar)\n\n` +
      `Kino ilovasini ochish uchun pastdagi <b>Movie</b> tugmasidan foydalaning 👇\n` +
      `Kino kodini bilsangiz, uni to'g'ridan-to'g'ri shu yerga yozing (masalan: <code>1</code>).`,
    parse_mode: "HTML",
  });
}

async function sendAdminPanel(chatId) {
  await apiRequest("sendMessage", {
    chat_id: chatId,
    text:
      "🛠 Admin panel WebApp ichida (#admin) ochiladi. Backend admin " +
      "so'rovlari uchun X-Admin-Key header ishlatiladi.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Admin panelni ochish", web_app: { url: `${WEBAPP_URL}#admin` } }],
      ],
    },
  });
}

// Muloyim rad etish — /admin noto'g'ri user'ga.
async function sendAdminDenied(chatId) {
  await apiRequest("sendMessage", {
    chat_id: chatId,
    text: "Uzr, bu buyruq faqat adminlar uchun mavjud. 😊",
  });
}

// --- Buyruqlarni Telegram'ga ro'yxatdan o'tkazish ----------------------------
async function setMyCommands() {
  const commands = [
    { command: "start", description: "Botni ishga tushirish" },
    { command: "help", description: "Yordam" },
    { command: "admin", description: "Admin panel (faqat adminlar)" },
  ];
  const res = await apiRequest("setMyCommands", { commands });
  if (!res.ok) {
    console.warn("setMyCommands xatosi:", res.description || res);
    return;
  }
  console.log(
    `setMyCommands: ${commands.length} ta buyruq Telegram'ga o'rnatildi ` +
      `(${commands.map((c) => "/" + c.command).join(", ")})`
  );
}

// --- Long polling asosiy sikli ----------------------------------------------
let offset = 0;

async function pollLoop() {
  let errorCount = 0;

  while (!shuttingDown) {
    try {
      const res = await apiRequest("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query", "channel_post"],
      });

      if (shuttingDown) break;

      if (!res.ok) {
        // 409 — yana bir bot nusxasi bir xil token bilan poll qilmoqda.
        // Bu tugatilmaydigan xato, shuning uchun tez-tez urinmaymiz.
        if (res.error_code === 409) {
          console.error(
            "409 Conflict: yana bir bot nusxasi ishlayapti! " +
              "Long polling faqat bitta jarayon qila oladi."
          );
        } else {
          console.error("getUpdates xatosi:", res.description || res);
        }
        errorCount++;
        await sleep(backoffDelay(errorCount, 3000));
        continue;
      }

      errorCount = 0; // muvaffaqiyat — hisobni nollaymiz

      for (const update of res.result) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((e) => console.error("Update xatosi:", e));
      }
    } catch (e) {
      if (shuttingDown) break;
      console.error("Polling xatosi:", e.message);
      errorCount++;
      await sleep(backoffDelay(errorCount, 3000));
    }
  }

  console.log("Polling to'xtadi. Xayr! 👋");
  process.exit(0);
}

// --- Update'larni yo'naltirish -----------------------------------------------
async function handleUpdate(update) {
  // Inline tugma (callback) — masalan "❓ Yordam" bosilganda
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
    if (cq.data === "help") {
      // Tugmadagi "yuklanmoqda" belgisini o'chirish
      await apiRequest("answerCallbackQuery", { callback_query_id: cq.id });
      if (chatId) await sendHelp(chatId);
    }
    return;
  }

  // Channel post (kanalda yuborilgan xabar) - admin video/broadcast yuklaganda
  if (update.channel_post) {
    await handleChannelPost(update.channel_post);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const fromId = msg.from ? String(msg.from.id) : "";
  const firstName = msg.from ? msg.from.first_name : "";

  // Shaxsiy chatdagi har bir foydalanuvchini users bazasida saqlaymiz —
  // aks holda broadcast (kanalga "*" bilan yuborilgan xabar) hech kimga
  // yetib bormaydi, chunki yuborish uchun kimlarga yuborish kerakligini
  // bilish shart.
  if (msg.chat.type === "private" && msg.from) {
    repos.users.upsertFromTelegram(fromId, msg.from).catch((e) =>
      console.error("User upsert xatosi:", e.message)
    );
  }

  // Foydalanuvchi kod yuborganda (video/caption yo'q, faqat matn)
  if (msg.text) {
    const text = msg.text.trim();

    if (text === "/start") {
      await sendWelcome(chatId, firstName);
      return;
    }

    if (text === "/help") {
      await sendHelp(chatId);
      return;
    }

    if (text === "/admin") {
      if (ADMIN_ID) {
        if (fromId === ADMIN_ID) {
          await sendAdminPanel(chatId);
        } else {
          await sendAdminDenied(chatId);
        }
      } else {
        await apiRequest("sendMessage", {
          chat_id: chatId,
          text:
            "Admin sozlanmagan: server egasi ADMIN_ID ni .env faylda " +
            "o'rnatishi kerak.",
        });
      }
      return;
    }

    // Kod formatini tekshirish (alfanumerik, tire, pastki chiziq, 1-20 belgi —
    // bitta raqamli kodlar ham qabul qilinadi: "1", "2" va h.k.)
    const codePattern = /^[A-Z0-9_-]{1,20}$/i;
    if (codePattern.test(text) && !text.startsWith("/")) {
      await handleCodeMessage(chatId, text);
      return;
    }

    // Noma'lum buyruq — yordamga yo'naltiramiz
    if (text.startsWith("/")) {
      await apiRequest("sendMessage", {
        chat_id: chatId,
        text: "🤔 Bu buyruqni tanimayman. /help — barcha buyruqlar ro'yxati.",
      });
    }
  }
}

// Kanal ID kanalga tegishli ekanligini tekshiradi (CHANNEL_ID sozlangan bo'lsa).
function isConfiguredChannel(chatId) {
  if (!CHANNEL_ID) return true; // sozlanmagan bo'lsa — istalgan kanalni qabul qilamiz
  const msgChatId = String(chatId);
  const configChatId = CHANNEL_ID.startsWith("@") ? CHANNEL_ID : String(CHANNEL_ID);
  return msgChatId === configChatId || msgChatId === configChatId.replace("@", "");
}

// Kanal postini qayta ishlash:
//   "#KOD"  -> shu postni kodga bog'lash (video/document kerak)
//   "*..."  -> shu postni botning barcha foydalanuvchilariga broadcast qilish
//   (har doim, caption bor-yo'qligidan qat'i nazar) -> agar video/hujjat-video
//     bo'lsa va STORAGE_CHANNEL_ID sozlangan bo'lsa, storage kanalga
//     avtomatik nusxalanadi (channelAutoSave.js — ixtiyoriy, qo'shimcha xususiyat).
async function handleChannelPost(msg) {
  if (!isConfiguredChannel(msg.chat.id)) {
    console.log(`Kanal ID mos kelmadi: kutilgan=${CHANNEL_ID}, kelgan=${msg.chat.id}`);
    return;
  }

  // Avtomatik storage-kanalga saqlash: caption bor-yo'qligidan qat'i nazar
  // ishlaydi (video ko'pincha captionsiz yuklanadi). Mavjud #kod/broadcast
  // oqimiga hech qanday ta'sir qilmaydi — shunchaki qo'shimcha, sokin
  // (silent) ish bajaradi va agar sozlanmagan bo'lsa (.env'da
  // TELEGRAM_API_ID/TELEGRAM_API_HASH/STORAGE_CHANNEL_ID bo'sh) darhol
  // no-op qaytaradi.
  if (channelAutoSave.isEnabled()) {
    const rawCodeMatch = /^#\s*([A-Za-z0-9_-]{1,20})/.exec((msg.caption || msg.text || "").trim());
    channelAutoSave
      .autoSaveToStorageChannel(msg, {
        code: rawCodeMatch ? channelCodes.normalizeCode(rawCodeMatch[1]) : "",
        notify: ADMIN_ID
          ? (text) => apiRequest("sendMessage", { chat_id: ADMIN_ID, text })
          : null,
        botToken: BOT_TOKEN,
      })
      .catch((e) => console.error("channelAutoSave xatosi:", e.message));
  }

  const caption = (msg.caption || msg.text || "").trim();
  if (!caption) {
    console.log("Kanal postida matn/caption yo'q, o'tkazib yuborilmoqda (na # na *)");
    return;
  }

  if (caption.startsWith("*")) {
    await handleBroadcastPost(msg);
    return;
  }

  const codeMatch = /^#\s*([A-Za-z0-9_-]{1,20})/.exec(caption);
  if (codeMatch) {
    await handleSaveCode(msg, codeMatch[1]);
    return;
  }

  console.log('Kanal postida "#kod" yoki "*" prefiksi topilmadi, o\'tkazib yuborilmoqda');
}

// "#KOD" bilan yuborilgan kanal postini kodga bog'lash.
async function handleSaveCode(msg, rawCode) {
  const caption = (msg.caption || msg.text || "").trim();
  const hasMedia =
    msg.video ||
    (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("video/")) ||
    msg.photo ||
    msg.animation;

  if (!hasMedia) {
    console.log(`"#${rawCode}" kodli postda media yo'q, o'tkazib yuborilmoqda`);
    if (ADMIN_ID) {
      await apiRequest("sendMessage", {
        chat_id: ADMIN_ID,
        text: `⚠️ "#${rawCode}" kodi bilan yuborilgan postda video/rasm topilmadi — kod saqlanmadi.`,
      });
    }
    return;
  }

  try {
    const saved = await channelCodes.saveCode(rawCode, {
      channelId: msg.chat.id,
      messageId: msg.message_id,
      caption,
    });
    const code = channelCodes.normalizeCode(rawCode);
    console.log(`✅ Kod saqlandi: ${code} -> chat=${saved.channelId}, msg=${saved.messageId}`);

    if (ADMIN_ID) {
      await apiRequest("sendMessage", {
        chat_id: ADMIN_ID,
        text:
          `✅ <b>Kod saqlandi:</b> <code>${code}</code>\n\n` +
          `Foydalanuvchi botga <code>${code}</code> deb yozsa, shu video yuboriladi.`,
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    console.error("Kod saqlash xatosi:", e.message);
    if (ADMIN_ID) {
      await apiRequest("sendMessage", {
        chat_id: ADMIN_ID,
        text: `❌ Kod saqlashda xatolik: <code>${e.message}</code>`,
        parse_mode: "HTML",
      });
    }
  }
}

// "*" bilan boshlangan kanal postini botning barcha (bloklanmagan)
// foydalanuvchilariga nusxa ko'chiradi (copyMessage — matn, rasm, video,
// hujjat — istalgan turdagi xabar uchun ishlaydi).
const BROADCAST_CHUNK_SIZE = 20; // bir "to'lqin"da nechta so'rov
const BROADCAST_CHUNK_DELAY_MS = 1100; // to'lqinlar orasidagi kutish (Telegram flood-limit uchun)

async function handleBroadcastPost(msg) {
  const users = repos.users.listUsers().filter((u) => !repos.users.isBlocked(u));
  if (!users.length) {
    if (ADMIN_ID) {
      await apiRequest("sendMessage", { chat_id: ADMIN_ID, text: "📢 Broadcast: hozircha foydalanuvchilar yo'q." });
    }
    return;
  }

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < users.length; i += BROADCAST_CHUNK_SIZE) {
    const chunk = users.slice(i, i + BROADCAST_CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((u) =>
        apiRequest("copyMessage", {
          chat_id: u.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        }).catch((e) => ({ ok: false, description: e.message }))
      )
    );
    for (const r of results) {
      if (r && r.ok) sent++;
      else failed++;
    }
    if (i + BROADCAST_CHUNK_SIZE < users.length) {
      await sleep(BROADCAST_CHUNK_DELAY_MS);
    }
  }

  console.log(`📢 Broadcast yakunlandi: ${sent} ta yuborildi, ${failed} ta muvaffaqiyatsiz (jami ${users.length}).`);
  if (ADMIN_ID) {
    await apiRequest("sendMessage", {
      chat_id: ADMIN_ID,
      text: `📢 <b>Broadcast yakunlandi</b>\n\n✅ Yuborildi: ${sent}\n❌ Muvaffaqiyatsiz: ${failed}\n👥 Jami: ${users.length}`,
      parse_mode: "HTML",
    });
  }
}

// Foydalanuvchi kod yuborganida — kanal postini copyMessage bilan yuboradi.
async function handleCodeMessage(chatId, rawCode) {
  const entry = channelCodes.getCode(rawCode);
  if (!entry) {
    await apiRequest("sendMessage", {
      chat_id: chatId,
      text: `❌ "${rawCode}" kodi topilmadi. Kodni tekshirib qayta yuboring.`,
    });
    return;
  }

  const res = await apiRequest("copyMessage", {
    chat_id: chatId,
    from_chat_id: entry.channelId,
    message_id: entry.messageId,
  });

  if (!res.ok) {
    console.error("copyMessage xatosi:", res.description || res);
    await apiRequest("sendMessage", {
      chat_id: chatId,
      text: "❌ Kinoni yuborishda xatolik yuz berdi. Birozdan so'ng qayta urinib ko'ring.",
    });
  }
}

// --- Graceful shutdown --------------------------------------------------------
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] To'xtatilmoqda...`);

  // Kutib turgan long-poll so'rovini bekor qilamiz (30s kutishni qisqartiradi)
  if (activeReq) {
    try {
      activeReq.destroy();
    } catch (e) {
      /* e'tiborsiz */
    }
  }

  mtproto.stopClient().catch(() => {});

  // Agar 5 soniyada toza chiqmasa — majburiy chiqish (jarayonni ushlab turmaydi)
  setTimeout(() => {
    console.error("To'xtash 5 soniyada yakunlanmadi — majburiy chiqish.");
    process.exit(1);
  }, 5000).unref();
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --- Ishga tushirish ---------------------------------------------------------
(async () => {
  // server.js'dan ALOHIDA process (start-all.js fork qiladi) — shuning uchun
  // Postgres-rejimda o'z init()ini o'zi kutishi shart (DATABASE_URL bo'lmasa
  // zudlik bilan tugaydi, xatti-harakat o'zgarmaydi).
  try {
    await db.init();
  } catch (e) {
    console.error("Ma'lumotlar bazasini ishga tushirib bo'lmadi:", e.message);
    process.exit(1);
  }

  // getMe — tarmoq vaqtincha uzilib qolsa ham (ETIMEDOUT va h.k.) bot tushmaydi:
  // backoff bilan 5 urinish qilinadi. Faqat tarmoq xatosi qayta uriniladi —
  // noto'g'ri token (Telegram javob berdi) darhol chiqib ketadi.
  let me = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      me = await apiRequest("getMe", {});
      if (me.ok) break;
      // Telegram javob berdi, lekin token noto'g'ri — qayta urinish befoyda
      console.error("Bot tokeni noto'g'ri yoki bot topilmadi:", me);
      process.exit(1);
    } catch (e) {
      console.error(`getMe tarmoq xatosi (urinish ${attempt}/5): ${e.message}`);
      if (attempt < 5) await sleep(backoffDelay(attempt, 2000));
    }
  }
  if (!me || !me.ok) {
    console.error("Telegram'ga 5 urinishda ulanib bo'lmadi. Jarayon to'xtadi.");
    process.exit(1);
  }
  console.log(`Bot ishga tushdi: @${me.result.username}`);
  console.log(`WebApp URL: ${WEBAPP_URL}`);
  if (ADMIN_ID) console.log(`Admin ID: ${ADMIN_ID}`);
  if (CHANNEL_ID) console.log(`Kanal ID: ${CHANNEL_ID}`);

  // Buyruqlar ro'yxati va Menu tugmasi (xato bo'lsa ham bot ishlaydi)
  try {
    await setMyCommands();
  } catch (e) {
    console.warn("setMyCommands bajarilmadi:", e.message);
  }
  try {
    await setMenuButton();
  } catch (e) {
    console.warn("setChatMenuButton bajarilmadi:", e.message);
  }

  // MTProto klient (video avtomatik-saqlash uchun) — ixtiyoriy.
  // .env'da TELEGRAM_API_ID/TELEGRAM_API_HASH/STORAGE_CHANNEL_ID bo'lmasa
  // shunchaki o'chiq qoladi, botning qolgan qismi o'zgarishsiz ishlaydi.
  if (channelAutoSave.isEnabled()) {
    mtproto.getClient().catch((e) => console.warn("MTProto ulanmadi:", e.message));
  } else {
    console.log(
      "ℹ️ Video avtomatik-saqlash o'chiq (TELEGRAM_API_ID/TELEGRAM_API_HASH/STORAGE_CHANNEL_ID sozlanmagan)."
    );
  }

  pollLoop();
})();
