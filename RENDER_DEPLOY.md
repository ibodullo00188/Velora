# KinoBot'ni Render'ga joylash — FREE tarif, bosqichma-bosqich

Bu qo'llanma **loyiha kodiga hech qanday buzuvchi o'zgarish kiritmasdan**
KinoBot'ni Render.com'ning **bepul (Free)** tarifida ishga tushiradi.

## 0. Free tarif haqida — avval shuni bilib oling

Render'ning Free tarifida ikkita muhim cheklov bor. Bular Render platformasining
o'zi shunday ishlaydi — kod bilan aylanib o'tib bo'lmaydi:

1. **Doimiy disk yo'q.** `backend/data/db.json` (filmlar, foydalanuvchilar,
   sevimlilar, tomosha tarixi, to'lovlar) xizmat qayta ishga tushganda —
   masalan 15 daqiqa harakatsizlikdan keyin "uxlab", keyin qayta so'rov
   kelganda "uyg'onganda" — **0'dan boshlanadi**. Bu demo/sinov uchun mos,
   lekin haqiqiy foydalanuvchi to'lovlarini doimiy saqlash uchun emas.
2. **Bot uzluksiz ishlamaydi.** Render Free xizmatni 15 daqiqa HTTP so'rovsiz
   qolsa to'xtatib qo'yadi — bu botning ichki polling jarayoniga ham
   tegishli. Demak faol foydalanilmasa, bot vaqti-vaqti bilan javob
   bermay qo'yishi mumkin (birinchi so'rovdan keyin ~30-60 soniyada
   "uyg'onadi"). Pastda (7-bo'lim) ixtiyoriy "keep-alive" yechimi berilgan.

Bular sizga mos bo'lsa (loyihani sinash, demo qilish, kam foydalanuvchili
boshlang'ich bosqich) — davom eting. Haqiqiy foydalanuvchi ma'lumotini
yo'qotmaslik va botni doim ishlab turishi kerak bo'lsa, keyinchalik
Starter+ tarifga o'tish kifoya (render.yaml'da tayyor izohlangan bo'lim bor).

## 1. Nima kerak bo'ladi

- GitHub (yoki GitLab) akkaunt — Render kodni **git repodan** oladi, zip
  fayldan emas.
- Render.com akkaunt (GitHub bilan kirish mumkin), Free tarif yetarli.
- BotFather'dan olingan `BOT_TOKEN`.

## 2. Kodni GitHub'ga yuklash

```bash
cd kinobot-project
git init
git add .
git status   # backend/.env RO'YXATDA YO'QLIGINI TEKSHIRING (.gitignore uni yashiradi)
git commit -m "KinoBot — Render Free uchun tayyor"
git branch -M main
git remote add origin https://github.com/SIZNING_USERNAME/kinobot.git
git push -u origin main
```

`.gitignore` va `.dockerignore` fayllari loyihaga allaqachon qo'shilgan —
`backend/.env` (ichida `BOT_TOKEN`, `ADMIN_KEY`) hech qachon commit
qilinmaydi va Docker image ichiga ham tushmaydi. `git status` bilan
tasdiqlab oling.

## 3. Render'da Blueprint orqali deploy qilish

1. https://dashboard.render.com → **New** → **Blueprint**.
2. GitHub repongizni tanlang (kinobot).
3. Render `render.yaml`ni avtomatik topadi va **bitta** xizmatni ko'rsatadi:
   `kinobot` (Web Service, Free tarif) — bu xizmat ichida `start-all.js`
   orqali API/WebApp VA Telegram bot birga ishlaydi.
4. **Apply** tugmasini bosing — xizmat yaratiladi, lekin maxfiy
   o'zgaruvchilar (`sync: false` bo'lganlar) hali bo'sh, ular kelmaguncha
   to'liq ishlamaydi.

## 4. Muhit o'zgaruvchilarini to'ldirish

Render dashboard → **kinobot** → **Environment**:

| Kalit | Qiymat |
|---|---|
| `BOT_TOKEN` | BotFather bergan token |
| `ADMIN_ID` | Sizning Telegram ID'ingiz |
| `ADMIN_KEY` | O'zingiz o'ylab topgan kuchli parol (X-Admin-Key uchun) |
| `WEBAPP_URL` | Shu xizmatning o'z Render URL'i, masalan `https://kinobot.onrender.com` |
| `ALLOWED_ORIGINS` | Odatda bo'sh qoldiring (frontend bir xil origin) |
| R2 kalitlari (tavsiya etiladi) | Video'ni Cloudflare R2'da saqlash uchun. Free tarifda doimiy disk bo'lmagani sababli, video uchun R2 ishlatish tavsiya etiladi — aks holda video ham xizmat uxlab-uyg'onganda yo'qoladi |

