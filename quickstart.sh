#!/usr/bin/env bash
# quickstart.sh
#
# KinoBot'ni Kali (yoki boshqa Debian-asosli) kompyuterda BIR BUYRUQ bilan
# ishga tushirish uchun tayyorlaydi va so'ng ishga tushiradi:
#
#   bash quickstart.sh
#
# Nima qiladi:
#   1) Node.js (>=18) yo'q bo'lsa — o'rnatadi (NodeSource, apt orqali).
#   2) cloudflared yo'q bo'lsa — o'rnatadi (rasmiy binary, GitHub release).
#   3) backend/.env yo'q bo'lsa — backend/.env.example'dan yaratadi.
#   4) BOT_TOKEN bo'sh bo'lsa — sizdan so'raydi (@BotFather'dan olinadi) va
#      .env'ga yozadi. ADMIN_ID ham (ixtiyoriy) so'raladi.
#   5) deploy/start-server.sh start ni chaqiradi — bu backend, cloudflared
#      tunnel va Telegram bot'ni birga ishga tushiradi hamda WEBAPP_URL'ni
#      avtomatik tunnel manziliga sinxronlaydi.
#
# Keyingi safar shunchaki shu buyruqni qayta ishga tushirsangiz bo'ldi —
# .env va cloudflared allaqachon tayyor bo'lsa, hech narsa qayta so'ralmaydi.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
ENV_FILE="$BACKEND_DIR/.env"
ENV_EXAMPLE="$BACKEND_DIR/.env.example"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
info() { log "ℹ️  $*"; }
ok()   { log "✅ $*"; }
warn() { log "⚠️  $*"; }
err()  { log "❌ $*"; }

# --- 1) Node.js tekshiruvi/o'rnatilishi -------------------------------------

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  [ "${major:-0}" -ge 18 ]
}

if node_ok; then
  ok "Node.js tayyor ($(node -v))"
else
  warn "Node.js topilmadi (yoki eskirgan) — o'rnatilmoqda (Node.js 20 LTS)..."
  if ! command -v sudo >/dev/null 2>&1; then
    err "sudo topilmadi. Node.js'ni qo'lda o'rnating: https://nodejs.org/"
    exit 1
  fi
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - \
    && sudo apt-get install -y nodejs
  if ! node_ok; then
    err "Node.js o'rnatilmadi. Qo'lda o'rnatib, qayta urinib ko'ring."
    exit 1
  fi
  ok "Node.js o'rnatildi ($(node -v))"
fi

# --- 2) cloudflared tekshiruvi/o'rnatilishi ---------------------------------
# Eslatma: cloudflared'ning rasmiy apt repo'si Kali kodli nomini (kali-rolling)
# tanimasligi mumkin, shuning uchun to'g'ridan-to'g'ri binary yuklab olamiz.

if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared tayyor ($(cloudflared --version 2>&1 | head -1))"
else
  warn "cloudflared topilmadi — o'rnatilmoqda..."
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$ARCH" in
    amd64|x86_64) CF_ARCH="amd64" ;;
    arm64|aarch64) CF_ARCH="arm64" ;;
    armhf|armv7l) CF_ARCH="arm" ;;
    *) CF_ARCH="amd64" ;;
  esac
  TMP_BIN="$(mktemp)"
  if curl -fsSL -o "$TMP_BIN" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"; then
    chmod +x "$TMP_BIN"
    if sudo mv "$TMP_BIN" /usr/local/bin/cloudflared; then
      ok "cloudflared o'rnatildi ($(cloudflared --version 2>&1 | head -1))"
    else
      err "cloudflared'ni /usr/local/bin ga ko'chirib bo'lmadi (sudo kerak)."
      exit 1
    fi
  else
    err "cloudflared yuklab olinmadi. Internetni tekshiring va qayta urinib ko'ring."
    rm -f "$TMP_BIN"
    exit 1
  fi
fi

# --- 3) backend npm bog'liqliklarini o'rnatish -------------------------------
# Muhim: repo node_modules'siz keladi (.gitignore). Bu qadam bo'lmasa,
# server.js "Cannot find module 'big-integer'" (yoki 'telegram') xatosi bilan
# ishga tushmaydi — src/telegramStream.js "telegram" npm paketiga bog'liq.

if [ -d "$BACKEND_DIR/node_modules" ]; then
  ok "backend/node_modules allaqachon mavjud"
else
  info "backend npm paketlari o'rnatilmoqda (npm install)..."
  if (cd "$BACKEND_DIR" && npm install --no-audit --no-fund); then
    ok "backend npm paketlari o'rnatildi"
  else
    err "npm install muvaffaqiyatsiz tugadi. Yuqoridagi xatoni tekshiring."
    exit 1
  fi
fi

# --- 4) backend/.env yaratish ------------------------------------------------

if [ -f "$ENV_FILE" ]; then
  ok "backend/.env allaqachon mavjud"
else
  if [ ! -f "$ENV_EXAMPLE" ]; then
    err "backend/.env.example topilmadi — loyiha to'liq emas."
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  ok "backend/.env yaratildi (.env.example asosida)"
fi

# --- 5) BOT_TOKEN / ADMIN_ID so'rash (faqat bo'sh bo'lsa) -------------------

current_bot_token="$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

if [ -z "$current_bot_token" ]; then
  echo ""
  echo "🤖 BOT_TOKEN kerak — uni Telegram'da @BotFather orqali olasiz"
  echo "   (/newbot yoki mavjud bot uchun /token)."
  read -r -p "BOT_TOKEN kiriting (masalan 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx): " input_token
  if [ -n "$input_token" ]; then
    sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=${input_token}|" "$ENV_FILE"
    ok "BOT_TOKEN saqlandi"
  else
    warn "BOT_TOKEN kiritilmadi — bot ishga tushmaydi (backend API baribir ishlaydi)."
    warn "Keyinroq $ENV_FILE faylini tahrirlab, bu skriptni qayta ishga tushiring."
  fi
else
  ok "BOT_TOKEN allaqachon .env'da mavjud"
fi

current_admin_id="$(grep -E '^ADMIN_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$current_admin_id" ]; then
  echo ""
  read -r -p "ADMIN_ID (ixtiyoriy — Telegram user ID'ingiz, /admin panel uchun. Bo'sh qoldirish mumkin): " input_admin
  if [ -n "$input_admin" ]; then
    if grep -qE '^#?\s*ADMIN_ID=' "$ENV_FILE"; then
      sed -i "s|^#\?\s*ADMIN_ID=.*|ADMIN_ID=${input_admin}|" "$ENV_FILE"
    else
      echo "ADMIN_ID=${input_admin}" >> "$ENV_FILE"
    fi
    ok "ADMIN_ID saqlandi"
  else
    info "ADMIN_ID o'tkazib yuborildi (keyin $ENV_FILE ichida qo'shishingiz mumkin)"
  fi
fi

# --- 6) Hammasini ishga tushirish --------------------------------------------

chmod +x "$PROJECT_DIR/deploy/start-server.sh"
echo ""
info "KinoBot ishga tushirilmoqda (backend + cloudflared tunnel + bot)..."
echo ""
exec bash "$PROJECT_DIR/deploy/start-server.sh" start
