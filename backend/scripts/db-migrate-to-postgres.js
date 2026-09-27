#!/usr/bin/env node
// scripts/db-migrate-to-postgres.js
// Mavjud data/db.json'ni Postgres (Neon)'ga bir martalik ko'chiradi.
//
// Ishga tushirish (DATABASE_URL .env faylda yoki environment'da bo'lishi kerak):
//   npm run db:migrate-to-postgres                     — data/db.json'ni ko'chiradi
//   npm run db:migrate-to-postgres -- <fayl-yoli>       — aniq JSON fayldan (masalan backup)
//
// Xavfsizlik: agar Postgres'da (kinobot_store, id=1) allaqachon qator mavjud
// bo'lsa, --force berilmasa hech narsa YOZILMAYDI (tasodifan ustidan yozib
// yuborishning oldini olish uchun).
//
//   npm run db:migrate-to-postgres -- --force                — mavjud Postgres
//     ma'lumotini data/db.json bilan MAJBURIY almashtiradi (ehtiyot bo'ling!)
//   npm run db:migrate-to-postgres -- --force <fayl-yoli>    — xuddi shu, lekin
//     aniq fayldan (masalan bir backup'ni tiklash uchun)

const fs = require("fs");
const path = require("path");

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const fileArg = args.find((a) => !a.startsWith("--"));

  const DATABASE_URL = process.env.DATABASE_URL || "";
  if (!DATABASE_URL) {
    console.error("DATABASE_URL o'rnatilmagan. .env fayliga qo'shing yoki:");
    console.error("  DATABASE_URL=postgresql://... npm run db:migrate-to-postgres");
    process.exit(1);
  }

  const dbJsonPath = fileArg
    ? path.resolve(fileArg)
    : process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(__dirname, "..", "data", "db.json");

  if (!fs.existsSync(dbJsonPath)) {
    console.error(`db.json topilmadi: ${dbJsonPath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(dbJsonPath, "utf-8"));
  } catch (e) {
    console.error("db.json o'qib bo'lmadi / buzilgan:", e.message);
    process.exit(1);
  }

  // Ko'chirishdan oldin loyihaning o'z normalizatsiyasidan o'tkazamiz —
  // Postgres'da ham xuddi shu schema (fayl-rejimdagi kabi) saqlanadi.
  const dbMod = require("../src/db");
  const normalized = dbMod.normalize(raw);

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kinobot_store (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const existing = await pool.query("SELECT id FROM kinobot_store WHERE id = 1");
    if (existing.rows.length > 0 && !force) {
      console.error(
        "Postgres'da allaqachon ma'lumot bor (kinobot_store, id=1). " +
          "Tasodifan ustidan yozib yubormaslik uchun to'xtatildi.\n" +
          "Agar ataylab almashtirmoqchi bo'lsangiz: npm run db:migrate-to-postgres -- --force"
      );
      process.exit(1);
    }

    await pool.query(
      `INSERT INTO kinobot_store (id, data, updated_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [JSON.stringify(normalized)]
    );

    console.log(`✅ Ko'chirildi: ${normalized.movies.length} ta film, ${Object.keys(normalized.users).length} ta foydalanuvchi.`);

    // Mavjud lokal poster/banner rasmlarini ham Postgres'ga ko'chiramiz
    // (kinobot_images) — aks holda ular ephemeral diskda qolib, keyingi
    // deploy'da yo'qolib ketadi.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kinobot_images (
        id TEXT PRIMARY KEY,
        ext TEXT NOT NULL,
        data BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const ALLOWED_EXT = ["jpg", "jpeg", "png", "webp", "gif"];
    let imagesCopied = 0;

    const postersDir = path.join(__dirname, "..", "data", "posters");
    if (fs.existsSync(postersDir)) {
      for (const fname of fs.readdirSync(postersDir)) {
        const dot = fname.lastIndexOf(".");
        if (dot === -1) continue;
        const movieId = fname.slice(0, dot);
        const ext = fname.slice(dot + 1).toLowerCase();
        if (!ALLOWED_EXT.includes(ext)) continue;
        const buffer = fs.readFileSync(path.join(postersDir, fname));
        await pool.query(
          `INSERT INTO kinobot_images (id, ext, data, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET ext = $2, data = $3, updated_at = now()`,
          [`poster:${movieId}`, ext, buffer]
        );
        imagesCopied++;
      }
    }

    const bannerDir = path.join(__dirname, "..", "data", "banner");
    if (fs.existsSync(bannerDir)) {
      for (const fname of fs.readdirSync(bannerDir)) {
        const dot = fname.lastIndexOf(".");
        if (dot === -1) continue;
        const ext = fname.slice(dot + 1).toLowerCase();
        if (!ALLOWED_EXT.includes(ext)) continue;
        const buffer = fs.readFileSync(path.join(bannerDir, fname));
        await pool.query(
          `INSERT INTO kinobot_images (id, ext, data, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET ext = $2, data = $3, updated_at = now()`,
          ["banner", ext, buffer]
        );
        imagesCopied++;
      }
    }

    console.log(`✅ ${imagesCopied} ta poster/banner rasmi Postgres'ga ko'chirildi.`);
    console.log("Endi Render'da DATABASE_URL environment variable'ni qo'shing va qayta deploy qiling.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("Xatolik:", e.message);
  process.exit(1);
});
