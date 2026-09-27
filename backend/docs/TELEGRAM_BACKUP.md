# Telegram backup va admin orqali qo'lda tiklash

Database lokal `data/db.json` faylida saqlanadi. Tashqi database ulanishi kerak emas.
Server va Telegram bot bitta Node.js jarayonida bitta cache bilan ishlaydi;
bitta xizmatni ishga tushiring: `npm ci` va `npm run start:all`.

## Sozlash

Render Environment'da:

- `BOT_TOKEN`: mavjud bot tokeni.
- `ADMIN_ID`: egasining Telegram foydalanuvchi ID raqami; restore faqat shu adminning shaxsiy chatida ishlaydi.
- `STORAGE_CHANNEL_ID`: video saqlanadigan kanal (`-100...`).
- `BACKUP_CHANNEL_ID`: ixtiyoriy boshqa kanal. Bo'sh bo'lsa `STORAGE_CHANNEL_ID`, u ham bo'sh bo'lsa `CHANNEL_ID` ishlatiladi.
- `TELEGRAM_BACKUP_ENABLED=1`: avtomatik yuborish yoqilgan (standart).
- `BACKUP_ENCRYPTION_KEY`: ixtiyoriy barqaror maxfiy kalit. Kamida 32 ta tasodifiy belgi tavsiya qilinadi. Bo'sh bo'lsa `BOT_TOKEN`dan kalit olinadi.

Botni kanalga administrator qiling va xabar/fayl yuborish huquqini bering.
Admin avval botga `/start` yuborsin. Kanal tarixidagi backup fayllarni o'chirmang.
Kalitni xavfsiz joyda saqlang: kalit o'zgarsa eski backup ochilmaydi.
Agar alohida kalit ishlatilmagan bo'lsa, bot tokenini almashtirishdan oldin eski token bilan backupni tiklab,
yangi token bilan yangi backup yarating.

## Avtomatik yuborish

Har kuni **09:00 va 21:00, Asia/Tashkent (UTC+5)**.
Har safar yangi `.kbak` fayl yuboriladi; oldingi fayllar o'chirilmaydi yoki almashtirilmaydi.
Har bir faylda sana, filmlar soni va foydalanuvchilar soni ko'rsatiladi.
Jo'natish xatosida 5 daqiqadan keyin qayta urinish bo'ladi va admin xabardor qilinadi.
Muvaffaqiyatli yuborilgan vaqt bazada saqlanadi.

Render Free xizmat uxlaganda timer ishlamaydi. Uyg'onganda lokal baza va oxirgi yuborish
holati saqlangan bo'lsa, o'tkazib yuborilgan vaqt uchun bitta yangi backup yuboriladi.
Aniq vaqtni kafolatlash uchun doim ishlaydigan xizmat kerak.
Disk yo'qolsa yangi bo'sh baza ochiladi va admin eski backupni qo'lda tiklaydi.
Yangi baza darhol kanalga yuborilmaydi; birinchi avtomatik yuborish keyingi reja vaqtida bo'ladi.
**Avtomatik restore yo'q. Bot kanal tarixidan hech qanday faylni avtomatik olib tiklamaydi.**

## Qo'lda backup va restore

`/admin` panelida **Backup yaratish** va **Backupni tiklash** tugmalari bor.

1. `/backup` — ayni paytdagi yangi nusxani kanalga yuboradi.
2. Tiklash uchun kanaldagi kerakli (odatda eng oxirgi) `.kbak` faylni botning shaxsiy chatiga **forward** qiling.
3. Bot faylni tekshiradi va sanasi, filmlar hamda foydalanuvchilar sonini ko'rsatadi.
4. Bot bergan `/restore_confirm KOD` buyrug'ini 10 daqiqa ichida yuboring.
5. `/restore_cancel` — tiklashni bekor qiladi. `/restore` — ko'rsatma; faylga reply qilib yuborish ham mumkin.

Tasdiqsiz baza o'zgarmaydi. Tasdiqlanganda joriy baza nusxadagi holat bilan almashtiriladi;
backup sanasidan keyingi o'zgarishlar qaytmaydi. Tiklashdan oldin joriy holatning mahalliy
shifrlangan nusxasi `data/backups/pre-restore-*.kbak` ichiga saqlanadi.
Yangi holat darhol WebApp va botda ko'rinadi, restart shart emas.

## Tarkibi va chegaralari

- Butun database: filmlar va Telegram video manzillari, foydalanuvchilar, premium/to'lovlar,
  sevimlilar, tarix, janrlar, sozlamalar, kanal-kod xaritasi, aloqa xabarlari va statistika.
- Lokal poster va banner rasmlari.
- AES-256-GCM shifrlash va gzip siqish. Buzilgan fayl yoki noto'g'ri kalit rad etiladi.
- `.env`, bot tokeni, MTProto sessiyasi, node_modules va videolarning o'zi kiritilmaydi.
  Videolar Telegram/R2 manbalarida qolishi kerak. ImageKit rasmlari URL orqali bog'lanadi.
- Siqilgan/shifrlangan fayl limiti 19 MiB, ochilganda 100 MiB.
  Katta bo'lsa backup yuborilmaydi va xato ko'rsatiladi; posterlarni ImageKit'da saqlang.
- Bir xizmat/replika ishlating. Alohida bot va API processlar yoki bir nechta replika bilan
  bir faylga parallel yozish qo'llab-quvvatlanmaydi.

## Mavjud ma'lumotlarni ko'chirish

Eski tashqi bazadagi ma'lumotlar avtomatik ko'chirilmaydi.
Deploydan oldin eski bazaning JSON nusxasini saqlab oling. JSON `kinobot_store.data`
obyekti yoki oldingi `db:backup` chiqishi bo'lishi kerak (SQL dump emas).
Uni lokal `data/db.json` sifatida joylashtirish yoki xizmat to'xtatilganida
`npm run db:restore -- /path/to/db.json` bilan import qilish mumkin.
Keyin ishga tushirib `/backup` yuboring. Yangi Telegram restore `.kbak` fayllarni qabul qiladi.

## Tekshirish

`npm test` va `node --test tests/telegramBackup.test.js`.
Telegram so'rovlari testlarda soxta transport bilan tekshiriladi; haqiqiy kanalga test fayllari yuborilmaydi.
