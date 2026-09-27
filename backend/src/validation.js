// src/validation.js
// Kiritilgan ma'lumotlarni tekshirish yordamchilari.
// Barcha backend inputlari shu yerdan o'tadi — soxta/malumotli xatolar
// ishonchsiz ma'lumotlardan kelib chiqishini oldini oladi.

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isValidYear(y) {
  return Number.isInteger(y) && y >= 1888 && y <= new Date().getFullYear() + 2;
}
function isValidRating(r) {
  return typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= 10;
}
// Admin panelda poster yuklanganda backend uni nisbiy manzil sifatida
// saqlaydi (masalan "/api/movies/abc123/poster" — handleAdminUploadPoster).
// Tahrirlash formasi bu qiymatni o'zgartirmasdan qayta yuborganda oddiy
// http(s) URL tekshiruvi uni rad etib, BUTUN saqlashni (boshqa maydonlar
// bilan birga) bloklab qo'yardi. Shuning uchun aynan shu naqshdagi lokal
// poster route ham to'g'ri qiymat deb hisoblanadi.
function isLocalPosterRoute(u) {
  return typeof u === "string" && /^\/api\/movies\/[^/]+\/poster$/.test(u);
}

function isValidHttpUrl(u) {
  return (
    typeof u === "string" &&
    (u.startsWith("http://") || u.startsWith("https://")) &&
    u.length <= 2048
  );
}

// Stored XSS'ni oldini olish uchun saqlanadigan matnlarda rad etiladigan naqshlar:
// HTML yorliqlari (script/iframe va h.k.), javascript: sxemasi, event handlerlar
// (onerror=, onclick= va h.k.). Oddiy matn (masalan "80s style", "a > b") bilan
// xato ishlamasligi uchun tor naqsh ishlatiladi.
const XSS_PATTERN =
  /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|base|form)\b|javascript\s*:|on(?:error|load|click|mouseover|mouseout|mousedown|mouseup|submit|focus|blur|change|input|keydown|keyup|keypress|dblclick|contextmenu|pointerdown|pointerup|pointermove)\s*=/i;

function containsXSS(v) {
  return typeof v === "string" && XSS_PATTERN.test(v);
}

// Film CRUD'da ruxsat etilgan maydonlar ro'yxati (whitelist). Boshqa maydonlar
// rad etiladi — kutilmagan body maydonlari DB'ga o'tib ketmasligi uchun.
const MOVIE_FIELDS = new Set([
  "id", "title", "originalTitle", "year", "rating", "genres",
  "duration", "description", "poster", "posterUrl", "backdropUrl",
  "videoSources", "status", "featured",
  "trending", "trendingOrder", "trendingBannerUrl",
  "isPremium", "planIds",
]);

function unknownFields(body, allowed) {
  return Object.keys(body || {}).filter((k) => !allowed.has(k));
}

/**
 * Film ma'lumotini tekshiradi.
 * @param {object} body - kiritilgan ma'lumot
 * @param {boolean} partial - PUT uchun: faqat berilgan maydonlar tekshiriladi
 * @returns {{ ok: boolean, errors: Array<{field:string, message:string}> }}
 */
