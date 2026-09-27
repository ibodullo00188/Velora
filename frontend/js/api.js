// frontend/js/api.js
// Backend bilan REST orqali muloqot qiladi. Barcha so'rovlar {ok, data} yoki
// {ok:false, error:{code, message}} formatida javob qaytaradi.
// Foydalanuvchi identifikatsiyasi Telegram initData orqali backendda tasdiqlanadi;
// DEV_MODE da esa userId query/body orqali uzatiladi.

(function () {
  "use strict";

  const DEFAULT_BASE = "/api";

  // API base URL: Telegram Mini App'da xuddi shu origin ishlaydi.
  // Local rivojlantirishda backend boshqa portda bo'lsa, KINOBOT_API_URL orqali o'zgartiriladi.
  function resolveBase() {
    if (window.KINOBOT_API_URL) return window.KINOBOT_API_URL;
    return DEFAULT_BASE;
  }

  let cachedToken = null; // initData tokeni — faqat xotirada

  // BLOCKED holat: backend 403 FORBIDDEN qaytarganda o'rnatiladi.
  // Shundan keyin hech qanday API chaqiruvi tarmoqqa chiqmaydi — barchasi
  // darhol USER_BLOCKED xatosi bilan qaytadi (foydalanuvchi hisobi bloklangan).
  let blocked = false;

  // BLOCKED bo'lganda window'ga hodisa yuboramiz — app.js buni eshitib
  // to'liq ekranli "hisobingiz bloklangan" sahifasini ko'rsatadi.
  function markBlocked() {
    if (blocked) return;
    blocked = true;
    try {
      window.dispatchEvent(new CustomEvent("kinobot:blocked"));
    } catch (e) {}
  }

  // BLOCKED holatini tashqariga ko'rsatish (app.js UI uchun).
  function isBlocked() {
    return blocked;
  }

  function getInitData() {
    if (cachedToken) return cachedToken;
    try {
      const w = window.Telegram?.WebApp;
      if (w && w.initData) {
        cachedToken = w.initData;
        return cachedToken;
      }
    } catch {}
    return "";
  }

  function getDevUserId() {
    try {
      const q = new URLSearchParams(window.location.search);
      const v = q.get("userId");
      if (v && /^\d{1,20}$/.test(v)) return v;
    } catch {}
    return "";
  }

  async function request(method, path, body, { adminKey, retries = 1, timeoutMs = 20000 } = {}) {
    // Hisob bloklangan — keyingi barcha API chaqiruvlari to'xtatiladi.
    if (blocked) {
      return {
        ok: false,
        error: { code: "USER_BLOCKED", message: "Hisobingiz bloklangan" },
      };
    }

    const headers = { "Content-Type": "application/json" };
    const initData = getInitData();
    const devId = getDevUserId();

    if (initData) headers["X-Telegram-Init-Data"] = initData;
    if (adminKey) headers["X-Admin-Key"] = adminKey;

    // Dev mode'da userId query parametr orqali uzatiladi (CORS header ro'yxatida emas).
    // path'da allaqachon "?" bo'lsa — "&" bilan qo'shiladi.
    const sep = path.includes("?") ? "&" : "?";
    const qs = devId && !initData ? `${sep}userId=${encodeURIComponent(devId)}` : "";

    // So'rov muddati — server javob bermasa (tarmoq uzilishi, backend osilib
    // qolishi va h.k.) so'rov cheksiz kutmasin, belgilangan vaqtdan keyin
    // aniq xato bilan qaytadi va foydalanuvchi qayta urinishi mumkin bo'ladi.
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetch(resolveBase() + path + qs, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === "AbortError") {
        return { ok: false, error: { code: "TIMEOUT", message: "Server javob bermadi, vaqt tugadi" } };
      }
      // Tarmoq/backend mavjud emas — aniq xato formatida qaytaramiz
      return { ok: false, error: { code: "NETWORK_ERROR", message: "Serverga ulanib bo'lmadi" } };
    }
    if (timer) clearTimeout(timer);

    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (!json || typeof json.ok !== "boolean") {
      return {
        ok: false,
        error: {
          code: "BAD_RESPONSE",
          message: `Server javobi noto'g'ri (HTTP ${res.status})`,
        },
      };
    }

    // 403 FORBIDDEN — hisob bloklangan. Keyingi barcha so'rovlarni to'xtatamiz.
    if (!json.ok && json.error && json.error.code === "FORBIDDEN") {
      markBlocked();
    }

    // Retry logic: tarmoq xatosi (NETWORK_ERROR/TIMEOUT) yoki 5xx server xatosi
    // bo'lsa 1 marta qayta urinish (2s kutib)
    if (retries > 0) {
      const isNetworkError = json.error?.code === "NETWORK_ERROR" || json.error?.code === "TIMEOUT";
      const isServerError = res.status >= 500 && res.status < 600;
      if (isNetworkError || isServerError) {
        console.warn(`[API] Retry ${method} ${path} (${retries} left) — ${isNetworkError ? "network" : "server"} error`);
        await new Promise((r) => setTimeout(r, 2000));
        return request(method, path, body, { adminKey, retries: retries - 1, timeoutMs });
      }
    }

    return json;
  }

  function get(path, opts) {
    return request("GET", path, undefined, opts);
  }

  function post(path, body, opts) {
    return request("POST", path, body, opts);
  }

  function put(path, body, opts) {
    return request("PUT", path, body, opts);
  }

  function del(path, opts) {
    return request("DELETE", path, undefined, opts);
  }

  // Progress bilan yuklash (masalan poster rasmi) — oddiy fetch upload foizini
  // bermaydi, shuning uchun katta/sekin ma'lumotlar uchun XMLHttpRequest
  // ishlatamiz va onProgress(percent) orqali foizni tashqariga chiqaramiz.
  function postWithProgress(path, body, { adminKey, timeoutMs = 60000 } = {}, onProgress) {
    return new Promise((resolve) => {
      if (blocked) {
        resolve({ ok: false, error: { code: "USER_BLOCKED", message: "Hisobingiz bloklangan" } });
        return;
      }
      const initData = getInitData();
      const devId = getDevUserId();
      const qs = devId && !initData ? `?userId=${encodeURIComponent(devId)}` : "";
      const xhr = new XMLHttpRequest();
      xhr.open("POST", resolveBase() + path + qs, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      if (initData) xhr.setRequestHeader("X-Telegram-Init-Data", initData);
      if (adminKey) xhr.setRequestHeader("X-Admin-Key", adminKey);
      xhr.timeout = timeoutMs;

      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch {}
        if (!json || typeof json.ok !== "boolean") {
          resolve({ ok: false, error: { code: "BAD_RESPONSE", message: `Server javobi noto'g'ri (HTTP ${xhr.status})` } });
          return;
        }
        if (!json.ok && json.error && json.error.code === "FORBIDDEN") markBlocked();
        resolve(json);
      };
      xhr.ontimeout = () => resolve({ ok: false, error: { code: "TIMEOUT", message: "Server javob bermadi, vaqt tugadi" } });
      xhr.onerror = () => resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "Serverga ulanib bo'lmadi" } });
      try {
        xhr.send(JSON.stringify(body));
      } catch (e) {
        resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "Serverga ulanib bo'lmadi" } });
      }
    });
  }

  const api = {
    // Salomatlik
    checkHealth() {
      return get("/health");
    },

    // Filmlar (back-end qidiruv/sort/filtrni bajaradi)
    getMovies(params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        q.set(k, String(v));
      }
      const qs = q.toString();
      return get("/movies" + (qs ? `?${qs}` : ""));
    },

    getMovie(id) {
      return get(`/movies/${encodeURIComponent(id)}`);
    },

    // Janrlar
    getGenres() {
      return get("/genres");
    },

    // Bosh sahifa banneri (reklama yoki tanlangan film)
    getBanner() {
      return get("/banner");
    },

    adminSetBanner(key, data) {
      return put("/admin/banner", data, { adminKey: key });
    },

    adminDeleteBanner(key) {
      return del("/admin/banner", { adminKey: key });
    },

    // Foydalanuvchi profili
    getProfile() {
      return get("/profile");
    },

    // Favorites
    getFavorites() {
      return get("/favorites");
    },

    toggleFavorite(movieId) {
      return post("/favorites/toggle", { movieId });
    },

    // Tarix
    getHistory() {
      return get("/history");
    },

    recordHistory(movieId, progressPct, positionSeconds) {
      return post("/history", { movieId, progressPct, positionSeconds });
    },

    getContinueWatching() {
      return get("/history/continue-watching");
    },

    // Telegram auth (kelajakda ishlatiladi)
    authTelegram() {
      return post("/auth/telegram", {});
    },

    // --- Admin (X-Admin-Key talab qilinadi) ---
    adminStats(key, days) {
      const q = new URLSearchParams();
      if (days !== undefined && days !== null) {
        q.set("days", String(days));
      }
      const qs = q.toString();
      return get("/admin/stats" + (qs ? `?${qs}` : ""), { adminKey: key });
    },

    getAdminStats(days) {
      return this.adminStats(null, days);
    },

    adminListMovies(key, params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        q.set(k, String(v));
      }
      const qs = q.toString();
      return get("/admin/movies" + (qs ? `?${qs}` : ""), { adminKey: key });
    },

    adminCreateMovie(key, data) {
      return post("/admin/movies", data, { adminKey: key });
    },

    adminUpdateMovie(key, id, data) {
      return put(`/admin/movies/${encodeURIComponent(id)}`, data, { adminKey: key });
    },

    adminDeleteMovie(key, id) {
      return del(`/admin/movies/${encodeURIComponent(id)}`, { adminKey: key });
    },

    adminListGenres(key) {
      return get("/admin/genres", { adminKey: key });
    },

    adminCreateGenre(key, name) {
      return post("/admin/genres", { name }, { adminKey: key });
    },

    adminDeleteGenre(key, name) {
      return del(`/admin/genres/${encodeURIComponent(name)}`, { adminKey: key });
    },

    adminGenreDeactivate(key, name) {
      return post(`/admin/genres/${encodeURIComponent(name)}/deactivate`, {}, { adminKey: key });
    },

    adminGenreActivate(key, name) {
      return post(`/admin/genres/${encodeURIComponent(name)}/activate`, {}, { adminKey: key });
    },

    // Majburiy obuna kanallari (public)
    getRequiredChannels() {
      return get("/channels/required");
    },

    // `_` parametri — Telegram WebView (ayniqsa Android) GET javobini
    // keshlab qolib, obuna bo'lgandan keyin ham eski "subscribed:false"
    // natijasini qaytarishining oldini oladi.
    checkChannelSubscription() {
      return get(`/channels/check?_=${Date.now()}`);
    },

    // Majburiy obuna kanallari (admin)
    adminListChannels(key) {
      return get("/admin/channels", { adminKey: key });
    },

    adminAddChannel(key, { chatId, title, inviteLink }) {
      return post("/admin/channels", { chatId, title, inviteLink }, { adminKey: key });
    },

    adminDeleteChannel(key, id) {
      return del(`/admin/channels/${encodeURIComponent(id)}`, { adminKey: key });
    },

    // Storage kanalga avtomatik saqlangan videolar (admin) — Telegram MTProto
    adminListStorageVideos(key) {
      return get("/admin/storage-videos", { adminKey: key });
    },

    adminDeleteStorageVideo(key, id) {
      return del(`/admin/storage-videos/${encodeURIComponent(id)}`, { adminKey: key });
    },

    adminStorageVideoStreamUrl(key, id) {
      return get(`/admin/storage-videos/${encodeURIComponent(id)}/stream-url`, { adminKey: key });
    },

    adminUsers(key, params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        q.set(k, String(v));
      }
      const qs = q.toString();
      return get("/admin/users" + (qs ? `?${qs}` : ""), { adminKey: key });
    },

    adminUserDetail(key, id) {
      return get(`/admin/users/${encodeURIComponent(id)}`, { adminKey: key });
    },

    adminBlockUser(key, id) {
      return post(`/admin/users/${encodeURIComponent(id)}/block`, {}, { adminKey: key });
    },

    adminUnblockUser(key, id) {
      return post(`/admin/users/${encodeURIComponent(id)}/unblock`, {}, { adminKey: key });
    },

    adminUpdateUser(key, id, data) {
      return put(`/admin/users/${encodeURIComponent(id)}`, data, { adminKey: key });
    },

    adminAuditLog(key) {
      return get("/admin/audit-log", { adminKey: key });
    },

    // "Biz bilan bog'lanish"
    sendContactMessage(text) {
      return post("/contact", { text });
    },

    adminContactMessages(key, params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        q.set(k, String(v));
      }
      const qs = q.toString();
      return get("/admin/contact-messages" + (qs ? `?${qs}` : ""), { adminKey: key });
    },

    adminContactMarkRead(key, id) {
      return post(`/admin/contact-messages/${encodeURIComponent(id)}/read`, {}, { adminKey: key });
    },

    adminContactBlockUser(key, userId) {
      return post(`/admin/contact-users/${encodeURIComponent(userId)}/block`, {}, { adminKey: key });
    },

    adminContactUnblockUser(key, userId) {
      return post(`/admin/contact-users/${encodeURIComponent(userId)}/unblock`, {}, { adminKey: key });
    },

    adminChangePassword(key, currentPassword, newPassword) {
      return post("/admin/password", { currentPassword, newPassword }, { adminKey: key });
    },

    // --- Premium & to'lov ---
    getPremiumEnabled() {
      return get("/premium/enabled");
    },

    adminSetPremiumEnabled(key, enabled) {
      return put("/admin/premium-enabled", { enabled }, { adminKey: key });
    },

    adminSetStreamingPremiumOnly(key, enabled) {
      return put("/admin/streaming-premium-only", { enabled }, { adminKey: key });
    },

    getPremiumPlans() {
      return get("/premium/plans");
    },

    getPremiumStatus() {
      return get("/premium/status");
    },

    purchasePremium(plan, checkImageData) {
      return post("/premium/purchase", { plan, checkImageData });
    },

    getPremiumPaymentStatus(paymentId) {
      return get(`/premium/payment/${encodeURIComponent(paymentId)}`);
    },

    getPremiumPaymentSettings() {
      return get("/premium/payment-settings");
    },

    getMyPayments() {
      return get("/premium/my-payments");
    },

    adminListPayments(key, params = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === "") continue;
        q.set(k, String(v));
      }
      const qs = q.toString();
      return get("/admin/payments" + (qs ? `?${qs}` : ""), { adminKey: key });
    },

    adminPaymentDetail(key, id) {
      return get(`/admin/payments/${encodeURIComponent(id)}`, { adminKey: key });
    },

    adminApprovePayment(key, id) {
      return post(`/admin/payments/${encodeURIComponent(id)}/approve`, {}, { adminKey: key });
    },

    adminRejectPayment(key, id) {
      return post(`/admin/payments/${encodeURIComponent(id)}/reject`, {}, { adminKey: key });
    },

    adminGetPaymentSettings(key) {
      return get("/admin/payment-settings", { adminKey: key });
    },

    adminSavePaymentSettings(key, cardNumber, cardHolder) {
      return put("/admin/payment-settings", { cardNumber, cardHolder }, { adminKey: key });
    },

    // --- Admin Plans (Paketlar) ---
    adminListPlans(key) {
      return get("/admin/plans", { adminKey: key });
    },

    adminCreatePlan(key, data) {
      return post("/admin/plans", data, { adminKey: key });
    },

    adminUpdatePlan(key, id, data) {
      return put(`/admin/plans/${encodeURIComponent(id)}`, data, { adminKey: key });
    },

    adminDeletePlan(key, id) {
      return del(`/admin/plans/${encodeURIComponent(id)}`, { adminKey: key });
    },

    adminAssignPlanMovies(key, planId, movieIds) {
      return put(`/admin/plans/${encodeURIComponent(planId)}/movies`, { movieIds }, { adminKey: key });
    },

    // --- R2 video (signed URL) ---

    // Oddiy foydalanuvchi: R2 presigned GET URL (5 daqiqa amal qiladi).
    getVideoUrl(id, quality) {
      return get(`/movies/${encodeURIComponent(id)}/video/${encodeURIComponent(quality)}`);
    },

    // Videoni storage kanaldan foydalanuvchining bot bilan shaxsiy chatiga
    // to'g'ridan-to'g'ri forward qiladi (webapp'da pleyer ochilmaydi —
    // R2/lokal/MTProto strimga tayanmaydi, faqat Bot API copyMessage).
    deliverMovie(id) {
      return post(`/movies/${encodeURIComponent(id)}/deliver`, {});
    },

    // Admin: presigned PUT URL — browser faylni storage'ga yuklaydi.
    // storage: "r2" | "local" (Kali lokal). Default: server STORAGE_MODE.
    adminPresignVideo(key, id, { quality, contentType, size, storage }) {
      return post(`/admin/movies/${encodeURIComponent(id)}/video/presign`,
        { quality, contentType, size, storage }, { adminKey: key });
    },

    // Admin: upload tugagach storage'dagi faylni tasdiqlaydi va filmga bog'laydi.
    adminConfirmVideo(key, id, { quality, size, storage }) {
      return post(`/admin/movies/${encodeURIComponent(id)}/video/confirm`,
        { quality, size, storage }, { adminKey: key });
    },

    // Admin: video manbasini o'chiradi (R2 object + DB).
    adminDeleteVideo(key, id, quality) {
      return del(`/admin/movies/${encodeURIComponent(id)}/video/${encodeURIComponent(quality)}`, { adminKey: key });
    },

    // Admin: film posterini yuklash (base64 data URL).
    adminUploadPoster(key, id, data) {
      return post(`/admin/movies/${encodeURIComponent(id)}/poster`, { data }, { adminKey: key });
    },

    // Admin: film posterini progress (%) bilan yuklash — katta rasm/sekin
    // tarmoqda foydalanuvchiga necha foiz yuklanganini ko'rsatish uchun.
    adminUploadPosterWithProgress(key, id, data, onProgress) {
      return postWithProgress(`/admin/movies/${encodeURIComponent(id)}/poster`, { data }, { adminKey: key }, onProgress);
    },

    // Admin: film posterini o'chirish.
    adminDeletePoster(key, id) {
      return del(`/admin/movies/${encodeURIComponent(id)}/poster`, { adminKey: key });
    },

    // Faylni storage'ga yuklaydi (presigned PUT URL yoki server'dagi upload endpoint).
    // fetch upload.progress ni qo'llab-quvvatlamagani uchun XHR ishlatiladi.
    // onProgress(loaded, total) — % hisoblash chaqiruvchida.
    // adminKey — lokal mode'da server'dagi upload endpoint'ni himoyalash uchun kerak.
    // return Promise<{ok, status?, message?}>
    uploadToR2(uploadUrl, file, onProgress, adminKey) {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl, true);
        xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
        if (adminKey) xhr.setRequestHeader("X-Admin-Key", adminKey);
        const initData = getInitData();
        if (initData) xhr.setRequestHeader("X-Telegram-Init-Data", initData);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
        };
        xhr.onerror = () => resolve({ ok: false, status: 0, message: "Tarmoq xatosi: fayl yuklanmadi" });
        xhr.onabort = () => resolve({ ok: false, status: 0, message: "Yuklash bekor qilindi" });
        xhr.onload = () => {
          const ok = xhr.status >= 200 && xhr.status < 300;
          resolve({
            ok,
            status: xhr.status,
            message: ok ? "" : `Upload xatosi (HTTP ${xhr.status})`,
          });
        };
        xhr.send(file);
      });
    },

    // BLOCKED holat tekshiruvi
    isBlocked,
  };

  window.KinoBotApi = api;
})();
