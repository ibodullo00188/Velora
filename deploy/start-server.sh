#!/usr/bin/env bash
# deploy/start-server.sh
#
# Kompyuterni KinoBot serveriga aylantirish (bir buyruq bilan ishga tushirish).
#
#   bash deploy/start-server.sh        # ishga tushirish / holatni tiklash
#   bash deploy/start-server.sh stop    # hammasini to'xtatish
#   bash deploy/start-server.sh status  # faqat holatni ko'rsatish
#
# Nima qiladi:
#   1) Backend (node server.js) — port 3000, API + frontend birga xizmat qiladi.
#   2) HTTPS tunnel (cloudflared quick tunnel) — Telegram WebApp uchun HTTPS.
#      Eslatma: trycloudflare manzili HAR safar qayta ishga tushganda o'zgaradi.
#   3) .env'dagi WEBAPP_URL ni tunnel'ning joriy manzili bilan sinxronlaydi.
#   4) Telegram bot (node bot.js) — WEBAPP_URL o'zgargan bo'lsa qayta ishga tushadi
#      (bot .env'ni faqat ishga tushishda o'qiydi).
#
# Barqaror (o'zgarmaydigan) manzil kerak bo'lsa: named tunnel sozlang
# (cloudflared tunnel login + sizning domeningiz) va WEBAPP_URL ni o'zingiz yozing —
# bu skript tunnel mavjud bo'lganda uni o'zgartirmaydi.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
LOGS_DIR="$BACKEND_DIR/logs"
ENV_FILE="$BACKEND_DIR/.env"
PORT="${KINOBOT_PORT:-3000}"
API_BASE="http://localhost:${PORT}/api"

LOG_API="$LOGS_DIR/api.log"
LOG_TUNNEL="$LOGS_DIR/tunnel.log"
LOG_BOT="$LOGS_DIR/bot.log"

mkdir -p "$LOGS_DIR"

# Loglar stderr'ga — stdout faqat natija (tunnel URL) uchun.
# Shuning uchun `TUNNEL="$(start_tunnel)"` faqat URL'ni oladi.
log()  { echo "[$(date '+%H:%M:%S')] $*" >&2; }
info() { log "ℹ️  $*"; }
ok()   { log "✅ $*"; }
warn() { log "⚠️  $*"; }
err()  { log "❌ $*"; }

# --- holat tekshiruvlari -----------------------------------------------------

api_running() {
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" -m 2 "$API_BASE/health" 2>/dev/null)"
  [ "$code" = "200" ]
}

bot_pid() {
  pgrep -f "node bot\.js" | head -1
}

tunnel_url() {
  # Joriy tunnel manzili: loglardan izlaymiz (trycloudflare).
  grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG_TUNNEL" 2>/dev/null | tail -1
}

tunnel_up() {
  local url; url="$(tunnel_url)"
  [ -z "$url" ] && return 1
  # HTTP status kod tekshiriladi — curl exit code'ga emas! Chunki curl 530 xato
  # sahifasida ham exit 0 qaytaradi (Cloudflare tunnel o'lgan bo'lsa ham),
  # shuning uchun faqat 200 javobgina tunnel "ishlayapti" degani.
  local code
  # Oddiy tekshiruv (lokal DNS trycloudflare'ni hal qila olsa yetarli).
  code="$(curl -s -o /dev/null -w "%{http_code}" -m 3 "$url/api/health" 2>/dev/null)"
  if [ "$code" = "200" ]; then echo "$url"; return 0; fi
  # Lokal DNS *.trycloudflare.com wildcard'ini hal qilolmasa (bizning Kali DNS'da shunday):
  # Cloudflare DNS-over-HTTPS orqali IP olamiz va --resolve bilan tekshiramiz.
  local host ip
  host="${url#https://}"; host="${host%%/*}"
  ip="$(curl -s -m 5 "https://cloudflare-dns.com/dns-query?name=${host}&type=A" -H "accept: application/dns-json" \
        | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d["Answer"][0]["data"])