`WEBAPP_URL`ni birinchi marta faqat xizmat deploy bo'lib, URL manzili
ma'lum bo'lgandan keyin to'ldirasiz — so'ng **Manual Deploy → Deploy
latest commit** bilan qayta ishga tushiring (yoki "Save" — Render env
o'zgarganda avtomatik qayta ishga tushiradi).

## 5. Tekshirish

- `https://kinobot.onrender.com/api/health` — `{"ok":true,...}` qaytarishi
  kerak (birinchi so'rov xizmat "uyg'onishi" kerak bo'lsa 30-60s cho'zilishi
  mumkin).
- `https://kinobot.onrender.com/` — WebApp (frontend) ochilishi kerak.
- Telegram botga `/start` yuboring — WebApp tugmasi shu manzilni ochadi.
- **Logs** bo'limida ikkalasining ham chiqishi ko'rinadi: server.js'ning
  "KinoBot API ... portida ishga tushdi" xabari va bot.js'ning polling
  boshlanganini bildiruvchi xabari (start-all.js ikkalasini ham bir joyga
  chiqaradi).

## 6. Ma'lumotlar (db.json, poster, video) haqida — MUHIM

Free tarifda **doimiy disk yo'q**. Bu degani:

- `backend/data/db.json` (filmlar, foydalanuvchilar, sevimlilar, tarix,
  to'lovlar) xizmat qayta ishga tushganda (deploy, yoki 15 daqiqadan keyin
  uxlab-uyg'onish) **butunlay tozalanadi**.
- Lokal saqlangan video/poster/banner ham xuddi shunday yo'qoladi —
  shuning uchun video uchun **R2**ni ishlatish tavsiya etiladi (4-bo'limga
  qarang) — R2 Render'dan mustaqil, xizmat qayta tushsa ham video
  saqlanib qoladi. Poster/banner rasmlar hozircha faqat lokal diskka
  yoziladi — Free tarifda ular ham qayta tushganda yo'qoladi (bu — kelajakda
  ular uchun ham tashqi saqlash qo'shish mumkin bo'lgan joy).

Agar bu siz uchun muammo bo'lsa — yagona to'liq yechim: Starter+ tarifga
o'tib, `render.yaml`dagi izohlangan `disk:` bo'limini yoqish (5 daqiqalik
ish). Kod tomondan hech narsa o'zgartirish shart emas.

## 7. (Ixtiyoriy) Botni uyg'oq ushlab turish

Render Free 15 daqiqa HTTP so'rovsiz qolsa xizmatni uxlatadi — bu botga
ham ta'sir qiladi. Rasmiy yechim yo'q, lekin keng qo'llaniladigan amaliy
usul: tashqi bepul xizmat (masalan cron-job.org yoki UptimeRobot) orqali
har 10-14 daqiqada `https://kinobot.onrender.com/api/health`ga so'rov
yuborib turish. Bu 100% kafolat bermaydi (masalan deploy paytida yoki
juda qisqa vaqt oralig'ida xabar kelib qolsa, bot javob berolmasligi
mumkin), lekin amalda botni deyarli doim uyg'oq ushlab turadi.

## 8. Nima o'zgartirildi (avvalgi versiyaga nisbatan)

- **`backend/server.js`**: `.env` yuklovchi funksiyadagi xato tuzatildi —
  avval u Render'ning o'zi bergan `PORT`ni majburan almashtirib
  qo'yardi va `NODE_ENV=production`ni o'chirib tashlardi (agar `.env`
  faylda aynan shu qiymatlar yozilmagan bo'lsa). Bu ikkalasi ham real
  deployni buzishi mumkin edi: port mos kelmasa Render "portni
  aniqlay olmadi" deb deployni muvaffaqiyatsiz deb belgilaydi;
  NODE_ENV o'chib qolsa esa xavfsizlik devor-mode'ga tushib qolardi.
- **`backend/start-all.js`** (yangi fayl): `server.js` va `bot.js`ni
  bitta xizmat ichida birga ishga tushiradi (Free tarifda alohida
  Background Worker yo'qligi sababli). Ikkala fayl o'zi
  o'zgartirilmagan.
- **`.gitignore`, `.dockerignore`** (yangi): `backend/.env` (maxfiy
  tokenlar) endi hech qachon commit yoki Docker image'ga tushmaydi.
- **`render.yaml`**: 2 xizmatdan (web + worker) 1 ta Free web-xizmatga
  qayta qurildi, `start-all.js`ni ishga tushiradi.
- `backend/`, `frontend/` ichidagi biznes-logika kodiga (route'lar,
  repository'lar, frontend JS/CSS) hech qanday tegilmagan.
