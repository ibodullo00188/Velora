# KinoBot API — Docker image
#
# Telegram kutubxonasi production build paytida o‘rnatiladi.
#
# API, WebApp va bot bitta xizmatda ishlaydi.

FROM node:20-alpine

# NODE_ENV=production — qat'iy CORS, dev-mode (userId query) o'chiq
ENV NODE_ENV=production

WORKDIR /app

# Faqat backend katalogni nusxalaymiz (frontend nginx uchun alohida)
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

WORKDIR /app/backend
RUN npm ci --omit=dev --ignore-scripts

# db.json yoziladigan data/ katalogi. Konteyner root sifatida emas, node
# foydalanuvchisi sifatida ishlaydi (xavfsizlik) — ruxsatlarni shu yerga beramiz.
# Eslatma: docker-compose'dagi named volume buni "avtomatik" meros qiladi.
RUN chown -R node:node /app/backend

# Faqat konteyner ichki porti (tashqariga nginx yoki docker-compose ochadi)
EXPOSE 3000

# Root bilan ishlamaymiz — node foydalanuvchisi
USER node

# Ma'lumotlar doimiy saqlanadi (konteyner qayta yaratilsa ham yo'qolmaydi)
VOLUME ["/app/backend/data"]

CMD ["node", "start-all.js"]
