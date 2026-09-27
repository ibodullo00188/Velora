# KinoBot Backend (REST API)

Telegram Mini App (KinoBot) uchun tashqi kutubxonasiz REST API.
Faqat Node.js ichki modullari (`http`, `crypto`, `fs`, `https`) — shuning uchun
`npm install` shart emas, internet yo'q joyda ham ishlaydi.

- Node.js **>= 18** (testlar `node --test` ishlatadi).
- Ma'lumotlar `data/db.json` faylida (atomic yozish: temp fayl + rename).

---

## 1. O'rnatish va ishga tushirish

```bash
cp .env.example .env     # BOT_TOKEN, WEBAPP_URL, ADMIN_ID/ADMIN_KEY to'ldiring
node server.js           # yoki: npm start   /   npm run dev (--watch)
```

Server: `http://localhost:3000`
Health check: `GET http://localhost:3000/api/health`

`.env` fayl avtomatik o'qiladi (agar mavjud bo'lsa). `process.env`da allaqachon
o'rnatilgan qiymat ustiga yozilmaydi.

### Telegram bot (bot.js)

`bot.js` alohida jarayon sifatida ishlaydi (long polling — webhook shart emas):

```bash
node bot.js
```

Bot ishga tushganda avtomatik `setMyCommands` orqali Telegram'ga buyruqlar
ro'yxatini yozadi (start, catalog, help, admin). Mavjud buyruqlar:

| Buyruq | Tavsif |
|---|---|
| `/start` | Tabriklash + WebApp tugmasi (`🎬 Kino katalogi` va `❓ Yordam`) |
| `/catalog` | Kino katalogini ochadigan WebApp tugmasi |
| `/help` | Barcha buyruqlar ro'yxati |
| `/admin` | Admin panel (faqat `ADMIN_ID`ga mos user; aks holda muloyim rad etish) |

Bot `409 Conflict` (yana bir nusxa ishlayotganda) va tarmoq xatolari uchun
exponential backoff bilan qayta urinadi, `SIGINT`/`SIGTERM` bilan esa toza
(graceful) to'xtaydi — `kill -TERM <pid>` xavfsiz.

---

## 2. API endpointlari

