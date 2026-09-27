# KinoBot API — Docker image
#
# Backend tashqi kutubxonasiz (faqat Node.js ichki modullari: http, crypto,
# fs, https) — shuning uchun `npm install` kerak emas va image juda kichik.
#
# Frontend bu image ichida YO'Q — u statik fayl sifatida nginx orqali
# xizmat qiladi (deploy/nginx.conf). Bot esa xuddi shu image asosida
# alohida konteyner sifatida ishga tushadi (docker-compose.yml ga qarang).

FROM node:20-alpine

# NODE_ENV=production — qat'iy CORS, dev-mode (userId query) o'chiq
ENV NODE_ENV=production

WORKDIR /app

# Faqat backend katalogni nusxalaymiz (frontend nginx uchun alohida)
COPY backend/ /app/backend/

WORKDIR /app/backend

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

CMD ["node", "server.js"]
