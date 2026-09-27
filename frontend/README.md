# KinoBot WebApp — Telegram Mini App

Telegram WebView'da ishlaydigan SPA ilova. 12 ekran, vanilla JavaScript
(frameworksiz), qorong'i tema, i18n (uz/en/ru), haqiqiy video player,
backend'ga to'liq ulangan admin panel.

---

## Ishga tushirish

```bash
python3 -m http.server 8080     # istalgan static server
# yoki: npx serve . / npx http-server / GitHub Pages / Vercel / Netlify
```

Telegram BotFather'da Web App URL sifatida manzilni kiriting. Ilova
`telegram-web-app.js` CDN'dan yuklanadi va Telegram temasiga moslashadi.

## Backend bilan bog'lash

`js/api.js` default sifatida `/api` (bir xil origin) ishlatadi. Backend
boshqa portda bo'lsa, `index.html`da `js/api.js`dan **oldin**:

```html
<script>window.KINOBOT_API_URL = "http://localhost:3000/api";</script>
```

Backend topilmasa — ilova **lokal demo rejimida** ishlaydi (admin panel va
sync ishlamaydi). Backend ishlasa: filmlar, sevimlilar, tarix, profil
avtomatik sinxronlanadi.

---

## Ekranlar (12 ta)

| # | ID | Vazifasi |
|---|---|---|
| 1 | `screen-home` | Banner slider, trenddagi filmlar, janr chiplari |
| 2 | `screen-catalog` | Janr plitkalari + barcha filmlar (backend'dan filtr) |
| 3 | `screen-search` | Qidiruv (backend `getMovies({q})` orqali) |
| 4 | `screen-detail` | Film: hero, tavsif, o'xshash filmlar (backend'dan) |
| 5 | `screen-player` | Haqiqiy `<video>` elementi, videoSources, progress saqlash |
| 6 | `screen-favorites` | Sevimli filmlar (backend sync) |
| 7 | `screen-history` | Ko'rish tarixi (progress barlari) |
| 8 | `screen-profile` | Avatar, ism, menyu (backend'dan profil) |
| 9 | `screen-admin` | Admin panel (3 tab: filmlar/janrlar/foydalanuvchilar) |
| 10 | `screen-settings` | Til (uz/en/ru), mavzu (dark/light/system) |
| 11 | `screen-filter` | Janr + yil/reyting sliderlari |
| 12 | `screen-info` | Ilova haqida, maxfiylik, shartlar |

## Xususiyatlari

### I18n (Xalqaro tillar)

`DICT` obyektida `uz`, `en`, `ru` tillari. `t(key, vars)` funksiya —
matnlarni joriy tilga tarjima qiladi. Sozlamalardan til almashtirish:
`localStorage.kb_lang` saqlanadi.

### Tema (Dark / Light / System)

Dark tema standart (`--bg: #0a0a0f`). Sozlamalardan tema almashtirish:
`localStorage.kb_theme` saqlanadi. `prefers-color-schemaga` moslashish
mavjud.

### Admin panel

Admin panel (`#admin` yoki profil menyu orqali) backend bilan to'liq
ulangan:

1. Kirish: admin kalit kiritiladi → backend `adminStats` orqali tekshiriladi.
2. **Filmlar tab**: ro'yxat, "Film qo'shish" (modal form), tahrirlash, o'chirish.
3. **Janrlar tab**: ro'yxat, qo'shish, o'chirish.
4. **Foydalanuvchilar tab**: ro'yxat (ism, username, ro'yxatdan o'tgan sana).

Admin auth: frontend `X-Admin-Key` header orqali yoki backend'dagi `ADMIN_ID`
(Telegram user ID) orqali ishlaydi.

### Video player

`#screen-player` haqiqiy `<video>` elementini ishlatadi. Film obyektidagi
`videoSources.url` (MP4/HLS) o'ynatiladi. "Ko'rish" bosilganda `recordHistory`
chaqiriladi (backend'ga progress yoziladi).

`videoSources` bo'sh/null bo'lsa — "video manbasi yo'q" xabari ko'rsatiladi.

### Backend qidiruv/filtr

Qidiruv va katalog backend `GET /api/movies?q=...&genre=...&yearMin=...&ratingMin=...`
orqali ishlaydi — qidiruv serverda bajariladi.

### Posterlar

Rasm emas — CSS gradient (`g0`–`g7`) + film nomining birinchi harfi.
`posterUrl`/`backdropUrl` mavjud bo'lsa haqiqiy rasm ko'rsatiladi.

---

## Papka tuzilishi

```
frontend/
├── index.html         # 12 ekranli SPA markup + inline SVG ikonlar
├── css/
│   └── style.css      # Dark tema, CSS custom properties, flexbox/grid, mobil-first
├── js/
│   ├── app.js         # SPA logika: render, navigatsiya, state, i18n, admin, player
│   └── api.js         # window.KinoBotApi — backend aloqa qatlami
└── assets/            # Rasm/assetlar (hozircha bo'sh)
```

## Texnologiyalar

- **Framework yo'q** — vanilla JS, DOM manipulyatsiya
- **CSS**: custom properties, flexbox/grid, `env(safe-area-inset-*)`, media query
- **Ikonlar**: inline SVG (Feather-style), `ICONS` obyekti + `icon()` funksiya
- **Font**: Inter (Google Fonts, CDN)
- **Telegram SDK**: `telegram-web-app.js` (CDN) — `tg.ready()`, `tg.expand()`,
  `tg.BackButton`, `tg.initDataUnsafe`
- **Navigatsiya**: `openScreen()` + `navStack` (LIFO), hash routing emas
- **State**: global `state` obyekti (frameworksiz)
- **Responsive**: mobile-first, `max-width: 480px`, safe-area, 360px breakpoint

## Backendga ulanmagan holatda

Lokal demo rejimida (backend yo'q bo'lsa) ilova ishlaydi:
- Film katalogi: `state.movies` fallback'dan (agar backend'dan olinsa —
  `KinoBotApi.getMovies()` natijasi)
- Sevimlilar: `state.favorites` Set (localStorage)
- Tarix: `state.history` (lokal)
- Admin: backend bo'lmasa API so'rovlari xatolik qaytaradi
