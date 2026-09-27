// start-all.js
//
// Render FREE tarifida "Background Worker" xizmat turi mavjud emas —
// faqat "Web Service" bepul. Shuning uchun bot.js (Telegram long polling)
// va server.js (REST API + WebApp) ni ALOHIDA ikkita Render xizmati
// sifatida emas, BITTA web-xizmat ichida birga ishga tushiramiz.
//
// server.js va bot.js o'zlari o'zgartirilmagan — bu fayl ularni faqat
// birga ishga tushiruvchi yupqa "launcher". Shu bilan ikkalasi bitta
// konteynerning bitta fayl tizimidan (backend/data/db.json) foydalanadi,
// ya'ni kanal-import (bot orqali) va API (WebApp) endi bitta ma'lumotlar
// bazasini ko'radi — avvalgi 2-xizmatli sxemada bular alohida edi.
//
// DIQQAT: Render Free tarifida doimiy disk yo'q. Bu degani — bu jarayon
// (demak butun backend/data papkasi, jumladan db.json) har safar xizmat
// uxlab-uyg'onganda yoki qayta deploy qilinganda 0'dan boshlanadi.
// Bu fayl buni tuzata olmaydi — faqat Starter+ tarif va Disk shuni hal qiladi.

const path = require("path");
const { fork } = require("child_process");

let shuttingDown = false;
let botProcess = null;
let botRestarts = 0;

// Tezlashuvchi (exponential) backoff: 3s, 6s, 12s, 24s, 48s, 60s (shu yerdan
// yuqoriga chiqmaydi). Bot noto'g'ri sozlangan bo'lsa (masalan WEBAPP_URL
// xato) ham, Free tarifning juda cheklangan CPU/RAM'ini band qilib,
// server.js'ni (asosiy API/health-check) ham ishlamay qo'yishining oldini
// oladi — avval bot har 3s'da tinimsiz qulab-qayta tushib, shu sabab butun
// xizmat 502 bera boshlagan holat kuzatilgan edi.
const MAX_RESTART_DELAY_MS = 60_000;
// Juda ko'p marta ketma-ket qulab tushsa (demak sozlama tuzatilmagan),
// urinishni butunlay to'xtatamiz — server.js baribir ishlab turadi,
// muammo tuzatilib qayta deploy qilinganda hammasi 0'dan boshlanadi.
const MAX_TOTAL_RESTARTS = 30;

// 1) HTTP API server — asosiy process ichida, o'zgarishsiz ishga tushadi.
//    Render health check (/api/health) va WebApp shu portga tegadi.
require("./server.js");

// 2) Telegram bot — alohida child process sifatida fork qilinadi (o'z
//    event loop'i, o'z SIGINT/SIGTERM va polling logikasi bilan, bot.js
//    hech qanday o'zgarishsiz). Qulab tushsa avtomatik qayta ishga tushadi.
function startBot() {
  if (shuttingDown) return;
  botProcess = fork(path.join(__dirname, "bot.js"), [], { stdio: "inherit" });

  botProcess.on("exit", (code, signal) => {
    if (shuttingDown) return;
    botRestarts += 1;

    if (botRestarts > MAX_TOTAL_RESTARTS) {
      console.error(
        `[start-all] bot.js ${MAX_TOTAL_RESTARTS} martadan ko'p qulab tushdi — ` +
          "avtomatik qayta urinish to'xtatildi. Sozlamalarni (BOT_TOKEN, WEBAPP_URL) " +
          "tekshirib, Render'da qayta deploy qiling. API server bemalol ishlashda davom etadi."
      );
      return;
    }

    const delay = Math.min(3_000 * 2 ** (botRestarts - 1), MAX_RESTART_DELAY_MS);
    console.error(
      `[start-all] bot.js to'xtadi (code=${code}, signal=${signal}). ` +
        `${Math.round(delay / 1000)}s dan keyin qayta ishga tushiriladi... (${botRestarts}-urinish)`
    );
    setTimeout(startBot, delay);
  });
}
startBot();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[start-all] [${signal}] bot child process to'xtatilmoqda...`);
  if (botProcess && !botProcess.killed) botProcess.kill(signal);
  // server.js o'zining SIGINT/SIGTERM handlerini o'rnatgan — u process.exit
  // chaqiradi, shuning uchun bu yerda qo'shimcha exit kerak emas.
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
