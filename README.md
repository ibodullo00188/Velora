# KinoBot — Telegram Mini App

KinoBot — Telegram orqali ishlaydigan kino katalogi. Bot (`backend/bot.js`)
WebApp'ni ochadigan tugma yuboradi, WebApp (`frontend/`) 12 ekranli kino
ilovasi bo'lib REST API (`backend/server.js`) orqali ma'lumot oladi.

**Tashqi kutubxonasiz** — backend faqat Node.js ichki modullarini
(`http`, `crypto`, `fs`, `https`) ishlatadi. `npm install` shart emas.

---

## Tarkib

| Papka | Vazifasi | Batafsil |
|---|---|---|
| `frontend/` | Telegram WebApp (HTML/CSS/JS SPA) — katalog, qidiruv, player, admin | [frontend/README.md](frontend/README.md) |
| `backend/` | REST API (Node.js) — filmlar, sevimlilar, tarix, admin CRUD, R2 video | [backend/README.md](backend/README.md) |

## Arxitektura

```
Telegram foydalanuvchi
        │  /start
        ▼
   Telegram Bot (backend/bot.js)
        │  inline tugma (WebApp URL)
        ▼
   Telegram WebView ──► frontend/ (index.html + app.js)
        │  fetch (X-Telegram-Init-Data header)
        ▼
   REST API (backend/server.js, :3000)
        │                    │
        ▼                    ▼ (presigned URL, video)
   data/db.json      Cloudflare R2 (private bucket)
   (fayl-asosidagi DB)
```

- Bot ↔ backend **bevosita bog'liq emas** — ular faqat `.env`dagi `BOT_TOKEN`
  orqali bog'lanadi (frontend `initData` imzosini tekshirish uchun).
- Autentifikatsiya: WebApp `Telegram.WebApp.initData`'ni
  `X-Telegram-Init-Data` header orqali yuboradi, backend HMAC-SHA256 bilan
  tekshiradi.

## Bir buyruq bilan ishga tushirish (Kali / Debian)

```bash
bash quickstart.sh
```

Bu skript Node.js va cloudflared yo'q bo'lsa o'rnatadi, `backend/.env`ni
`.env.example`dan yaratadi, BOT_TOKEN (va ixtiyoriy ADMIN_ID) so'raydi, so'ng
backend + HTTPS tunnel (cloudflared) + Telegram bot'ni birga ishga tushiradi.
Keyingi safar ham xuddi shu buyruq bilan ishga tushirasiz (qayta so'ramaydi).

Boshqarish:

```bash
bash deploy/start-server.sh status   # holatni ko'rish
bash deploy/start-server.sh stop     # to'xtatish
```

## Qo'lda, bosqichma-bosqich ishga tushirish

```bash
# 1) Backend (port 3000)
cd backend
cp .env.example .env      # BOT_TOKEN, WEBAPP_URL, ADMIN_ID/ADMIN_KEY to'ldiring
node server.js            # http://localhost:3000

# 2) Frontend (boshqa terminalda) — statik server
cd frontend
python3 -m http.server 8080    # http://localhost:8080

# 3) Telegram bot (uchinchi terminalda)
cd backend
node bot.js
```

Telegram WebApp faqat **HTTPS** manzillarni ochadi. Lokal test uchun tunnel
kerak bo'ladi (masalan `cloudflared tunnel --url http://localhost:8080` yoki
ngrok), olingan `https://...` manzilni `.env`dagi `WEBAPP_URL`ga yozing.

## Frontendni backendga ulash

`frontend/js/api.js` standart manzil sifatida `/api` (bir xil origin) ishlatadi.
Backend boshqa origin/portda bo'lsa, `index.html`da `api.js`dan **oldin**:

```html
<script>window.KINOBOT_API_URL = "http://localhost:3000/api";</script>
```

Backend mavjud bo'lmasa, ilova **lokal demo rejimida** ishlashda davom etadi
(faqat admin panel va sync xususiyatlari ishlamaydi).

## Testlar

```bash
cd backend
npm test          # 124+ ta test (node --test)
```

---

To'liq hujjat: [backend/README.md](backend/README.md) va
[frontend/README.md](frontend/README.md).
