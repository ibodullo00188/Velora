# KinoBot Production Deploy Qo'llanmasi

Bu hujjat KinoBot'ni production serverda (Linux, Docker yoki systemd) ishga tushirish bo'yicha to'liq yo'riqnoma.

---

## 1. Server tayyorlovi

### Minimal talablar

- **OS**: Ubuntu 22.04+/24.04 LTS yoki Debian 12
- **RAM**: 512 MB+ (API + bot + nginx uchun)
- **Disk**: 2 GB+ (db.json + backup + loglar)
- **Portlar**: 80 (HTTP), 443 (HTTPS), 3000 (API ichki)

### Paketlar

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Nginx + Certbot (SSL)
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Docker (variant 1 uchun)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Docker Compose v2 (standalone)
sudo apt-get install -y docker-compose-plugin
```

---

## 2. Loyiha deploy qilish

### Variant A: Docker Compose (tavsiya etilgan)

```bash
# 1. Repo'ni klonlash
git clone https://github.com/siz/kinobot.git /opt/kinobot
cd /opt/kinobot

# 2. .env faylini yaratish
cp backend/.env.example backend/.env
# backend/.env ni tahrirlang (BOT_TOKEN, ADMIN_ID, ADMIN_KEY, WEBAPP_URL, ALLOWED_ORIGINS)

# 3. Frontend'ni build qilish (faqat statik fayl nusxalash — build shart emas)
mkdir -p /var/www/kinobot
rsync -av frontend/ /var/www/kinobot/frontend/