function validateMovieInput(body, partial = false) {
  const errors = [];

  if (body.title !== undefined || !partial) {
    if (!isNonEmptyString(body.title)) {
      errors.push({ field: "title", message: "title majburiy va bo'sh bo'lmasligi kerak" });
    } else if (body.title.trim().length > 200) {
      errors.push({ field: "title", message: "title 200 belgidan oshmasligi kerak" });
    } else if (containsXSS(body.title)) {
      errors.push({ field: "title", message: "title xavfli belgilar (XSS) o'z ichiga olmaydi" });
    }
  }

  if (body.originalTitle !== undefined && body.originalTitle !== null && body.originalTitle !== "") {
    if (typeof body.originalTitle !== "string") {
      errors.push({ field: "originalTitle", message: "originalTitle matn bo'lishi kerak" });
    } else if (body.originalTitle.trim().length > 200) {
      errors.push({ field: "originalTitle", message: "originalTitle 200 belgidan oshmasligi kerak" });
    } else if (containsXSS(body.originalTitle)) {
      errors.push({ field: "originalTitle", message: "originalTitle xavfli belgilar (XSS) o'z ichiga olmaydi" });
    }
  }

  if (body.year !== undefined || !partial) {
    const y = body.year === "" || body.year === null ? NaN : Number(body.year);
    if (!isValidYear(y)) {
      errors.push({ field: "year", message: `year 1888–${new Date().getFullYear() + 2} orasida bo'lishi kerak` });
    }
  }

  if (body.rating !== undefined || !partial) {
    const r = body.rating === "" || body.rating === null ? NaN : Number(body.rating);
    if (!isValidRating(r)) {
      errors.push({ field: "rating", message: "rating 0–10 orasida bo'lishi kerak" });
    }
  }

  if (body.genres !== undefined || !partial) {
    if (!Array.isArray(body.genres) || body.genres.some((g) => !isNonEmptyString(g))) {
      errors.push({ field: "genres", message: "genres stringlar massivi bo'lishi kerak" });
    } else if (body.genres.some((g) => containsXSS(g))) {
      errors.push({ field: "genres", message: "genres xavfli belgilar (XSS) o'z ichiga olmaydi" });
    }
  }

  if (body.duration !== undefined && body.duration !== null) {
    if (typeof body.duration !== "string" || body.duration.trim().length > 40) {
      errors.push({ field: "duration", message: "duration noto'g'ri formatda" });
    }
  }

  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      errors.push({ field: "description", message: "description matn bo'lishi kerak" });
    } else if (body.description.length > 2000) {
      errors.push({ field: "description", message: "description 2000 belgidan oshmasligi kerak" });
    } else if (containsXSS(body.description)) {
      errors.push({ field: "description", message: "description xavfli belgilar (XSS) o'z ichiga olmaydi" });
    }
  }

  for (const urlField of ["posterUrl", "backdropUrl"]) {
    const v = body[urlField];
    if (v !== undefined && v !== null && v !== "") {
      const validUrl = isValidHttpUrl(v) || (urlField === "posterUrl" && isLocalPosterRoute(v));
      if (!validUrl) {
        errors.push({ field: urlField, message: `${urlField} http(s) URL bo'lishi kerak` });
      }
    }
  }

  if (body.videoSources !== undefined && body.videoSources !== null) {
    if (!isObject(body.videoSources)) {
      errors.push({ field: "videoSources", message: "videoSources obyekt yoki null bo'lishi kerak" });
    }
  }

  if (body.status !== undefined) {
    if (!["active", "inactive", "hidden"].includes(body.status)) {
      errors.push({ field: "status", message: "status active|inactive|hidden bo'lishi kerak" });
    }
  }

  if (body.featured !== undefined && typeof body.featured !== "boolean") {
    errors.push({ field: "featured", message: "featured boolean bo'lishi kerak" });
  }

  if (body.trending !== undefined && typeof body.trending !== "boolean") {
    errors.push({ field: "trending", message: "trending boolean bo'lishi kerak" });
  }

  if (body.trendingOrder !== undefined && body.trendingOrder !== null) {
    if (!Number.isFinite(Number(body.trendingOrder))) {
      errors.push({ field: "trendingOrder", message: "trendingOrder son bo'lishi kerak" });
    }
  }

  if (body.trendingBannerUrl !== undefined && body.trendingBannerUrl !== null && body.trendingBannerUrl !== "") {
    if (!isValidHttpUrl(body.trendingBannerUrl)) {
      errors.push({ field: "trendingBannerUrl", message: "trendingBannerUrl http(s) URL bo'lishi kerak" });
    }
  }

  if (body.isPremium !== undefined && typeof body.isPremium !== "boolean") {
    errors.push({ field: "isPremium", message: "isPremium boolean bo'lishi kerak" });
  }

  if (body.planIds !== undefined && body.planIds !== null) {
    if (!Array.isArray(body.planIds) || body.planIds.some((p) => !isNonEmptyString(p))) {
      errors.push({ field: "planIds", message: "planIds stringlar massivi bo'lishi kerak" });
    }
  }

  if (body.id !== undefined && body.id !== null && !isNonEmptyString(body.id)) {
    errors.push({ field: "id", message: "id bo'sh bo'lmasligi kerak" });
  }

  // Whitelist: ruxsat etilmagan maydonlar rad etiladi.
  for (const field of unknownFields(body, MOVIE_FIELDS)) {
    errors.push({ field, message: `${field} ruxsat etilmagan maydon` });
  }

  return { ok: errors.length === 0, errors };
}

function validateGenreName(name) {
  if (!isNonEmptyString(name)) return "Janr nomi bo'sh bo'lmasligi kerak";
  if (name.length > 40) return "Janr nomi 40 belgidan oshmasligi kerak";
  if (containsXSS(name)) return "Janr nomi xavfli belgilar (XSS) o'z ichiga olmaydi";
  return null;
}

module.exports = { validateMovieInput, validateGenreName, isValidHttpUrl, isNonEmptyString, containsXSS };
