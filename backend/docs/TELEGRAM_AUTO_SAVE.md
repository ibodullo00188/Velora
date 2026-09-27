# Video avtomatik saqlash (Telegram MTProto)

Manba kanalga (`CHANNEL_ID`) video/hujjat-video tashlanganda, uni alohida
"storage" kanalga **avtomatik nusxalaydi** — Bot API'ning 20MB fayl
cheklovisiz, fayl qayta yuklanmasdan (Telegram serverida nusxalanadi).

Bu mavjud `#kod` va `*` (broadcast) xususiyatlari bilan **parallel**
ishlaydi, ularni almashtirmaydi. Frontend, REST API va bot buyruqlari
o'zgarmagan.

## Nega kerak

Bot API orqali fayl yuklab olish 20MB bilan cheklangan — kino fayllari
uchun ishlamaydi. MTProto (Telegram'ning to'liq protokoli) bu cheklovga ega
emas. `telegram` (GramJS) kutubxonasi shu protokolni Node.js'da amalga
oshiradi.

## Sozlash (3 qadam)

1. **npm paketi o'rnatish** (bir marta):
   ```bash
   cd backend && npm install
   ```

2. **`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`** — https://my.telegram.org →
   "API development tools" → yangi ilova yarating (bepul). Bu shunchaki
   "ilova identifikatori" — alohida login/telefon kod talab qilmaydi, chunki
   bot o'zining mavjud `BOT_TOKEN`i bilan MTProto'ga kiradi.

3. **`STORAGE_CHANNEL_ID`** — yangi (yashirin bo'lishi mumkin) Telegram
   kanal yarating, botni o'sha kanalga **admin** qilib qo'shing, kanal
   ID'sini `.env`ga yozing (masalan `-1009876543210`).

`.env`:
```
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
STORAGE_CHANNEL_ID=-1009876543210
```

Uchalasi ham bo'sh bo'lsa — xususiyat butunlay o'chiq turadi, hech nima
o'zgarmaydi (mavjud kinobot ishlashda davom etadi).

## Qanday ishlaydi

1. Admin `CHANNEL_ID` kanalga video joylaydi (caption bilan yoki captionsiz).
2. Bot (`bot.js`) buni `channel_post` update sifatida qabul qiladi.
3. Agar video/hujjat-video bo'lsa va yuqoridagi 3 ta o'zgaruvchi
   to'ldirilgan bo'lsa — `src/channelAutoSave.js` MTProto klient
   (`src/mtproto.js`) orqali xabarni `STORAGE_CHANNEL_ID`ga nusxalaydi
   (muallif/manba yorlig'isiz — oddiy "copy").
4. Yozuv `src/storageVideos.js` orqali `db.json`ga saqlanadi:
   `{ id, sourceChannelId, sourceMessageId, storageChannelId, storageMessageId, code, caption, fileName, fileSize, mimeType, mediaType, savedAt }`.
5. `ADMIN_ID` sozlangan bo'lsa, adminga natija haqida xabar keladi.

## Video-strim uchun sessiya puli (flood-control taqsimlash)

Kanaldan-kanalga nusxalash (yuqoridagi bo'lim) kam chastotali admin amali,
lekin veb-pleyerdagi video-strim boshqacha: ko'p foydalanuvchi bir vaqtda
kino ko'rsa, hammasi bitta MTProto sessiyadan foydalanadi va Telegram
flood-control (`FLOOD_WAIT`) tez ishga tushadi.

Buni yumshatish uchun `src/mtproto.js` bir nechta mustaqil bot-sessiyadan
("pool") iborat bo'lishi mumkin — video-strim ularni **round-robin**
tartibida ishlatadi, shu bilan bitta sessiyaga tushadigan yuklama pool
hajmiga bo'linadi.

**Sozlash:**

1. Har bir qo'shimcha sessiya uchun @BotFather orqali yangi bot yarating.
2. Yaratilgan botni ham `STORAGE_CHANNEL_ID` kanaliga a'zo (admin) qilib
   qo'shing — aks holda o'sha sessiya kanal xabarlarini o'qiy olmaydi.
3. `.env`ga qo'shing:
   ```
   STREAM_BOT_TOKENS=111111:AAA...,222222:BBB...,333333:CCC...
   ```
   Asosiy `BOT_TOKEN` avtomatik ravishda pool'ning 0-indeksi sifatida
   qatnashadi — bu yerga faqat **qo'shimcha** tokenlarni yozasiz.
   `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` barcha sessiyalar uchun bir xil
   qoladi.

`STREAM_BOT_TOKENS` bo'sh qoldirilsa — avvalgidek bitta (asosiy) sessiya
bilan ishlayveradi, hech nima buzilmaydi. Kanaldan-kanalga nusxalash
(`channelAutoSave.js`) va bot ishga tushishi (`bot.js`) hamon faqat asosiy
sessiyadan foydalanadi — pool faqat video-strimga taalluqli.

## Keyingi qadamlar (hozircha amalga oshirilmagan)

- Admin panelda "Kanal videolari" ro'yxatini `storageVideos.listEntries()`
  orqali ko'rsatish (REST endpoint qo'shish kerak).
- Veb-pleyerda shu storage-kanal videolarini to'g'ridan-to'g'ri strim
  qilish (Range so'rovlari bilan MTProto'dan chunk-chunk o'qish) —
  TelePlay'dagi `streaming.py` mantig'iga o'xshash, GramJS'ning
  `client.iterDownload()` metodidan foydalaniladi.

Bularni ham qilishni xohlasangiz, ayting — davom ettiraman.