# 4. Nginx sozlash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kinobot
sudo sed -i 's/server_name _;/server_name sizning-domeningiz.com;/' /etc/nginx/sites-available/kinobot
sudo ln -sf /etc/nginx/sites-available/kinobot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. SSL sertifikati (Let's Encrypt)
sudo certbot --nginx -d sizning-domeningiz.com

# 6. Docker Compose ishga tushirish
docker compose up -d --build

# 7. Holatni tekshirish
docker compose ps
docker compose logs -f api
```

### Variant B: Systemd (Docker'siz)

```bash
# 1. Loyiha katalogi
sudo mkdir -p /opt/kinobot
sudo chown $USER:$USER /opt/kinobot
git clone https://github.com/siz/kinobot.git /opt/kinobot
cd /opt/kinobot

# 2. .env
cp backend/.env.example backend/.env
# .env ni to'ldiring

# 3. Frontend
mkdir -p /var/www/kinobot
rsync -av frontend/ /var/www/kinobot/frontend/

# 4. Nginx + SSL (yuqoridagi kabi)

# 5. Systemd xizmatlari
sudo cp deploy/kinobot-api.service /etc/systemd/system/
sudo cp deploy/kinobot-bot.service /etc/systemd/system/

# Yo'llarni sozlash (WorkingDirectory, User, EnvironmentFile)
sudo systemctl daemon-reload
sudo systemctl enable --now kinobot-api kinobot-bot

# 6. Loglar
sudo journalctl -u kinobot-api -f
sudo journalctl -u kinobot-bot -f
```

---

## 3. Muhim sozlamalar (.env)

```env
# Majburiy
BOT_TOKEN=123456789:ABC...                    # @BotFather dan
WEBAPP_URL=https://sizning-domeningiz.com     # HTTPS majburiy!
ADMIN_ID=987654321                            # Sizning Telegram user ID'ingiz

# Ixtiyoriy (birini o'rnating)
ADMIN_KEY=super-secret-admin-key-32-chars     # X-Admin-Key header uchun

# Production uchun
NODE_ENV=production
ALLOWED_ORIGINS=https://sizning-domeningiz.com

# Logging (PHASE 8)
LOG_LEVEL=info
LOG_FILE=/var/log/kinobot/api.log

# Backup (PHASE 9)
BACKUP_ENABLED=1
BACKUP_INTERVAL=360      # 6 soat (daqiqada)
BACKUP_RETENTION=10      # Oxirgi 10 ta backup
```

> **Eslatma**: `WEBAPP_URL` HTTPS bo'lishi **majburiy** — Telegram WebApp faqat HTTPS domenlarda ishlaydi.

---

## 4. Nginx sozlamalari (production)

`deploy/nginx.conf` da:
- `server_name _;` → o'z domeningizga o'zgartiring
- `root /var/www/kinobot/frontend;` — frontend joylashuvi
- SSL sertifikatlari certbot bilan avtomatik qo'shiladi
- Xavfsizlik headerlari, CSP, keshlash — tayyor

```bash
# Tekshirish
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5. Backup / Recovery

### Avtomatik (server.js ichida)

```env
BACKUP_ENABLED=1
BACKUP_INTERVAL=360      # 6 soat
BACKUP_RETENTION=10
```

### Qo'lli (skriptlar)

```bash
# Backup yaratish
cd /opt/kinobot
node backend/scripts/db-backup.js --retention=10

# Backup'lar ro'yxati
node backend/scripts/db-restore.js --list

# Tiklash (oxirgi backup'dan)
node backend/scripts/db-restore.js

# Aniq fayldan tiklash
node backend/scripts/db-restore.js backend/data/backups/db-2024-01-15T10-30-00-auto.json
```

> **DIQQAT**: Tiklashdan keyin serverni qayta ishga tushiring (cache in-memory da qoladi):
> ```bash
> docker compose restart api    # Docker uchun
> sudo systemctl restart kinobot-api  # systemd uchun
> ```

---

## 6. Smoke test ro'yxati (Production'da qo'lda tekshirish)

Deploydan keyin quyidagilarni **brauzer/terminal orqali** tekshiring:

| # | Test | Kutgan natija |
|---|---|---|
| 1 | `GET https://domain.com/api/health` | `200 OK {status:"ok"}` |
| 2 | `GET https://domain.com/api/ready` | `200 OK {status:"ready", checks:{database:true, botToken:true, adminConfigured:true}}` |
| 3 | `GET https://domain.com/api/movies` | `200 OK {ok:true, data:{movies:[...]}}` |
| 4 | `GET https://domain.com/api/movies?q=dune` | Qidiruv ishlaydi |
| 5 | `GET https://domain.com/api/genres` | Janrlar ro'yxati |
| 6 | Telegram bot `/start` | WebApp tugmasi yuboriladi |
| 7 | WebApp ochish (`🎬 Kino katalogi`) | Frontend yuklanadi (12 ekran) |
| 8 | Film tanlash → Player ochish | Video o'ynaydi (HLS/progressive) |
| 9 | Sevimlilarga qo'shish (❤️) | `POST /api/favorites/toggle` → 200 |
| 10 | Ko'rish tarixi (`📜 Tarix`) | `GET /api/history` → 200 |
| 11 | Admin panel (`/admin` buyrug'i) | Admin ekran ochiladi |
| 12 | Admin: film qo'shish | `POST /api/admin/movies` → 201 |
| 13 | Admin: statistika | `GET /api/admin/stats` → 200 |
| 14 | Log fayli (`/var/log/kinobot/api.log`) | JSON loglar yozilmoqda |

**Barchasi ✅ bo'lsa — deploy muvaffaqiyatli.**

---

## 7. Umumiy muammolar va yechimlar

### Port band (3000)

```bash
sudo lsof -i :3000
# Agar boshqa xizmat bo'lsa:
sudo systemctl stop <xizmat>
# Yoki docker-compose.yml da portni o'zgartiring: "3001:3000"
```

### db.json ruxsat xatosi

```bash
# Docker volume ruxsati
docker compose exec api ls -la /app/backend/data/
# Agar root:root bo'lsa:
docker compose exec -u root api chown -R node:node /app/backend/data
```

### TLS/SSL sertifikat

```bash
# Certbot yangilash
sudo certbot renew --dry-run
# Majburiy yangilash
sudo certbot renew --force-renewal
```

### Bot long polling xatosi (409 Conflict)

```bash
# Eski bot jarayoni ishlayotgan — uni to'xtating
docker compose stop bot && docker compose rm -f bot
docker compose up -d bot
# Yoki systemd:
sudo systemctl restart kinobot-bot
```

### CORS xatosi (Frontend dan API'ga ulanib bo'lmaydi)

- `ALLOWED_ORIGINS` da `https://sizning-domeningiz.com` borligini tekshiring
- Nginx `proxy_set_header Origin` yo'qolmasin (odatda kerak emas)
- Brauzer console'da `Access-Control-Allow-Origin` headerini tekshiring

### Video o'ynamayapti

- `videoSources.url` HTTPS bo'lishi kerak (mixed content bloklanadi)
- Nginx `proxy_buffering off;` bo'lishi kerak (streming uchun)
- CSP `media-src 'self' https:` ruxsat berganligi kerak

---

## 8. Monitoring va loglar

### Log fayllar

```bash
# API log (JSON)
tail -f /var/log/kinobot/api.log | jq .

# Nginx access/error
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Systemd (agar systemd ishlatilsa)
journalctl -u kinobot-api -f
journalctl -u kinobot-bot -f
```

### Health/Ready endpointlari (uptime monitor uchun)

- `GET /api/health` — 200 OK (server yurayapti)
- `GET /api/ready` — 200/503 (DB + BOT_TOKEN + Admin tayyor)

Prometheus/Grafana/UptimeRobot uchun `ready` endpointini ishlating.

---

## 9. Yangilash (zero-downtime)

### Docker Compose

```bash
cd /opt/kinobot
git pull
docker compose up -d --build --no-deps api bot
# Frontend o'zgargan bo'lsa:
rsync -av frontend/ /var/www/kinobot/frontend/
```

### Systemd

```bash
cd /opt/kinobot
git pull
sudo systemctl restart kinobot-api kinobot-bot
rsync -av frontend/ /var/www/kinobot/frontend/
```

---

## 10. Xavfsizlik chek-list (Deploydan keyin)

- [ ] `.env` fayl git'ga kirmagan (`.gitignore` da)
- [ ] `ADMIN_KEY` murakkab (32+ belgi) va faqat sizda
- [ ] `BOT_TOKEN` hech kimga aytilmagan
- [ ] `NODE_ENV=production` o'rnatilgan
- [ ] `ALLOWED_ORIGINS` faqat sizning domeningiz
- [ ] HTTPS ishlayapti (certbot avto-yangilash yoqilgan)
- [ ] Nginx xavfsizlik headerlari (CSP, nosniff, DENY, va h.k.)
- [ ] Firewall: faqat 80/443/22 (SSH) ochiq, 3000 yopiq
- [ ] Backup avtomatik ishlayapti (`BACKUP_ENABLED=1`)
- [ ] Log fayllari yozilmoqda (`LOG_FILE` o'rnatilgan)

---

## 11. Rollback (Aksiya jarayoni)

Agar yangilanishdan keyin muammo bo'lsa:

```bash
# Docker
docker compose down
git checkout <eski-commit-hash>
docker compose up -d --build

# Systemd
sudo systemctl stop kinobot-api kinobot-bot
git checkout <eski-commit-hash>
sudo systemctl start kinobot-api kinobot-bot

# DB tiklash (agar zarur bo'lsa)
node backend/scripts/db-restore.js backend/data/backups/db-<timestamp>-auto.json
sudo systemctl restart kinobot-api
```

---

## 12. Foydali buyruqlar

```bash
# Barcha konteynerlarni qayta qurish
docker compose up -d --build --force-recreate

# Faqat API loglarini kuzatish
docker compose logs -f api

# DB hajmi
du -sh /opt/kinobot/backend/data/

# Backup hajmi
du -sh /opt/kinobot/backend/data/backups/

# Server resurslari
htop
df -h
free -h
```