Barcha javoblar `{ ok: true, data: ... }` yoki `{ ok: false, error: { code, message } }`
formatida. Kodlar: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`,
`RATE_LIMITED`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `CONFIG_ERROR`, `INTERNAL_ERROR`.

### Ommaviy (auth talab qilinmaydi)

| Metod | Yo'l | Tavsif |
|---|---|---|
| GET | `/api/health` | Server holati `{status, time}` |
| GET | `/api/ready` | Tayyorgarlik tekshiruvi `{status, checks}` |
| GET | `/api/movies?genre=&q=&yearMin=&yearMax=&ratingMin=&sort=` | Filmlar ro'yxati. `sort`: `new` / `rating` / `title` |
| GET | `/api/movies/:id` | Bitta film + 6 ta o'xshash |
| GET | `/api/genres` | Barcha janrlar |

### Himoyalangan (verified Telegram user yoki DEV_MODE'da `?userId=`)

| Metod | Yo'l | Tavsif |
|---|---|---|
| GET | `/api/profile` | Foydalanuvchi profili (+ `isAdmin`). User avtomatik saqlanadi |
| GET | `/api/favorites` | Sevimli filmlar |
| POST | `/api/favorites/toggle` `{movieId}` | Sevimlilarga qo'shish/olib tashlash |
| GET | `/api/history` | Ko'rish tarixi (progress bilan, `movie` join qilingan) |
| POST | `/api/history` `{movieId, progressPct}` | Progressni saqlash (0–100, yangilanadi) |
| POST | `/api/auth/telegram` `{initData}` | initData tasdiqlash + user saqlash |
| GET | `/api/movies/:id/video/:quality` | R2 signed video URL (300s). `quality`: `360p`/`480p`/`720p`/`1080p` |

### Admin (auth: ADMIN_ID yoki X-Admin-Key)

| Metod | Yo'l | Tavsif |
|---|---|---|
| GET | `/api/admin/stats` | Umumiy statistika (filmlar, foydalanuvchilar, janrlar, fav, tarix) |
| GET | `/api/admin/movies?...` | Barcha filmlar (filtr: `q, genre, yearMin, yearMax, ratingMin`) |
| POST | `/api/admin/movies` | Yangi film (validatsiya) |
| PUT | `/api/admin/movies/:id` | Filmni tahrirlash (partial — faqat berilgan maydonlar) |
| DELETE | `/api/admin/movies/:id` | Filmni o'chirish (R2 videolar ham tozalanadi) |
| POST | `/api/admin/movies/:id/video/presign` `{quality, contentType, size}` | R2 presigned PUT URL (browser to'g'ridan-to'g'ri upload) |
| POST | `/api/admin/movies/:id/video/confirm` `{quality, size?}` | Upload tugaganini R2'da tekshirib, `videoSources`ga bog'laydi |
| DELETE | `/api/admin/movies/:id/video/:quality` | Video o'chirish (R2 object + DB) |
| GET | `/api/admin/genres` | Janrlar |
| POST | `/api/admin/genres` `{name}` | Janr qo'shish (duplikat → 409) |
| DELETE | `/api/admin/genres/:name` | Janrni o'chirish |
| GET | `/api/admin/users` | Foydalanuvchilar ro'yxati |
| POST | `/api/admin/users/:id/block` | Foydalanuvchini bloklash |
| POST | `/api/admin/users/:id/unblock` | Foydalanuvchini blokdan chiqarish |
| PUT | `/api/admin/users/:id` `{isAdmin?, status?}` | Foydalanuvchi holatini yangilash |
| GET | `/api/admin/audit-log` | Admin audit log |

### Film formati

```json
{
  "id": "dune2",
  "title": "Dune: Part Two",
  "originalTitle": "",
  "year": 2024,
  "genres": ["Sci-Fi", "Action"],
  "rating": 8.9,
  "duration": "2h 46m",
  "description": "...",
  "poster": "g0",
  "posterUrl": "https://...",
  "backdropUrl": "https://...",
  "videoSources": { "url": "https://.../video.mp4" },
  "createdAt": "...",
  "updatedAt": "..."
}
```

`poster` — CSS gradient kaliti (`g0`–`g7`), rasm emas. `videoSources` —
obyekt yoki `null`. Ikkita format qo'llab-quvvatlanadi:

1. **Eski format** — to'g'ridan-to'g'ri URL:
   ```json
   "videoSources": { "url": "https://.../video.mp4" }
   ```
2. **R2 format** — quality bo'yicha manbalar (`objectKey` faqat admin javobida ko'rinadi):
   ```json
   "videoSources": {
     "720p": { "objectKey": "movies/dune2/720p.mp4", "size": 524288000, "uploadedAt": "2026-08-11T12:00:00Z" },
     "1080p": { "objectKey": "movies/dune2/1080p.mp4", "size": 1048576000, "uploadedAt": "2026-08-11T12:05:00Z" }
   }
   ```
   Ikkala format birga yashay oladi (eski `url` key saqlanadi). Public API
   javoblarida `objectKey` yashiriladi — `{size, uploadedAt}` qoladi.

Player faqat R2'da mavjud quality'larni ko'rsatadi.

### Misollar

```bash
# Action janri, reyting bo'yicha
curl "http://localhost:3000/api/movies?genre=Action&sort=rating"

# Qidiruv
curl "http://localhost:3000/api/movies?q=dune"

# DEV_MODE: fav'ga qo'shish (userId query orqali)
curl -X POST "http://localhost:3000/api/favorites/toggle?userId=123" \
  -H "Content-Type: application/json" -d '{"movieId":"dune2"}'

# Admin (X-Admin-Key orqali)
curl -X POST http://localhost:3000/api/admin/movies \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: sizning-kalit" \
  -d '{"title":"Yangi Film","year":2025,"genres":["Action"],"rating":7.5,"duration":"2h 00m"}'