except Exception: pass' 2>/dev/null)"
  if [ -n "$ip" ]; then
    code="$(curl -s -o /dev/null -w "%{http_code}" -m 3 --resolve "${host}:443:${ip}" "$url/api/health" 2>/dev/null)"
    if [ "$code" = "200" ]; then echo "$url"; return 0; fi
  fi
  return 1
}

# --- amallar -----------------------------------------------------------------

stop_all() {
  log "To'xtatilmoqda..."
  local p
  p="$(bot_pid)" && [ -n "$p" ] && kill "$p" 2>/dev/null && ok "Bot to'xtadi (pid $p)"
  pkill -f "cloudflared tunnel --url" 2>/dev/null && ok "Tunnel to'xtadi"
  pkill -f "node server\.js" 2>/dev/null && ok "Backend to'xtadi"
  sleep 1
}

start_api() {
  if api_running; then
    ok "Backend allaqachon ishlamoqda (port $PORT)"
  else
    info "Backend ishga tushirilmoqda..."
    ( cd "$BACKEND_DIR" && nohup node server.js > "$LOG_API" 2>&1 & )
    for _ in $(seq 1 20); do
      api_running && { ok "Backend tayyor ($API_BASE/health)"; return 0; }
      sleep 0.5
    done
    err "Backend ishga tushmadi — $LOG_API ga qarang"; return 1
  fi
}

# Tunnel ishlayotgan jarayon (URL chiqqan/chiqmaganidan qat'iy nazar).
tunnel_proc() {
  pgrep -f "cloudflared tunnel --url" | head -1
}

# .env'dagi WEBAPP_URL trycloudflare.com bo'lmasa (masalan foydalanuvchi
# o'zi named tunnel yaratib qo'lda kiritgan bo'lsa) va shu manzil hozir javob
# berayotgan bo'lsa — buni ishlab turgan tunnel deb hisoblaymiz va yangi
# quick tunnel ochib, WEBAPP_URL'ni ustiga yozib yubormaymiz.
custom_tunnel_up() {
  local cur
  cur="$(grep -E '^WEBAPP_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  [ -z "$cur" ] && return 1
  case "$cur" in *trycloudflare.com*) return 1 ;; esac
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" -m 3 "$cur/api/health" 2>/dev/null)"
  [ "$code" = "200" ] && { echo "$cur"; return 0; }
  return 1
}

start_tunnel() {
  local url; url="$(custom_tunnel_up)"
  if [ -n "$url" ]; then
    ok "Custom tunnel ishlamoqda (WEBAPP_URL'da o'rnatilgan): $url"
    echo "$url"; return 0
  fi
  url="$(tunnel_up)"
  if [ -n "$url" ]; then
    ok "Tunnel ishlamoqda: $url"
    echo "$url"; return 0
  fi
  # cloudflared allaqachon ishga tushirilgan, lekin URL hali tayyor emas —
  # dublikat ochmasdan, tayyor bo'lishini kutamiz (URL logda paydo bo'lishi 30+ soniya olishi mumkin).
  if ! tunnel_proc >/dev/null; then
    info "cloudflared quick tunnel ishga tushirilmoqda (localhost:${PORT})..."
    # --protocol http2: cloudflared standart holda avval QUIC (UDP, 7844-port)
    # protokolini sinaydi — ko'pgina tarmoqlar (NAT, VPN, ayrim ISP'lar) buni
    # bloklaydi/sekinlashtiradi, shu sabab bir necha urinishdan keyingina HTTP/2'ga
    # tushadi (bu esa tunnel yaratilishini 30s-2daq gacha cho'zishi mumkin).
    # To'g'ridan-to'g'ri HTTP/2'da ishga tushirish shu kutishni oldini oladi.
    ( nohup cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate --protocol http2 > "$LOG_TUNNEL" 2>&1 & )
  else
    info "cloudflared ishga tushirilgan, tunnel URL kutilyapti..."
  fi
  # log `tail -1` bilan oxirgi URL olinadi — `>` bilan qayta yozilsa eski URL yo'qoladi,
  # shuning uchun bitta jarayon yetarli.
  for _ in $(seq 1 75); do
    url="$(tunnel_up)" && { ok "Tunnel tayyor: $url"; echo "$url"; return 0; }
    sleep 1
  done
  err "Tunnel ishga tushmadi — $LOG_TUNNEL ga qarang"; return 1
}

