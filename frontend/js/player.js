// frontend/js/player.js
// Video player moduli — progressive / HLS / DASH mavhumligi.
// App.js video element bilan bevosita ishlamaydi; barcha hayot sikli shu yerda.
//
// videoSources normalizatsiyasi:
//   {url}                      -> [{url, type:"progressive", quality:"Auto"}]
//   {url, quality:"1080p"}     -> [{url, type:"progressive", quality:"1080p"}]
//   [{url, quality}, ...]      -> bir nechta sifat (quality tanlash UI)
//   .m3u8 -> hls,  .mpd -> dash,  boshqa -> progressive
//
// API:
//   KinoBotPlayer.load(movie, { resumeAt, onProgress, onEnded, onError, resolveUrl })
//     resolveUrl: (quality) => Promise<string> — R2 manbalari uchun signed URL.
//   KinoBotPlayer.qualities()          -> [{label, active}]
//   KinoBotPlayer.setQuality(index)    -> joriy pozitsiyadan davom etib almashtiradi
//   KinoBotPlayer.pause() / destroy()

(function () {
  "use strict";

  const HLS_JS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
  const R2_QUALITIES = ["360p", "480p", "720p", "1080p"];

  // To'liq ekran tugmasi ikonkalari (maximize / minimize).
  const FS_ENTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  const FS_EXIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

  // Eski format: {url} yoki [{url, quality}] — URL to'g'ridan-to'g'ri.
  function fromLegacy(arr) {
    const out = [];
    for (const s of arr) {
      if (!s || typeof s.url !== "string") continue;
      const url = s.url.trim();
      if (!url) continue;
      let type = "progressive";
      if (/\.m3u8($|\?)/i.test(url)) type = "hls";
      else if (/\.mpd($|\?)/i.test(url)) type = "dash";
      const label = s.quality ? String(s.quality) : "Auto";
      out.push({ url, type, label, quality: label });
    }
    return out;
  }

  // videoSources normalizatsiyasi:
  //   {url}                      -> [{url, type:"progressive", quality:"Auto"}]
  //   {url, quality:"1080p"}     -> [{url, type:"progressive", quality:"1080p"}]
  //   [{url, quality}, ...]      -> bir nechta sifat (quality tanlash UI)
  //   {"720p": {...}, "1080p":{...}}  -> R2 format (URL yo'q — resolveUrl orqali olinadi)
  //   .m3u8 -> hls,  .mpd -> dash,  boshqa -> progressive
  function resolveSources(videoSources) {
    if (!videoSources) return [];

    // R2 format: obyekt bo'lib, quality kalitlari (qiymati obyekt) bor.
    // Eski `url` key ham birga yashay oladi.
    if (!Array.isArray(videoSources) && typeof videoSources === "object") {
      const qualities = R2_QUALITIES.filter(
        (q) => videoSources[q] && typeof videoSources[q] === "object"
      );
      if (qualities.length) {
        const out = [];
        if (typeof videoSources.url === "string" && videoSources.url.trim()) {
          out.push(...fromLegacy([videoSources]));
        }
        // Sifatlar pastdan yuqoriga tartiblanadi (360p -> 1080p).
        qualities.sort((a, b) => parseFloat(a) - parseFloat(b));
        for (const q of qualities) {
          out.push({ r2: true, type: "progressive", quality: q, label: q });
        }
        return out;
      }
    }

    const arr = Array.isArray(videoSources) ? videoSources : [videoSources];
    return fromLegacy(arr);
  }

  // Safari HLS'ni tabiiy o'ynatadi; boshqalarga hls.js kerak.
  function nativeHls(video) {
    try {
      return video.canPlayType("application/vnd.apple.mpegurl") !== "";
    } catch (e) {
      return false;
    }
  }

  function loadHlsJs() {
    return new Promise((resolve, reject) => {
      if (window.Hls) return resolve(window.Hls);
      const el = document.createElement("script");
      el.src = HLS_JS_URL;
      el.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls.js yuklanmadi")));
      el.onerror = () => reject(new Error("hls.js yuklab bo'lmadi"));
      document.head.appendChild(el);
    });
  }

  const Player = {
    video: null,
    movieId: null,
    sources: [],
    current: 0,          // joriy sifat indeksi
    resumeAt: 0,
    lastPos: 0,          // oxirgi yuborilgan pozitsiya (sekund)
    lastSaveAt: 0,       // oxirgi progress saqlash vaqti (ms)
    hls: null,           // hls.js instance
    onProgress: null,
    onEnded: null,
    onError: null,
    resolveUrl: null,    // (quality) => Promise<url> — R2 signed URL olish uchun
    qualityEl: null,     // quality chip container
    fsBtn: null,          // to'liq ekran tugmasi
    isPseudoFullscreen: false, // CSS fallback rejimi (real Fullscreen API ishlamasa)

    // video element + quality chip o'rnatish (bir marta).
    init(video, qualityEl) {
      this.video = video;
      this.qualityEl = qualityEl || null;

      // DIQQAT: bu modul ba'zi testlarda `document` global'siz (yoki
      // addEventListener'siz minimal stub bilan) yuklanadi — shuning uchun
      // to'liq ekran integratsiyasi har doim himoyalangan holda ulanadi.
      if (typeof document !== "undefined" && typeof document.getElementById === "function") {
        this.fsBtn = document.getElementById("playerFullscreenBtn");
      }

      if (this.fsBtn && typeof this.fsBtn.addEventListener === "function" && !this._fsBtnBound) {
        this._fsBtnBound = true;
        this.fsBtn.innerHTML = FS_ENTER_ICON;
        this.fsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._toggleFullscreen();
        });
      }
      // Real Fullscreen API tashqi sabab bilan tugasa (foydalanuvchi tizim
      // "orqaga" tugmasini bossa, Esc bossa va h.k.) — ikonka va holatni
      // sinxronlab qo'yamiz.
      if (typeof document !== "undefined" && typeof document.addEventListener === "function" && !this._fsChangeBound) {
        this._fsChangeBound = true;
        const onFsChange = () => this._syncFullscreenState();
        document.addEventListener("fullscreenchange", onFsChange);
        document.addEventListener("webkitfullscreenchange", onFsChange);
      }

      // Oyna kattalashganda konteyner balandligini yangilaymiz
      // (Telegram webview'da viewport o'zgarishi tez-tez uchraydi).
      if (!this._boundResize) {
        const self = this;
        this._boundResize = () => {
          if (self.video && self.video.videoWidth > 0 && !self.video.paused) {
            self._adaptFrame();
          }
        };
        window.addEventListener("resize", this._boundResize);
        window.addEventListener("orientationchange", this._boundResize);
      }
    },

    // Yangi film yuklash.
    load(movie, opts = {}) {
      this.movieId = movie && movie.id;
      this.resumeAt = Math.max(0, Number(opts.resumeAt) || 0);
      this.onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
      this.onEnded = typeof opts.onEnded === "function" ? opts.onEnded : null;
      this.onError = typeof opts.onError === "function" ? opts.onError : null;
      this.resolveUrl = typeof opts.resolveUrl === "function" ? opts.resolveUrl : null;
      this.lastPos = 0;
      this.lastSaveAt = 0;
      this.current = 0;

      this.sources = resolveSources(movie && movie.videoSources);
      if (!this.sources.length) {
        this._showEmpty(movie);
        return false;
      }

      this.video.hidden = false;
      if (this.fsBtn) this.fsBtn.hidden = false;
      this._resetFrame();

      this.video.onloadedmetadata = () => {
        this._adaptFrame();
        if (this.resumeAt > 0 && isFinite(this.resumeAt)) {
          try { this.video.currentTime = Math.min(this.resumeAt, this.video.duration || 0); } catch (e) {}
          this.resumeAt = 0;
        }
        this.video.play().catch(() => {});
      };
      // Ba'zi brauzerlarda loadedmetadata metadata'ni oldinroq yuboradi;
      // playing esa videoning haqiqiy chiqa boshlaganini bildiradi —
      // ramkaga moslashishni ikki marta ta'minlaymiz.
      this.video.onplaying = () => this._adaptFrame();
      this.video.ontimeupdate = () => this._onTimeUpdate();
      this.video.onended = () => {
        if (this.onEnded) this.onEnded();
      };

      this._applySource().then(() => this._renderQuality()).catch(() => {});
      return true;
    },

    // Joriy sifat indeksini o'zgartiradi — pozitsiyani saqlab yangi manbaga o'tadi.
    setQuality(index) {
      if (!this.video || !this.sources.length) return;
      if (index === this.current) return;
      const pos = isFinite(this.video.currentTime) ? this.video.currentTime : 0;
      this.current = index;
      this._applySource().then(() => {
        if (pos > 0 && isFinite(pos)) {
          try { this.video.currentTime = pos; } catch (e) {}
          this.video.play().catch(() => {});
        }
        this._renderQuality();
      }).catch(() => {});
    },

    qualities() {
      return this.sources.map((s, i) => ({ label: s.label, active: i === this.current }));
    },

    pause() {
      if (this.video && !this.video.paused) this.video.pause();
    },

    destroy() {
      this._destroyHls();
      this._exitPseudoFullscreen();
      this._exitRealFullscreen();
      if (this.video) {
        this.video.onloadedmetadata = null;
        this.video.onplaying = null;
        this.video.ontimeupdate = null;
        this.video.onended = null;
        this.video.removeAttribute("src");
        this.video.hidden = true;
      }
      this.sources = [];
      this.current = 0;
      this.resumeAt = 0;
      this.onProgress = this.onEnded = this.onError = null;
      this.resolveUrl = null;
      if (this.qualityEl) this.qualityEl.hidden = true;
      if (this.fsBtn) this.fsBtn.hidden = true;
    },

    // ---- To'liq ekran ----
    // Strategiya: (1) haqiqiy Fullscreen API konteynerda sinaladi;
    // (2) ishlamasa (yoki Telegram WebView'da bo'lgani kabi jim
    // muvaffaqiyatsiz bo'lsa) iOS Safari uchun video.webkitEnterFullscreen;
    // (3) hech biri ishlamasa — CSS pseudo-fullscreen (har doim ishlaydi,
    // chunki oddiy DOM/CSS o'zgarishi, hech qanday brauzer ruxsatiga
    // bog'liq emas).
    _toggleFullscreen() {
      const wrap = this._wrap();
      if (!wrap) return;

      if (this._inRealFullscreen(wrap)) {
        this._exitRealFullscreen();
        return;
      }
      if (this.isPseudoFullscreen) {
        this._exitPseudoFullscreen();
        return;
      }

      const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen ||
        wrap.webkitRequestFullScreen || wrap.mozRequestFullScreen || wrap.msRequestFullscreen;

      if (req) {
        try {
          const result = req.call(wrap);
          if (result && typeof result.catch === "function") {
            result.catch(() => {}); // pastdagi tekshiruv baribir haqiqiy holatni aniqlaydi
          }
        } catch (e) {
          this._enterPseudoFullscreen();
          return;
        }
        // Ba'zi webview'lar (xususan Telegram) so'rovni "muvaffaqiyatli"
        // deb (hatto Promise'ni ham to'g'ri) qaytaradi-yu, aslida hech
        // narsa vizual jihatdan o'zgarmaydi. Shuning uchun promise
        // natijasiga emas, balki qisqa fursatdan keyin HAQIQIY DOM
        // holatiga (document.fullscreenElement) tayanib tekshiramiz —
        // shu holatdagina "muvaffaqiyatli" deb hisoblanadi.
        setTimeout(() => {
          if (!this._inRealFullscreen(wrap) && !this.isPseudoFullscreen) {
            this._enterPseudoFullscreen();
          }
        }, 350);
        return;
      }

      if (this.video && typeof this.video.webkitEnterFullscreen === "function") {
        try { this.video.webkitEnterFullscreen(); return; } catch (e) {}
      }

      this._enterPseudoFullscreen();
    },

    _inRealFullscreen(wrap) {
      if (typeof document === "undefined") return false;
      return document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap;
    },

    _exitRealFullscreen() {
      if (typeof document === "undefined") return;
      const exit = document.exitFullscreen || document.webkitExitFullscreen ||
        document.webkitCancelFullScreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (exit) { try { exit.call(document); } catch (e) {} }
    },

    _enterPseudoFullscreen() {
      const wrap = this._wrap();
      if (!wrap) return;
      this.isPseudoFullscreen = true;
      // MUHIM: normal ko'rinishda _setWrapHeight() konteynerga aniq
      // piksellik inline `style.height`/`aspectRatio` qo'yib qo'ygan —
      // bu qiymatlar CSS klassidagi to'liq ekran o'lchamidan KUCHLIROQ
      // (inline stil har doim ustun keladi), shuning uchun to'liq ekran
      // rejimi haqiqiy ekranni to'ldirmay, eski (kichik) balandlikda
      // qolib qolardi. Shu inline stillarni vaqtincha olib tashlaymiz —
      // CSS (.pseudo-fullscreen) o'lchamni to'liq boshqarsin.
      wrap.style.height = "";
      wrap.style.maxHeight = "";
      wrap.style.aspectRatio = "";
      wrap.classList.add("pseudo-fullscreen");
      if (typeof document !== "undefined" && document.body && document.body.classList) {
        document.body.classList.add("player-fs-lock");
      }
      try {
        if (typeof screen !== "undefined" && screen.orientation && screen.orientation.lock) {
          screen.orientation.lock("landscape").catch(() => {});
        }
      } catch (e) {}
      this._updateFsIcon();
    },

    _exitPseudoFullscreen() {
      if (!this.isPseudoFullscreen) return;
      const wrap = this._wrap();
      this.isPseudoFullscreen = false;
      if (wrap) wrap.classList.remove("pseudo-fullscreen");
      if (typeof document !== "undefined" && document.body && document.body.classList) {
        document.body.classList.remove("player-fs-lock");
      }
      try {
        if (typeof screen !== "undefined" && screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      } catch (e) {}
      // Sahifa ichidagi odatiy (nofullscreen) o'lchamni tiklaymiz — aks
      // holda konteyner to'liq ekrandan chiqqandan keyin ham o'lchamsiz
      // (yiqilgan) holda qolib ketishi mumkin.
      if (this.video && this.video.videoWidth > 0) {
        this._adaptFrame();
      } else {
        this._resetFrame();
      }
      this._updateFsIcon();
    },

    _syncFullscreenState() {
      const wrap = this._wrap();
      if (wrap && this._inRealFullscreen(wrap)) {
        // Haqiqiy fullscreen boshqargani uchun pseudo rejim keraksiz.
        this.isPseudoFullscreen = false;
      }
      this._updateFsIcon();
    },

    _updateFsIcon() {
      if (!this.fsBtn) return;
      const wrap = this._wrap();
      const active = this.isPseudoFullscreen || (wrap && this._inRealFullscreen(wrap));
      this.fsBtn.innerHTML = active ? FS_EXIT_ICON : FS_ENTER_ICON;
    },

    // ---- ichki ----

    // Video ramkasi (videoWidth/videoHeight) kelganda konteynerni
    // o'sha aspektga moslaydi va poster'ni yashiradi.
    _adaptFrame() {
      const wrap = this._wrap();
      // To'liq ekran (pseudo-fullscreen) paytida o'lchamni FAQAT CSS
      // boshqarishi kerak — bu yerda inline stil qo'ysak (masalan resize
      // yoki orientationchange hodisasi tufayli qayta chaqirilsa), u CSS
      // klassidan ustun kelib, to'liq ekranni yana buzib qo'yardi.
      if (wrap && !this.isPseudoFullscreen) {
        const w = this.video.videoWidth, h = this.video.videoHeight;
        wrap.style.aspectRatio = w > 0 && h > 0 ? w + " / " + h : "16 / 9";
        this._setWrapHeight(wrap, w, h);
      }
      this._hidePoster();
    },

    // Konteyner balandligini aniq pikselda o'rnatadi. `aspect-ratio`
    // CSS'ni qo'llamaydigan eski webview'larda ham video to'liq
    // ko'rinishi uchun JS bilan hisoblaymiz. Har qanday frame ishlaydi.
    _setWrapHeight(wrap, vw, vh) {
      try {
        const availW = wrap.clientWidth || wrap.offsetWidth;
        if (availW <= 0) return;
        const ratio = vh > 0 && vw > 0 ? vh / vw : 9 / 16;
        let h = availW * ratio;
        const maxH = window.innerHeight * (window.innerWidth < 600 ? 0.62 : 0.72);
        if (maxH > 0 && h > maxH) h = maxH;
        wrap.style.height = Math.round(h) + "px";
        wrap.style.maxHeight = "none";
      } catch (e) {}
    },

    // Yangi film boshlanishida konteynerni boshlang'ich 16:9 ga qaytarish.
    _resetFrame() {
      const wrap = this._wrap();
      if (wrap) {
        wrap.style.aspectRatio = "16 / 9";
        wrap.style.height = "";
        wrap.style.maxHeight = "";
      }
    },

    _wrap() {
      return this.video && this.video.closest ? this.video.closest(".player-video") : null;
    },

    _hidePoster() {
      const wrap = this._wrap();
      const poster = wrap && wrap.querySelector ? wrap.querySelector(".player-poster") : null;
      if (poster) poster.hidden = true;
    },

    _applySource() {
      const src = this.sources[this.current];
      if (!src) return Promise.resolve();
      this._destroyHls();

      // R2 manbasi: URL saqlanmaydi — backend orqali vaqtinchalik signed URL olinadi.
      if (src.r2) {
        if (typeof this.resolveUrl !== "function") {
          this._emitError("Video URL uchun resolver mavjud emas");
          return Promise.resolve();
        }
        return Promise.resolve()
          .then(() => this.resolveUrl(src.quality))
          .then((url) => {
            if (!url || typeof url !== "string" || !url.startsWith("http")) {
              throw new Error("Video URL olinmadi");
            }
            this.video.src = url;
          })
          .catch((err) => {
            this._emitError(err && err.message ? err.message : "Video URL yaratib bo'lmadi");
          });
      }

      if (src.type === "hls" && !nativeHls(this.video)) {
        return loadHlsJs().then((Hls) => {
          this.hls = new Hls();
          this.hls.loadSource(src.url);
          this.hls.attachMedia(this.video);
        }).catch((err) => {
          this._emitError(err.message);
        });
      }
      this.video.src = src.url;
      return Promise.resolve();
    },

    _emitError(message) {
      if (this.onError) {
        try { this.onError(message); } catch (e) {}
      }
    },

    _onTimeUpdate() {
      const v = this.video;
      if (!v || !isFinite(v.duration) || v.duration <= 0) return;
      const pos = v.currentTime;
      // Har bir frame'da yozmaslik: pozitsiya >=5s o'zgarganda va
      // oxirgi saqlashdan >=10s o'tganda callback.
      if (pos - this.lastPos < 5) return;
      if (Date.now() - this.lastSaveAt < 10000) return;
      const pct = Math.min(99, Math.round((pos / v.duration) * 100));
      this.lastPos = pos;
      this.lastSaveAt = Date.now();
      if (this.onProgress) this.onProgress(pct, Math.floor(pos));
    },

    _renderQuality() {
      const el = this.qualityEl;
      if (!el) return;
      if (this.sources.length < 2) { el.hidden = true; el.innerHTML = ""; return; }
      el.hidden = false;
      el.innerHTML = this.sources
        .map((s, i) =>
          `<button data-quality="${i}" class="${i === this.current ? "active" : ""}">${esc(s.label)}</button>`
        ).join("");
    },

    _destroyHls() {
      if (this.hls) {
        try { this.hls.destroy(); } catch (e) {}
        this.hls = null;
      }
    },

    _showEmpty(movie) {
      const emptyEl = document.getElementById("playerEmpty");
      const posterEl = document.getElementById("playerPoster");
      if (posterEl) {
        posterEl.hidden = false;
        posterEl.style.background = movie && movie.posterUrl ? `url('${esc(movie.posterUrl)}') center/cover` : "";
      }
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = `${icon("filmStrip", 40)}<p>${esc(t("playerNoSource")).replace(/\n/g, "<br>")}</p>`;
      }
      this.video.hidden = true;
      this.video.removeAttribute("src");
      if (this.qualityEl) this.qualityEl.hidden = true;
      if (this.fsBtn) this.fsBtn.hidden = true;
    },
  };

  // global yordamchilar (app.js'dagi kabi) — player.js app.js'dan keyin yuklansa
  // ishlaydi; lekin xavfsizlik uchun mavjud bo'lsa ishlatamiz.
  function esc(s) {
    s = String(s == null ? "" : s);
    if (window.KinoBotEsc) return window.KinoBotEsc(s);
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function icon(name, size, filled) {
    if (window.KinoBotIcon) return window.KinoBotIcon(name, size, filled);
    return "";
  }
  function t(key) {
    if (window.KinoBotT) return window.KinoBotT(key);
    return key;
  }

  // Testlar va admin uchun ochiq yordamchi: manba normalizatsiyasi.
  Player.resolveSources = resolveSources;
  Player.nativeHls = nativeHls;

  window.KinoBotPlayer = Player;
})();