```

---

## 3. Autentifikatsiya

### Telegram (tavsiya etilgan)

Frontend `Telegram.WebApp.initData`'ni `X-Telegram-Init-Data` header orqali
yuboradi. Backend `src/telegramAuth.js` imzoni HMAC-SHA256 bilan tekshiradi
(secret = `HMAC("WebAppData", BOT_TOKEN)`), `auth_date` 24 soatdan eski bo'lsa
rad etadi. Tekshirilgan user ID barcha himoyalangan endpointlar uchun ishlatiladi
— query/body'dagi `userId` e'tiborga olinmaydi.

### DEV_MODE (`DEV_MODE=1` yoki `DEV_MODE=true`)

`X-Telegram-Init-Data` bo'lmasa, `?userId=` query yoki body'dagi `userId`
qabul qilinadi. Bu **faqat lokal rivojlantirish uchun**.

DIQQAT: standart holat — o'chiq (fail-closed). Avvalgi versiyada
`NODE_ENV != production` bo'lsa avtomatik yoqilardi — bu xavfli edi,
chunki `NODE_ENV` o'rnatilmagan har qanday production server ham
"dev" deb hisoblanardi. Endi faqat `DEV_MODE` aniq `1`/`true`
qilib qo'yilganda yoqiladi.

### Admin — ikki usul

1. **ADMIN_ID** (tavsiya etilgan): `.env`dagi `ADMIN_ID` = Telegram user ID.
   Shu user Telegram orqali kirsa, barcha `/api/admin/*` endpointlari ochiladi.
2. **X-Admin-Key**: `ADMIN_KEY` o'rnatilgan bo'lsa, header orqali yuboriladi
   (constant-time taqqoslash).

`ADMIN_ID` ham `ADMIN_KEY` ham bo'lmasa → admin endpointlar **503/500
`CONFIG_ERROR`** qaytaradi (xavfsizlik — default kalit yo'q).

---

## 4. Xavfsizlik

- **Rate limiting** (`src/rateLimit.js`): umumiy 240 so'rov/min, auth 20/min,
  admin 60/min. Limitdan oshsa `429` + `Retry-After`.
- **Validatsiya** (`src/validation.js`): title, year (1888–joriy+2), rating
  (0–10), genres, URL'lar (`http(s)`), videoSources — barcha admin inputlari.
  Body 2MB dan oshsa `413`.
- **CORS**: `ALLOWED_ORIGINS` ro'yxati. Production'da (`NODE_ENV=production`)
  faqat ro'yxatdagi originlarga ruxsat; ro'yxat bo'sh bo'lsa — faqat o'z
  origini. Dev'da barchaga ochiq (`*`).
- **Atomic yozish**: `db.js` temp fayl + rename — jarayon o'lsa ham `db.json`
  buzilmaydi.
- `.env` fayl git'ga kirmaydi (`.gitignore`). `ADMIN_KEY` uchun default yo'q.
- **Xavfsizlik headerlari**: har bir API javobiga `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()`,
  `Cache-Control: no-store` qo'shilgan.

---

## 5. Logging (PHASE 8)

Strukturalangan JSON logging (`src/logger.js`):

- Log darajalari: `debug`, `info`, `warn`, `error`
- Har bir log — bitta JSON qatori: `{ time, level, msg, requestId?, userId?, ...extras }`
- `LOG_LEVEL` .env dan (default `info`)
- `LOG_FILE` .env dan — faylga yozish (default console)
- Xatoliklarda `stack` trace ham yoziladi
- Barcha `console.*` o'rniga `logger.*` ishlatiladi
- Audit log yozuvlari ham logger'ga yuboriladi

### ENV o'zgaruvchilari (Logging)

| O'zgaruvchi | Tavsif |
|---|---|
| `LOG_LEVEL` | `debug` | `info` | `warn` | `error` (default `info`) |
| `LOG_FILE` | Log fayli yo'li (default console) |

---

## 6. Backup / Recovery (PHASE 9)

### Avtomatik backup

Server ishga tushganda `BACKUP_ENABLED=1` bo'lsa avtomatik backup yoqiladi:

- Interval: `BACKUP_INTERVAL` daqiqada (default 60 = 1 soat)
- Retention: `BACKUP_RETENTION` ta oxirgi backup saqlanadi (default 10)
- Backup fayllari: `data/backups/db-<ISO>-auto.json`

```bash
BACKUP_ENABLED=1 BACKUP_INTERVAL=60 BACKUP_RETENTION=10 node server.js
```

### Qo'lli backup/restore (skriptlar)

```bash
# Backup yaratish
node scripts/db-backup.js [--retention=10]

# Backup'lar ro'yxati
node scripts/db-restore.js --list

# Oxirgi backup'dan tiklash
node scripts/db-restore.js

# Aniq fayldan tiklash
node scripts/db-restore.js data/backups/db-2024-01-15T10-30-00-auto.json

# Migratsiya (schema yangilash)
node scripts/db-migrate.js [--backup] [--check]
```

### Restore tekshiruvlari

`restoreBackup` faylni tiklashdan oldin:
1. JSON validligini tekshiradi
2. Schema maydonlari (`movies`, `users`, `genres`, `favorites`, `history`, `auditLog`, `analytics`) mavjudligini tekshiradi
3. Agar validatsiya o'tmasa — DB'ga yozmaydi, xato beradi

### README

To'liq qo'llanma `deploy/DEPLOY.md` da.

---

## 7. Cloudflare R2 video storage

Video fayllar GitHub/repo ichida saqlanmaydi — **private R2 bucket**'da.
Server R2 secretlarini hech qachon browserga yubormaydi; admin va user faqat
**vaqtinchalik presigned URL** oladi.

### Oqim (flow)

```
Upload:  Admin WebApp -> POST /video/presign -> presigned PUT URL -> browser R2'ga PUT
Ko'rish: WebApp User -> GET /movies/:id/video/:quality -> presigned GET URL (300s) -> Player
```

### Sozlash

1. **Bucket yaratish**: Cloudflare dashboard → R2 → Create bucket
   (masalan `kinobot-videos`). Bucket **private** bo'lishi kerak (Public Access OFF).
2. **API token**: R2 → Manage R2 API Tokens → Create API Token.
   Permission: **Object Read & Write**, faqat shu bucket uchun.
   `Access Key ID` va `Secret Access Key`ni saqlang (faqat bir marta ko'rsatiladi).
3. **ENV to'ldirish** (barcha 4 tasi):
   ```
   CLOUDFLARE_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET_NAME=kinobot-videos
   ```
4. Serverni qayta ishga tushiring.

R2 sozlanmagan bo'lsa video endpointlari `503 SERVICE_UNAVAILABLE` qaytaradi,
qolgan API ishlayveradi (backward compatible).

### Xavfsizlik

- Presigned PUT/GET URL ularning vaqtinchalik (PUT: 15 daqiqa, GET: 5 daqiqa).
- Upload va ko'rish **faqat WebApp** orqali; Telegram bot'da video yo'q.
- Upload faqat admin (`requireAdmin`), ko'rish faqat verified user.
- Presigned GET URL'da imzo yolg'onchilar URL'ni o'zgartirsa buziladi.
- Film o'chirilganda `movies/{id}/` prefix ostidagi barcha R2 objectlar
  avtomatik tozalanadi (orphan oldini olish).

---

## 8. Testlar

```bash
npm test          # node --test "tests/*.test.js"
```

124+ ta test: `db.test.js`, `rateLimit.test.js`, `telegramAuth.test.js`,
`validation.test.js`, `server.test.js`, `logger.test.js`, `backup.test.js`,
`r2.test.js` (to'liq HTTP e2e: auth, fav, tarix, admin CRUD, logging, backup,
R2 SigV4 + presigned URL + R2 video endpointlar).

---

## 9. Papka tuzilishi

```
backend/
├── server.js           # HTTP server + router (barcha endpointlar)
├── bot.js              # Telegram bot (long polling) — alohida jarayon
├── src/
│   ├── db.js            # Fayl-asosidagi DB (atomic yozish, normalize)
│   ├── telegramAuth.js  # initData HMAC-SHA256 tekshiruvi
│   ├── validation.js    # Input validatsiyasi
│   ├── rateLimit.js     # Xotiradagi rate limiter
│   ├── logger.js        # Strukturlog (JSON)
│   ├── auditLog.js      # Admin audit log
│   ├── backup.js        # Backup/restore tizimi
│   ├── r2.js            # Cloudflare R2 (SigV4, presigned URL, delete/list)
│   └── repositories/    # Repo pattern (movies, users, genres, fav, history, analytics)
├── tests/               # 7 ta test fayli (node --test)
├── data/
│   └── db.json          # Filmlar, janrlar, sevimlilar, tarix, foydalanuvchilar
│   └── backups/         # Avtomatik backup nusxalari
├── scripts/
│   ├── db-backup.js     # Qo'lli backup
│   ├── db-restore.js    # Qo'lli restore
│   └── db-migrate.js    # Schema migratsiya
├── .env.example
└── package.json
```

---

## 10. Productionga o'tish (keyingi qadamlar)

1. **Haqiqiy DB**: `src/db.js`ning `load()`/`persist()`'ini SQLite
   (`better-sqlite3`) yoki PostgreSQL bilan almashtirish kifoya — `server.js`
   faqat shu modul orqali DB ishlatadi.
2. **HTTPS + reverse proxy**: nginx/Caddy ortida, `NODE_ENV=production`.
3. **Admin**: `ADMIN_ID`ni o'rnating, `ADMIN_KEY`ni olib tashlashingiz mumkin.
4. **Video storage**: real videolar uchun R2/S3 + signed URL.
5. **Deploy**: `Dockerfile` + `docker-compose.yml` papka ildizida tayyor.

---

## 11. ENV o'zgaruvchilari

| O'zgaruvchi | Majburiy | Tavsif |
|---|---|---|
| `PORT` | Yo'q | Server porti (default `3000`) |
| `BOT_TOKEN` | Ha (auth uchun) | BotFather tokeni — initData tekshiruvi + bot |
| `ADMIN_ID` | Yo'q (ADMIN_KEY muqobil) | Admin Telegram user ID |
| `ADMIN_KEY` | Yo'q (ADMIN_ID muqobil) | Admin maxfiy kalit (X-Admin-Key) |
| `WEBAPP_URL` | Bot uchun ha | WebApp HTTPS manzili (`bot.js`da ishlatiladi) |
| `NODE_ENV` | Yo'q | `production` → qat'iy CORS + dev-mode o'chiq |
| `DEV_MODE` | Yo'q | `1` bo'lsa dev-mode majburan yoqiladi |
| `ALLOWED_ORIGINS` | Production uchun | Vergul bilan ajratilgan ruxsat etilgan originlar |
| `LOG_LEVEL` | Yo'q | `debug` | `info` | `warn` | `error` (default `info`) |
| `LOG_FILE` | Yo'q | Log fayli yo'li (default console) |
| `BACKUP_ENABLED` | Yo'q | `1`/`true` — avtomatik backup yoqish |
| `BACKUP_INTERVAL` | Yo'q | Avtomatik backup intervali daqiqada (default 60) |
| `BACKUP_RETENTION` | Yo'q | Saqlanadigan backup soni (default 10) |
| `ANALYTICS_FLUSH_MS` | Yo'q | Analytics buffer flush intervali (default 30000) |
| `CLOUDFLARE_ACCOUNT_ID` | Video uchun | Cloudflare account ID (R2 endpoint) |
| `R2_ACCESS_KEY_ID` | Video uchun | R2 API token — Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Video uchun | R2 API token — Secret Access Key |
| `R2_BUCKET_NAME` | Video uchun | Private R2 bucket nomi (masalan `kinobot-videos`) |