sync_env() {
  local new_url="${1:-}"
  [ -z "$new_url" ] && { warn "Tunnel manzili topilmadi — .env o'zgartirilmadi"; return 1; }
  local old
  old="$(grep -E "^WEBAPP_URL=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  if [ "$old" = "$new_url" ]; then
    ok "WEBAPP_URL allaqachon to'g'ri ($new_url)"
    return 0
  fi
  sed -i "s|^WEBAPP_URL=.*|WEBAPP_URL=${new_url}|" "$ENV_FILE"
  ok "WEBAPP_URL yangilandi: $old → $new_url"
  return 2   # 2 = URL o'zgardi (bot qayta ishga tushirilishi shart)
}

start_bot() {
  local restart="${1:-0}" p
  p="$(bot_pid)"
  if [ -n "$p" ] && [ "$restart" = "0" ]; then
    ok "Bot allaqachon ishlamoqda (pid $p)"
    return 0
  fi
  if [ -n "$p" ]; then
    info "Bot qayta ishga tushirilmoqda (WEBAPP_URL o'zgargan)..."
    kill "$p" 2>/dev/null; sleep 1
  else
    info "Bot ishga tushirilmoqda..."
  fi
  ( cd "$BACKEND_DIR" && nohup node bot.js > "$LOG_BOT" 2>&1 & )
  sleep 3
  if bot_pid >/dev/null; then
    ok "Bot ishlamoqda: $(grep -E 'Bot ishga tushdi' "$LOG_BOT" | tail -1 | sed 's/.*Bot ishga tushdi/Bot ishga tushdi/')"
  else
    err "Bot ishga tushmadi — $LOG_BOT ga qarang"; return 1
  fi
}

print_status() {
  echo ""
  echo "======================== KinoBot Server ========================"
  if api_running; then
    echo "  Backend  : ✅ http://localhost:${PORT}  (API + frontend)"
  else
    echo "  Backend  : ❌ ishlamayapti"
  fi
  local url; url="$(tunnel_up)"
  if [ -n "$url" ]; then
    echo "  Tunnel   : ✅ $url"
    echo "  WebApp   : Telegram'da botga /start yozib, tugmani bosing"
    echo "  Admin    : $url#admin"
  else
    echo "  Tunnel   : ❌ ishlamayapti"
  fi
  local p; p="$(bot_pid)"
  echo "  Bot      : $([ -n "$p" ] && echo '✅ ishlamoqda' || echo '❌ ishlamayapti')"
  echo "  Loglar   : $LOGS_DIR/{api,tunnel,bot}.log"
  echo "================================================================"
}

# --- asosiy ------------------------------------------------------------------

case "${1:-start}" in
  stop)
    stop_all
    print_status
    ;;
  status)
    print_status
    ;;
  start)
    URL_CHANGED=0
    start_api || exit 1
    TUNNEL="$(start_tunnel)" || exit 1
    sync_env "$TUNNEL"
    RC=$?
    if [ "$RC" = "1" ]; then exit 1; fi
    [ "$RC" = "2" ] && URL_CHANGED=1   # WEBAPP_URL o'zgardi -> bot qayta ishga tushadi
    start_bot "$URL_CHANGED" || exit 1
    print_status
    ;;
  *)
    echo "Ishlatish: bash $0 [start|stop|status]"
    exit 1
    ;;
esac
