// frontend/js/app.js
// KinoBot Telegram Mini App — SPA logikasi. Barcha ma'lumotlar backend
// REST API'dan olinadi (KinoBotApi). Lokal demo ma'lumotlari YO'Q —
// backend manba-of-truth hisoblanadi.
//
// Xususiyatlar:
//  - Real backend ma'lumotlari (filmlar, janrlar, sevimlilar, tarix, profil)
//  - Real qidiruv (300ms debounce + backend /movies?q=)
//  - Sevimlilar: optimistik UI + muvaffaqiyatsizlikda rollback
//  - i18n: uz/en/ru (localStorage'da saqlanadi)
//  - Mavzu: dark/light/system (localStorage'da saqlanadi)
//  - Admin panel: haqiqiy CRUD backend orqali
//  - O'yinchi: faqat real videoSources mavjud bo'lsa video; aks holda aniq xabar

(function () {
  "use strict";

  // ===================== TELEGRAM WEBAPP INIT =====================
  const tg = window.Telegram?.WebApp;
  const hasTelegram = !!(tg && tg.initData);

  if (tg) {
    try {
      tg.ready();
      tg.expand();
    } catch (e) {}
  }

  // ===================== SOZLANMALAR (localStorage) =====================
  let lang = "uz";
  try { lang = localStorage.getItem("kb_lang") || "uz"; } catch (e) {}
  if (!["uz", "en", "ru"].includes(lang)) lang = "uz";

  let themePref = "dark";
  try { themePref = localStorage.getItem("kb_theme") || "dark"; } catch (e) {}
  if (!["dark", "light", "system"].includes(themePref)) themePref = "dark";

  let adminKey = "";
  try { adminKey = localStorage.getItem("kb_admin_key") || ""; } catch (e) {}

  // ===================== STATE =====================
  const state = {
    movies: [],          // to'liq ro'yxat (home/statistika uchun kesh)
    genres: [],
    favorites: new Set(),
    history: [],
    profile: null,
    banner: null,        // bosh sahifa banneri (getBanner dan)
    premiumEnabled: true, // admin panel orqali o'chirilishi mumkin
    streamingPremiumOnly: false, // admin panel orqali yoqilishi mumkin
    currentDetailId: null,
    currentDetailMovie: null,
    similar: [],
    selectedGenre: null,
    searchTimer: null,
    searchQuery: "",
    catalogOpts: {},     // filter/genre holati
    adminKey,
    adminAuthed: false,
    adminTab: "films",
    adminStats: null,
    adminStatsPeriod: 7,     // 7 | 30 | "all"
    adminUsersFilter: "ALL",   // ALL | ACTIVE | BLOCKED
    adminUsersQuery: "",       // qidiruv matni
    adminUsersTimer: null,     // qidiruv debounce uchun
    adminFilmsFilter: "ALL",   // ALL | ACTIVE | INACTIVE | HIDDEN
    adminPaymentsFilter: "pending", // pending | approved | rejected | ALL
    adminPremiumTab: "payments",    // payments | settings — Premium bo'limi ichidagi sub-tab
    playerLastPos: 0,          // o'yinchida oxirgi saqlangan pozitsiya (sekund)
    playerLastSaveAt: 0,       // oxirgi progress saqlash vaqti (ms)
    premium: null,             // { status, plan, expiresAt, isActive }
    premiumPlans: [],
    premiumPaymentSettings: null, // { cardNumber, cardHolder }
    premiumPayments: [],       // foydalanuvchining o'z to'lovlari tarixi
    premiumSelectedPlan: null,
    planList: [],              // admin plan ro'yxati (movie form uchun)
  };

  // ===================== i18n DICTIONARY =====================
  const DICT = {
    uz: {
      navHome: "Bosh sahifa", navCatalog: "Katalog", navSearch: "Qidiruv",
      navFavorites: "Sevimlilar", navProfile: "Profil",
      trendingTitle: "Trenddagi filmlar", newTitle: "Yangi qo'shilganlar",
      byGenre: "Janrlar bo'yicha", seeAll: "Barchasi",
      continueTitle: "Davom etish", resumeBtn: "Davom etish",
      catalogTitle: "Katalog", allMovies: "Barcha filmlar",
      searchPlaceholder: "Film nomini kiriting...", popularSearches: "Ommabop qidiruvlar",
      searchResults: "Natijalar", searchEmpty: "Hech narsa topilmadi",
      searchType: "Qidiruvni boshlash uchun biror narsa yozing",
      watchNow: "Ko'rish", watchInBot: "Botda ko'rish", sendingVideo: "Yuborilmoqda...", videoSentToast: "🎬 Video botga yuborildi!",
      addToFav: "Sevimlilarga qo'shish", inFav: "Sevimlilarda",
      addToFavPlayer: "Sevimlilarga", similarTitle: "O'xshash filmlar",
      favoritesTitle: "Sevimlilar", favEmpty: "Sevimlilar ro'yxati bo'sh", browseMovies: "Filmlarni ko'rish",
      historyTitle: "Tarix", histEmpty: "Tarix hali bo'sh",
      profileTitle: "Profil", favoritesMenu: "Sevimlilar", historyMenu: "Ko'rilganlar tarixi",
      settingsMenu: "Sozlamalar", adminMenu: "Admin Panel", contactMenu: "Biz bilan bog'lanish", contactHint: "Savol yoki taklifingiz bo'lsa, quyida yozing. Xabaringiz administratorga yuboriladi.", contactPlaceholder: "Xabaringizni yozing...", contactSend: "Yuborish", contactEmpty: "Xabar matni bo'sh bo'lmasligi kerak", contactSent: "Xabaringiz yuborildi!",
      logoutMenu: "Chiqish",
      settingsTitle: "Sozlamalar", languageSection: "Til / Language", themeSection: "Mavzu / Theme",
      themeDark: "Qora", themeLight: "Yorug'", themeSystem: "Avtomatik", aboutApp: "Ilova haqida",
      adminTitle: "Admin Panel", adminFilmsTab: "Filmlar", adminChannelsTab: "Kanallar",
      adminUsersTab: "Foydalanuvchilar", adminStatsTab: "Statistika", addFilm: "Film qo'shish",
      adminStorageTab: "Kanal videolari",
      adminStorageHint: "Storage kanalga avtomatik saqlangan videolar. Manba: bot.js — Telegram MTProto orqali.",
      adminStorageEmpty: "Hozircha saqlangan video yo'q.",
      adminStoragePlay: "Ko'rish", adminStorageDisabled: "Bu xususiyat .env'da sozlanmagan (TELEGRAM_API_ID/HASH/STORAGE_CHANNEL_ID).",
      adminKeyPrompt: "Admin kalitini kiriting",
      adminKeyPlaceholder: "Admin kaliti",
      adminConnect: "Kirish",
      adminKeyInvalid: "Kalit noto'g'ri yoki ruxsat yo'q",
      adminPassword: "Parolni o'zgartirish",
      adminPasswordCurrent: "Joriy parol",
      adminPasswordNew: "Yangi parol (kamida 8 belgi)",
      adminPasswordConfirm: "Yangi parolni takrorlang",
      adminPasswordMismatch: "Parollar mos kelmadi",
      adminPasswordChanged: "Parol yangilandi",
      adminPasswordSaved: "Yangi parol endi kirishda ishlatiladi",
      pwStrengthVeryWeak: "Juda zaif",
      pwStrengthWeak: "Zaif",
      pwStrengthFair: "O'rtacha",
      pwStrengthGood: "Yaxshi",
      pwStrengthStrong: "Kuchli",
      pwMatch: "Parollar mos keladi",
      pwMismatch: "Parollar mos kelmayapti",
      adminNoData: "Ma'lumot yo'q",
      adminStatusAll: "Barchasi", adminStatusActive: "Faol", adminStatusInactive: "Nofaol", adminStatusHidden: "Yashirin",
      adminFilmFeatured: "Tanlangan",
      adminGenreActive: "Faol", adminGenreInactive: "Yashirin",
      adminGenreDeactivate: "Yashirish", adminGenreActivate: "Faollashtirish",
      confirmDeactivateGenre: "\"{name}\" janrini yashirishni tasdiqlaysizmi?", confirmActivateGenre: "\"{name}\" janrini qayta faollashtirishni tasdiqlaysizmi?",
      filterTitle: "Filtr va saralash", filterGenres: "Janrlar",
      filterYear: "Yil", filterRating: "Reyting", filterClear: "Tozalash", filterApply: "Qo'llash",
      infoTitle: "KinoBot haqida", infoDesc: "KinoBot — sizga eng yaxshi kinolarni taqdim etuvchi bot.",
      privacyPolicy: "Maxfiylik siyosati",
      playerNoSource: "Bu filmda hozircha video manbasi mavjud emas.\nTez orada qo'shiladi.",
      playerError: "Video yuklanmadi. Keyinroq qayta urinib ko'ring.",
      genreCount: "{n} ta film", filmCount: "{n} ta film",
      confirmTitle: "Tasdiqlash", confirmDeleteFilm: "Ushbu filmni o'chirishni tasdiqlaysizmi?",
      confirmDeleteGenre: "\"{name}\" janrini o'chirishni tasdiqlaysizmi?",
      cancelBtn: "Bekor qilish", deleteBtn: "O'chirish", saveBtn: "Saqlash",
      savingBtn: "Saqlanmoqda...", uploadingBtn: "Rasm yuklanmoqda",
      toastFavAdded: "Sevimlilarga qo'shildi", toastFavRemoved: "Sevimlilardan olib tashlandi",
      toastError: "Xatolik yuz berdi. Qayta urinib ko'ring.",
      toastSaved: "Saqlanib qoldi", toastDeleted: "O'chirildi",
      movieFormTitle: "Film ma'lumotlari", movieFormTitleNew: "Yangi film qo'shish", movieFormTitleEdit: "Filmni tahrirlash",
      movieTitle: "Nomi", movieTitlePlaceholder: "Film nomini kiriting", movieOriginalTitle: "Asl nomi", movieOriginalTitlePlaceholder: "Asl nomini kiriting", movieYearPlaceholder: "Masalan: 2024", movieRatingPlaceholder: "Masalan: 5",
      movieYear: "Yil", movieRating: "Reyting (0–10)", movieGenres: "Janrlar (vergul bilan)",
      movieDuration: "Davomiyligi", movieDescription: "Tavsif", movieDescriptionPlaceholder: "Film haqida qisqacha ma'lumot...",
      moviePosterUrl: "Poster URL (ixtiyoriy)", moviePosterUpload: "Poster yuklash", posterUploadHint: "Rasm tanlang (JPG/PNG/WebP/GIF, 2MB gacha)",
      posterDeleteBtn: "Posterni o'chirish", posterAutoExtracted: "Poster video kadridan avtomatik olindi",
      movieFormSectionInfo: "Asosiy ma'lumotlar", movieFormSectionMedia: "Media (Poster)", movieFormSectionDescription: "Tavsif", movieFormSectionAdvanced: "Qo'shimcha sozlamalar",
      adminBannerBtn: "Banner", bannerModalTitle: "Bosh sahifa banneri",
      bannerType: "Banner turi", bannerTypeMovie: "Film (tanlangan kinoni tavsiya qilish)", bannerTypeAd: "Reklama",
      bannerMoviePick: "Filmdan tanlang", bannerTitle: "Sarlavha", bannerText: "Matn", bannerLink: "Havola (URL)",
      bannerImage: "Rasm (ixtiyoriy)", bannerImageRemove: "Rasmni o'chirish", bannerActive: "Banner faol",
      bannerRemove: "Bannerni o'chirish", bannerEmpty: "Banner o'rnatilmagan. Reklama yoki film tanlang.",
      bannerMovieBadge: "Tavsiya etilgan film", bannerAdBadge: "Reklama", bannerGo: "Havolaga o'tish", bannerMoreInfo: "Batafsil",
      movieStatus: "Holat", movieStatusActive: "Faol", movieStatusInactive: "Nofaol", movieStatusHidden: "Yashirin",
      movieFeatured: "Tanlangan (bosh sahifada)", movieIsPremium: "Premium film (faqat Premium foydalanuvchilar uchun)", movieTrending: "Trenddagi filmlarga qo'shish", movieTrendingOrder: "Trend tartib raqami", movieTrendingBanner: "Trend banner rasm (URL)",
      edit: "Tahrirlash", delete: "O'chirish", adminStatsMovies: "Filmlar", adminStatsUsers: "Foydalanuvchilar",
      adminStatsGenres: "Janrlar", adminStatsFavs: "Sevimlilar", adminStatsHistory: "Tarix yozuvlari",
      adminStatsActiveUsers: "Faol foydalanuvchilar", adminStatsBlockedUsers: "Bloklangan foydalanuvchilar",
      adminStatsNewUsers: "Yangi foydalanuvchilar", adminStatsPeriod: "Davr", adminStatsPeriod7d: "7 kun",
      adminStatsPeriod30d: "30 kun", adminStatsPeriodAll: "Hammasi", adminStatsMostWatched: "Eng ko'p ko'rilganlar",
      adminStatsDailyActivity: "Kunlik faollik", adminStatsEvents: "Hodisalar", adminStatsPlays: "{n} marta",
      eventUserRegistered: "Yangi foydalanuvchilar", eventUserOpenedApp: "Ilovani ochish",
      eventMovieOpened: "Filmlarni ochish", eventPlaybackStarted: "Boshlangan kinolar",
      eventPlaybackCompleted: "Tugatilgan kinolar", eventPlaybackFailed: "Xatoliklar",
      eventFavoriteAdded: "Sevimlilarga qo'shish", eventFavoriteRemoved: "Sevimlilardan olish",
      eventHistoryUpdated: "Tarix yangilanishlari",
      addGenre: "Janr qo'shish", genrePlaceholder: "Yangi janr nomi", addBtn: "Qo'shish",
      adminChannelsHint: "Bu yerga qo'shilgan kanallarga foydalanuvchilar majburiy obuna bo'lishi kerak.",
      adminChannelChatIdPlaceholder: "@kanalusername yoki -100xxxxxxxxxx",
      adminChannelTitlePlaceholder: "Kanal nomi",
      adminChannelLinkPlaceholder: "Obuna havolasi (ixtiyoriy)",
      adminChannelChatIdRequired: "Kanal ID/username kiriting",
      adminChannelLinkRequiredPrivate: "Shaxsiy kanal (-100...) uchun Obuna havolasini ham kiriting — aks holda foydalanuvchi qo'shila olmaydi",
      confirmDeleteChannel: "Bu kanalni ro'yxatdan olib tashlaysizmi?",
      subscribeTitle: "Obuna bo'ling",
      subscribeMessage: "Ilovadan foydalanish uchun quyidagi kanallarga obuna bo'ling",
      subscribeJoinBtn: "Obuna bo'lish",
      subscribeCheckBtn: "Tekshirish",
      subscribeStillMissing: "Hali barcha kanallarga obuna bo'lmadingiz",
      usersEmpty: "Hozircha foydalanuvchilar yo'q",
      name: "Ism", username: "Username", registered: "Ro'yxatdan o'tdi", historyFull: "To'liq ko'rilgan",
      historyPct: "{n}% gacha", logoutConfirm: "Telegram'dan chiqasizmi?", connected: "Ulangan",
      errorLoad: "Ma'lumotlarni yuklab bo'lmadi",
      blockedTitle: "Hisobingiz bloklangan",
      blockedDesc: "Administrator hisobingizni vaqtincha to'xtatdi. Iltimos, keyinroq qayta urinib ko'ring yoki yordam uchun administrator bilan bog'laning.",
      block: "Bloklash", unblock: "Blokdan chiqarish",
      makeAdmin: "Adminga aylantirish", removeAdmin: "Adminlikdan olish",
      userDetailTitle: "Foydalanuvchi ma'lumotlari", userStats: "Statistika",
      favCount: "Sevimlilar", histCount: "Tarix yozuvlari", completedCount: "To'liq ko'rilgan",
      watchTime: "Ko'rilgan vaqt", lastSeen: "Oxirgi ko'rilgan",
      searchUsers: "Qidirish...", allUsers: "Barchasi", activeUsers: "Faol", blockedUsers: "Bloklangan",
      userStatus: "Holat", userStatusActive: "Faol", userStatusBlocked: "Bloklangan",
      noUsers: "Hozircha foydalanuvchilar yo'q",
      adminAuditTab: "Audit log", adminContactTab: "Xabarlar", adminPremiumTab: "Premium", contactMarkRead: "O'qildim", contactBlockUser: "Yozishdan bloklash", contactUserBlockedToast: "Foydalanuvchi aloqa formasidan bloklandi", auditTitle: "Audit log", auditAdminId: "Admin ID",
      auditAction: "Amal", auditEntity: "Obyekt", auditTime: "Vaqt", backBtn: "Orqaga",
      closeBtn: "Yopish", userBlockedToast: "Foydalanuvchi bloklandi", userUnblockedToast: "Foydalanuvchi blokdan chiqarildi",
      adminRoleUpdatedToast: "Admin holati yangilandi",
      offlineToast: "Internet ulanishi yo'q. Ma'lumotlar yangilanmaydi.",
      onlineToast: "Internet ulanishi tiklandi. Ma'lumotlar yangilanmoqda...",
      loadMoreBtn: "Yana yuklash",
      loading: "Yuklanmoqda...",
      videoManageTitle: "Video manbalari",
      videoUploadBtn: "Yuklash",
      videoNotUploaded: "Yuklanmagan",
      videoDeleteConfirm: "{quality} sifatli videoni o'chirishni tasdiqlaysizmi?",
      videoUploading: "Yuklanmoqda...",
      videoLegacyNote: "Eski URL manba (to'g'ridan-to'g'ri link) ham mavjud",
      videoStorageR2: "R2 bulut",
      videoStorageLocal: "Kali server",
      videoStorageSel: "Saqlash joyi:",
      videoHint: "R2 tanlansa video bulutga, Kali server tanlansa kompyuteringizga yuklanadi. Yuklaganingizdan so'ng film sahifasida sifat tanlash mumkin bo'ladi.",
      studioTitleNew: "Yangi film studiyasi", studioTitleEdit: "Filmni tahrirlash",
      studioSaveDraft: "Qoralama saqlash", studioPublish: "Saqlash va e'lon qilish",
      studioPublishEdit: "O'zgarishlarni saqlash", studioSaving: "Saqlanmoqda...",
      studioStepInfo: "Asosiy", studioStepMedia: "Media", studioStepVideo: "Video",
      studioStepExtra: "Qo'shimcha", studioStepNote: "Qadam {n}/4",
      studioPosterOr: "yoki", studioPosterAuto: "Videodan avtomatik olish",
      studioNoMovie: "Avval filmni saqlang", studioNeedTitle: "Nomi va yil majburiy",
      studioVideoAfterSave: "Videoni yuklash uchun filmni saqlang", studioMovieCreatedNowUploadVideo: "Film yaratildi! Endi video yuklang.",
      studioUploadedOk: "Video yuklandi", studioSectionPoster: "Poster",
      studioSectionVideo: "Video manbalari",
      // Premium & to'lov
      premiumMenu: "Premium", premiumMenuActive: "Premium faol",
      premiumTitle: "Premium", premiumChoosePlan: "Paketni tanlang",
      premiumPlan1Month: "1 oy", premiumPlan3Months: "3 oy", premiumPlan1Year: "1 yil",
      premiumPaymentDetails: "To'lov rekvizitlari", premiumNoCardSettings: "Karta ma'lumotlari hali kiritilmagan",
      premiumUploadCheck: "Chek rasmini yuklang", premiumCheckHint: "Chek rasmini tanlang (JPG/PNG, 3MB gacha)",
      premiumSubmitBtn: "To'lovni yuborish", premiumSubmitting: "Yuborilmoqda...",
      premiumPendingHint: "To'lov yuborilgandan so'ng, admin tekshirib chiqadi va Premium faollashtiriladi.",
      premiumSelectPlanFirst: "Avval paketni tanlang", premiumCheckRequired: "Chek rasmini yuklang",
      premiumCheckTooLarge: "Rasm juda katta (maks. 3MB)", premiumSubmittedToast: "To'lov yuborildi! Admin tasdiqlashini kuting.",
      premiumActiveTitle: "Premium faol", premiumActivePlan: "Paket", premiumActiveExpires: "Muddati",
      premiumExpiredToast: "Premium muddati tugadi", premiumRequiredToast: "Bu film faqat Premium foydalanuvchilar uchun",
      premiumHistoryTitle: "To'lovlar tarixi", unlockWithPremium: "Premium bilan ochish",
      paymentStatusPending: "Kutilmoqda", paymentStatusApproved: "Tasdiqlangan", paymentStatusRejected: "Rad etilgan",
      adminPaymentsTab: "To'lovlar", adminPaymentSettingsTab: "To'lov sozlamalari", adminPremiumEnabledLabel: "Premium tizimi yoqilgan", adminStreamingPremiumLabel: "Video-strim faqat Premium",
      adminPlansTab: "Paketlar", adminNoPlans: "Paketlar yo'q",
      moviePlanAssignment: "Paketlar bilan bog'lash", moviePlanHint: "Film qaysi paketlar bilan ochilishi belgilansin. Bo'sh = barcha paketlar",
      adminPlanPrice: "Narx: {price}", adminPlanDuration: "Muddat: {days} kun", adminPlanMovies: "kinolar", adminPlanAllMovies: "Barcha premium kinolar",
      confirmDeletePlan: "«{name}» paketini o'chirishni tasdiqlaysizmi?", adminNoPremiumMovies: "Premium kinolar yo'q",
      searchMovies: "Kinolarni qidirish...", backBtn: "Orqaga",
      planName: "Paket nomi", planNamePlaceholder: "Masalan: Basic, Pro, VIP", planPrice: "Narx", planDuration: "Muddat", planActive: "Faol",
      planFieldsRequired: "Barcha maydonlarni to'ldiring", planNewTitle: "Yangi paket", planEditTitle: "Paketni tahrirlash",
      paymentViewCheck: "Chekni ko'rish", paymentApprove: "Tasdiqlash", paymentReject: "Rad etish",
      paymentApprovedToast: "To'lov tasdiqlandi, Premium faollashtirildi", paymentRejectedToast: "To'lov rad etildi",
      paymentDetailTitle: "To'lov tafsilotlari", paymentUser: "Foydalanuvchi", paymentAmount: "Summa",
      paymentStatus: "Holat", paymentDate: "Sana", paymentNoCheck: "Chek rasmi topilmadi", paymentDownloadCheck: "Chekni yuklab olish",
      paymentSettingsCardNumber: "Karta raqami", paymentSettingsCardHolder: "Karta egasi",
      paymentSettingsCardInvalid: "Karta raqami to'g'ri emas", paymentSettingsHolderRequired: "Karta egasi ismi kerak",
      paymentSettingsUpdatedAt: "Oxirgi yangilanish",
    },
    en: {
      navHome: "Home", navCatalog: "Catalog", navSearch: "Search",
      navFavorites: "Favorites", navProfile: "Profile",
      trendingTitle: "Trending now", newTitle: "New releases",
      byGenre: "Browse by genre", seeAll: "See all",
      continueTitle: "Continue watching", resumeBtn: "Resume",
      catalogTitle: "Catalog", allMovies: "All movies",
      searchPlaceholder: "Search movie titles...", popularSearches: "Popular searches",
      searchResults: "Results", searchEmpty: "Nothing found",
      searchType: "Type something to start searching",
      watchNow: "Watch", watchInBot: "Watch in bot", sendingVideo: "Sending...", videoSentToast: "🎬 Video sent to the bot chat!",
      addToFav: "Add to favorites", inFav: "In favorites",
      addToFavPlayer: "Add to favorites", similarTitle: "Similar movies",
      favoritesTitle: "Favorites", favEmpty: "Your favorites list is empty", browseMovies: "Browse movies",
      historyTitle: "History", histEmpty: "No watch history yet",
      profileTitle: "Profile", favoritesMenu: "Favorites", historyMenu: "Watch history",
      settingsMenu: "Settings", adminMenu: "Admin Panel", contactMenu: "Contact us", contactHint: "If you have a question or suggestion, write it below. Your message will be sent to the administrator.", contactPlaceholder: "Type your message...", contactSend: "Send", contactEmpty: "Message text cannot be empty", contactSent: "Your message has been sent!",
      logoutMenu: "Log out",
      settingsTitle: "Settings", languageSection: "Language", themeSection: "Theme",
      themeDark: "Dark", themeLight: "Light", themeSystem: "Automatic", aboutApp: "About",
      adminTitle: "Admin Panel", adminFilmsTab: "Movies", adminChannelsTab: "Channels",
      adminUsersTab: "Users", adminStatsTab: "Analytics", addFilm: "Add movie",
      adminStorageTab: "Channel videos",
      adminStorageHint: "Videos auto-saved to the storage channel via Telegram MTProto (bot.js).",
      adminStorageEmpty: "No saved videos yet.",
      adminStoragePlay: "Play", adminStorageDisabled: "This feature isn't configured in .env (TELEGRAM_API_ID/HASH/STORAGE_CHANNEL_ID).",
      adminKeyPrompt: "Enter admin key",
      adminKeyPlaceholder: "Admin key",
      adminConnect: "Connect",
      adminKeyInvalid: "Invalid key or no permission",
      adminPassword: "Change password",
      adminPasswordCurrent: "Current password",
      adminPasswordNew: "New password (min 8 chars)",
      adminPasswordConfirm: "Confirm new password",
      adminPasswordMismatch: "Passwords do not match",
      adminPasswordChanged: "Password changed",
      adminPasswordSaved: "The new password is now used to log in",
      pwStrengthVeryWeak: "Very weak",
      pwStrengthWeak: "Weak",
      pwStrengthFair: "Fair",
      pwStrengthGood: "Good",
      pwStrengthStrong: "Strong",
      pwMatch: "Passwords match",
      pwMismatch: "Passwords do not match",
      adminNoData: "No data",
      adminStatusAll: "All", adminStatusActive: "Active", adminStatusInactive: "Inactive", adminStatusHidden: "Hidden",
      adminFilmFeatured: "Featured",
      adminGenreActive: "Active", adminGenreInactive: "Hidden",
      adminGenreDeactivate: "Hide", adminGenreActivate: "Activate",
      confirmDeactivateGenre: "Hide genre \"{name}\"?", confirmActivateGenre: "Reactivate genre \"{name}\"?",
      filterTitle: "Filter & sort", filterGenres: "Genres",
      filterYear: "Year", filterRating: "Rating", filterClear: "Clear", filterApply: "Apply",
      infoTitle: "About KinoBot", infoDesc: "KinoBot — a bot that brings you the best movies.",
      privacyPolicy: "Privacy policy",
      playerNoSource: "No video source available for this movie yet.\nIt will be added soon.",
      playerError: "Video failed to load. Please try again later.",
      genreCount: "{n} movies", filmCount: "{n} movies",
      confirmTitle: "Confirm", confirmDeleteFilm: "Delete this movie?",
      confirmDeleteGenre: 'Delete genre "{name}"?',
      cancelBtn: "Cancel", deleteBtn: "Delete", saveBtn: "Save",
      savingBtn: "Saving...", uploadingBtn: "Uploading image",
      toastFavAdded: "Added to favorites", toastFavRemoved: "Removed from favorites",
      toastError: "Something went wrong. Try again.",
      toastSaved: "Saved", toastDeleted: "Deleted",
      movieFormTitle: "Movie details", movieFormTitleNew: "Add New Movie", movieFormTitleEdit: "Edit Movie",
      movieTitle: "Title", movieTitlePlaceholder: "Enter movie title", movieOriginalTitle: "Original title", movieOriginalTitlePlaceholder: "Enter original title", movieYearPlaceholder: "E.g. 2024", movieRatingPlaceholder: "E.g. 5",
      movieYear: "Year", movieRating: "Rating (0–10)", movieGenres: "Genres (comma separated)",
      movieDuration: "Duration", movieDescription: "Description", movieDescriptionPlaceholder: "Brief description...",
      moviePosterUrl: "Poster URL (optional)", moviePosterUpload: "Upload poster", posterUploadHint: "Choose an image (JPG/PNG/WebP/GIF, up to 2MB)",
      posterDeleteBtn: "Delete poster", posterAutoExtracted: "Poster auto-extracted from video frame",
      movieFormSectionInfo: "Basic Info", movieFormSectionMedia: "Media (Poster)", movieFormSectionDescription: "Description", movieFormSectionAdvanced: "Advanced Settings",
      adminBannerBtn: "Banner", bannerModalTitle: "Home page banner",
      bannerType: "Banner type", bannerTypeMovie: "Movie (feature a movie)", bannerTypeAd: "Ad",
      bannerMoviePick: "Pick a movie", bannerTitle: "Title", bannerText: "Text", bannerLink: "Link (URL)",
      bannerImage: "Image (optional)", bannerImageRemove: "Remove image", bannerActive: "Banner active",
      bannerRemove: "Delete banner", bannerEmpty: "No banner set. Choose an ad or a movie.",
      bannerMovieBadge: "Featured movie", bannerAdBadge: "Ad", bannerGo: "Open link", bannerMoreInfo: "Learn more",
      movieStatus: "Status", movieStatusActive: "Active", movieStatusInactive: "Inactive", movieStatusHidden: "Hidden",
      movieFeatured: "Featured (on home)", movieIsPremium: "Premium movie (Premium users only)", movieTrending: "Add to trending", movieTrendingOrder: "Trending order", movieTrendingBanner: "Trending banner image (URL)",
      edit: "Edit", delete: "Delete", adminStatsMovies: "Movies", adminStatsUsers: "Users",
      adminStatsGenres: "Genres", adminStatsFavs: "Favorites", adminStatsHistory: "History entries",
      adminStatsActiveUsers: "Active users", adminStatsBlockedUsers: "Blocked users",
      adminStatsNewUsers: "New users", adminStatsPeriod: "Period", adminStatsPeriod7d: "7 days",
      adminStatsPeriod30d: "30 days", adminStatsPeriodAll: "All time", adminStatsMostWatched: "Most watched",
      adminStatsDailyActivity: "Daily activity", adminStatsEvents: "Events", adminStatsPlays: "{n} plays",
      eventUserRegistered: "New users", eventUserOpenedApp: "App opens",
      eventMovieOpened: "Movies opened", eventPlaybackStarted: "Playbacks started",
      eventPlaybackCompleted: "Playbacks completed", eventPlaybackFailed: "Playback failures",
      eventFavoriteAdded: "Favorites added", eventFavoriteRemoved: "Favorites removed",
      eventHistoryUpdated: "History updates",
      addGenre: "Add genre", genrePlaceholder: "New genre name", addBtn: "Add",
      adminChannelsHint: "Users must subscribe to channels added here.",
      adminChannelChatIdPlaceholder: "@channelusername or -100xxxxxxxxxx",
      adminChannelTitlePlaceholder: "Channel title",
      adminChannelLinkPlaceholder: "Invite link (optional)",
      adminChannelChatIdRequired: "Enter channel ID/username",
      adminChannelLinkRequiredPrivate: "For a private channel (-100...) the invite link is also required, otherwise users can't join",
      confirmDeleteChannel: "Remove this channel from the list?",
      subscribeTitle: "Subscribe",
      subscribeMessage: "Subscribe to the channels below to use the app",
      subscribeJoinBtn: "Subscribe",
      subscribeCheckBtn: "Check",
      subscribeStillMissing: "You haven't subscribed to all channels yet",
      usersEmpty: "No users yet",
      name: "Name", username: "Username", registered: "Registered", historyFull: "Fully watched",
      historyPct: "{n}% watched", logoutConfirm: "Log out of Telegram?", connected: "Connected",
      errorLoad: "Failed to load data",
      blockedTitle: "Your account is blocked",
      blockedDesc: "An administrator has temporarily blocked your account. Please try again later or contact the administrator for help.",
      block: "Block", unblock: "Unblock",
      makeAdmin: "Make admin", removeAdmin: "Remove admin",
      userDetailTitle: "User details", userStats: "Statistics",
      favCount: "Favorites", histCount: "History entries", completedCount: "Fully watched",
      watchTime: "Watch time", lastSeen: "Last seen",
      searchUsers: "Search...", allUsers: "All", activeUsers: "Active", blockedUsers: "Blocked",
      userStatus: "Status", userStatusActive: "Active", userStatusBlocked: "Blocked",
      noUsers: "No users yet",
      adminAuditTab: "Audit log", adminContactTab: "Messages", adminPremiumTab: "Premium", contactMarkRead: "Mark read", contactBlockUser: "Block from messaging", contactUserBlockedToast: "User blocked from contact form", auditTitle: "Audit log", auditAdminId: "Admin ID",
      auditAction: "Action", auditEntity: "Entity", auditTime: "Time", backBtn: "Back",
      closeBtn: "Close", userBlockedToast: "User blocked", userUnblockedToast: "User unblocked",
      adminRoleUpdatedToast: "Admin role updated",
      offlineToast: "No internet connection. Data won't update.",
      onlineToast: "Internet connection restored. Updating data...",
      loadMoreBtn: "Load more",
      loading: "Loading...",
      videoManageTitle: "Video sources",
      videoUploadBtn: "Upload",
      videoNotUploaded: "Not uploaded",
      videoDeleteConfirm: "Delete the {quality} video?",
      videoUploading: "Uploading...",
      videoLegacyNote: "A legacy URL source (direct link) also exists",
      videoStorageR2: "R2 cloud",
      videoStorageLocal: "Kali server",
      videoStorageSel: "Storage:",
      videoHint: "R2 stores the video in the cloud, Kali server stores it on your computer. After uploading, quality selection becomes available on the movie page.",
      studioTitleNew: "New Film Studio", studioTitleEdit: "Edit Film",
      studioSaveDraft: "Save Draft", studioPublish: "Save & Publish",
      studioPublishEdit: "Save Changes", studioSaving: "Saving...",
      studioStepInfo: "Info", studioStepMedia: "Media", studioStepVideo: "Video",
      studioStepExtra: "Extras", studioStepNote: "Step {n}/4",
      studioPosterOr: "or", studioPosterAuto: "Auto-extract from video",
      studioNoMovie: "Save film first", studioNeedTitle: "Title and year required",
      studioVideoAfterSave: "Save film to upload video", studioMovieCreatedNowUploadVideo: "Movie created! Now upload the video.",
      studioUploadedOk: "Video uploaded", studioSectionPoster: "Poster",
      studioSectionVideo: "Video sources",
      // Premium & payments
      premiumMenu: "Premium", premiumMenuActive: "Premium active",
      premiumTitle: "Premium", premiumChoosePlan: "Choose a plan",
      premiumPlan1Month: "1 month", premiumPlan3Months: "3 months", premiumPlan1Year: "1 year",
      premiumPaymentDetails: "Payment details", premiumNoCardSettings: "Card details not set yet",
      premiumUploadCheck: "Upload payment receipt", premiumCheckHint: "Choose a receipt image (JPG/PNG, up to 3MB)",
      premiumSubmitBtn: "Submit payment", premiumSubmitting: "Submitting...",
      premiumPendingHint: "After submitting, the admin will review it and activate your Premium.",
      premiumSelectPlanFirst: "Please choose a plan first", premiumCheckRequired: "Please upload a receipt image",
      premiumCheckTooLarge: "Image too large (max 3MB)", premiumSubmittedToast: "Payment submitted! Waiting for admin approval.",
      premiumActiveTitle: "Premium active", premiumActivePlan: "Plan", premiumActiveExpires: "Expires",
      premiumExpiredToast: "Your Premium has expired", premiumRequiredToast: "This movie is for Premium users only",
      premiumHistoryTitle: "Payment history", unlockWithPremium: "Unlock with Premium",
      paymentStatusPending: "Pending", paymentStatusApproved: "Approved", paymentStatusRejected: "Rejected",
      adminPaymentsTab: "Payments", adminPaymentSettingsTab: "Payment settings", adminPremiumEnabledLabel: "Premium system enabled", adminStreamingPremiumLabel: "Streaming Premium-only",
      adminPlansTab: "Plans", adminNoPlans: "No plans",
      moviePlanAssignment: "Assign to plans", moviePlanHint: "Choose which plans unlock this movie. Empty = all plans",
      adminPlanPrice: "Price: {price}", adminPlanDuration: "Duration: {days} days", adminPlanMovies: "movies", adminPlanAllMovies: "All premium movies",
      confirmDeletePlan: "Delete plan \"{name}\"?", adminNoPremiumMovies: "No premium movies",
      searchMovies: "Search movies...", backBtn: "Back",
      planName: "Plan name", planNamePlaceholder: "e.g. Basic, Pro, VIP", planPrice: "Price", planDuration: "Duration", planActive: "Active",
      planFieldsRequired: "Please fill all fields", planNewTitle: "New plan", planEditTitle: "Edit plan",
      paymentViewCheck: "View receipt", paymentApprove: "Approve", paymentReject: "Reject",
      paymentApprovedToast: "Payment approved, Premium activated", paymentRejectedToast: "Payment rejected",
      paymentDetailTitle: "Payment details", paymentUser: "User", paymentAmount: "Amount",
      paymentStatus: "Status", paymentDate: "Date", paymentNoCheck: "No receipt image found", paymentDownloadCheck: "Download receipt",
      paymentSettingsCardNumber: "Card number", paymentSettingsCardHolder: "Card holder",
      paymentSettingsCardInvalid: "Invalid card number", paymentSettingsHolderRequired: "Card holder name is required",
      paymentSettingsUpdatedAt: "Last updated",
    },
    ru: {
      navHome: "Главная", navCatalog: "Каталог", navSearch: "Поиск",
      navFavorites: "Избранное", navProfile: "Профиль",
      trendingTitle: "В тренде", newTitle: "Новинки",
      byGenre: "По жанрам", seeAll: "Все",
      continueTitle: "Продолжить просмотр", resumeBtn: "Продолжить",
      catalogTitle: "Каталог", allMovies: "Все фильмы",
      searchPlaceholder: "Введите название...", popularSearches: "Популярные запросы",
      searchResults: "Результаты", searchEmpty: "Ничего не найдено",
      searchType: "Введите что-нибудь, чтобы начать поиск",
      watchNow: "Смотреть", watchInBot: "Смотреть в боте", sendingVideo: "Отправка...", videoSentToast: "🎬 Видео отправлено в чат с ботом!",
      addToFav: "В избранное", inFav: "В избранном",
      addToFavPlayer: "В избранное", similarTitle: "Похожие фильмы",
      favoritesTitle: "Избранное", favEmpty: "Список избранного пуст", browseMovies: "Смотреть фильмы",
      historyTitle: "История", histEmpty: "История пока пуста",
      profileTitle: "Профиль", favoritesMenu: "Избранное", historyMenu: "История просмотров",
      settingsMenu: "Настройки", adminMenu: "Админ панель", contactMenu: "Связаться с нами", contactHint: "Если у вас есть вопрос или предложение, напишите ниже. Сообщение будет отправлено администратору.", contactPlaceholder: "Введите сообщение...", contactSend: "Отправить", contactEmpty: "Текст сообщения не может быть пустым", contactSent: "Сообщение отправлено!",
      logoutMenu: "Выйти",
      settingsTitle: "Настройки", languageSection: "Язык", themeSection: "Тема",
      themeDark: "Тёмная", themeLight: "Светлая", themeSystem: "Автоматическая", aboutApp: "О приложении",
      adminTitle: "Админ панель", adminFilmsTab: "Фильмы", adminChannelsTab: "Каналы",
      adminUsersTab: "Пользователи", adminStatsTab: "Статистика", addFilm: "Добавить фильм",
      adminStorageTab: "Видео канала",
      adminStorageHint: "Видео, автоматически сохранённые в канал-хранилище через Telegram MTProto (bot.js).",
      adminStorageEmpty: "Пока нет сохранённых видео.",
      adminStoragePlay: "Смотреть", adminStorageDisabled: "Эта функция не настроена в .env (TELEGRAM_API_ID/HASH/STORAGE_CHANNEL_ID).",
      adminKeyPrompt: "Введите ключ администратора",
      adminKeyPlaceholder: "Ключ администратора",
      adminConnect: "Войти",
      adminKeyInvalid: "Неверный ключ или нет доступа",
      adminPassword: "Сменить пароль",
      adminPasswordCurrent: "Текущий пароль",
      adminPasswordNew: "Новый пароль (мин. 8 символов)",
      adminPasswordConfirm: "Повторите новый пароль",
      adminPasswordMismatch: "Пароли не совпадают",
      adminPasswordChanged: "Пароль изменён",
      adminPasswordSaved: "Новый пароль теперь используется для входа",
      pwStrengthVeryWeak: "Очень слабый",
      pwStrengthWeak: "Слабый",
      pwStrengthFair: "Средний",
      pwStrengthGood: "Хороший",
      pwStrengthStrong: "Сильный",
      pwMatch: "Пароли совпадают",
      pwMismatch: "Пароли не совпадают",
      adminNoData: "Нет данных",
      adminStatusAll: "Все", adminStatusActive: "Активные", adminStatusInactive: "Неактивные", adminStatusHidden: "Скрытые",
      adminFilmFeatured: "Рекомендуемое",
      adminGenreActive: "Активен", adminGenreInactive: "Скрыт",
      adminGenreDeactivate: "Скрыть", adminGenreActivate: "Активировать",
      confirmDeactivateGenre: "Скрыть жанр \"{name}\"?", confirmActivateGenre: "Реактивировать жанр \"{name}\"?",
      filterTitle: "Фильтр и сортировка", filterGenres: "Жанры",
      filterYear: "Год", filterRating: "Рейтинг", filterClear: "Очистить", filterApply: "Применить",
      infoTitle: "О KinoBot", infoDesc: "KinoBot — бот, который приносит вам лучшие фильмы.",
      privacyPolicy: "Политика конфиденциальности",
      playerNoSource: "Видео для этого фильма пока недоступно.\nОно будет добавлено скоро.",
      playerError: "Не удалось загрузить видео. Попробуйте позже.",
      genreCount: "{n} фильмов", filmCount: "{n} фильмов",
      confirmTitle: "Подтверждение", confirmDeleteFilm: "Удалить этот фильм?",
      confirmDeleteGenre: 'Удалить жанр "{name}"?',
      cancelBtn: "Отмена", deleteBtn: "Удалить", saveBtn: "Сохранить",
      savingBtn: "Сохранение...", uploadingBtn: "Загрузка изображения",
      toastFavAdded: "Добавлено в избранное", toastFavRemoved: "Удалено из избранного",
      toastError: "Произошла ошибка. Попробуйте ещё раз.",
      toastSaved: "Сохранено", toastDeleted: "Удалено",
      movieFormTitle: "Данные фильма", movieFormTitleNew: "Добавить новый фильм", movieFormTitleEdit: "Редактировать фильм",
      movieTitle: "Название", movieTitlePlaceholder: "Введите название фильма", movieOriginalTitle: "Оригинальное название", movieOriginalTitlePlaceholder: "Введите оригинальное название", movieYearPlaceholder: "Напр. 2024", movieRatingPlaceholder: "Напр. 5",
      movieYear: "Год", movieRating: "Рейтинг (0–10)", movieGenres: "Жанры (через запятую)",
      movieDuration: "Длительность", movieDescription: "Описание", movieDescriptionPlaceholder: "Краткое описание...",
      moviePosterUrl: "URL постера (необязательно)", moviePosterUpload: "Загрузить постер", posterUploadHint: "Выберите изображение (JPG/PNG/WebP/GIF, до 2 МБ)",
      posterDeleteBtn: "Удалить постер", posterAutoExtracted: "Постер автоматически извлечён из видео",
      movieFormSectionInfo: "Основная информация", movieFormSectionMedia: "Медиа (Постер)", movieFormSectionDescription: "Описание", movieFormSectionAdvanced: "Дополнительные настройки",
      adminBannerBtn: "Баннер", bannerModalTitle: "Баннер главной страницы",
      bannerType: "Тип баннера", bannerTypeMovie: "Фильм (рекомендовать выбранный фильм)", bannerTypeAd: "Реклама",
      bannerMoviePick: "Выберите фильм", bannerTitle: "Заголовок", bannerText: "Текст", bannerLink: "Ссылка (URL)",
      bannerImage: "Изображение (необязательно)", bannerImageRemove: "Удалить изображение", bannerActive: "Баннер активен",
      bannerRemove: "Удалить баннер", bannerEmpty: "Баннер не установлен. Выберите рекламу или фильм.",
      bannerMovieBadge: "Рекомендуемый фильм", bannerAdBadge: "Реклама", bannerGo: "Перейти по ссылке", bannerMoreInfo: "Подробнее",
      movieStatus: "Статус", movieStatusActive: "Активен", movieStatusInactive: "Неактивен", movieStatusHidden: "Скрыт",
      movieFeatured: "Рекомендуемое (на главной)", movieIsPremium: "Премиум фильм (только для Премиум пользователей)", movieTrending: "Добавить в тренды", movieTrendingOrder: "Порядок в трендах", movieTrendingBanner: "Баннер тренда (URL)",
      edit: "Изменить", delete: "Удалить", adminStatsMovies: "Фильмы", adminStatsUsers: "Пользователи",
      adminStatsGenres: "Жанры", adminStatsFavs: "Избранное", adminStatsHistory: "Записей истории",
      adminStatsActiveUsers: "Активные", adminStatsBlockedUsers: "Заблокированные",
      adminStatsNewUsers: "Новые пользователи", adminStatsPeriod: "Период", adminStatsPeriod7d: "7 дней",
      adminStatsPeriod30d: "30 дней", adminStatsPeriodAll: "Всё время", adminStatsMostWatched: "Топ просмотров",
      adminStatsDailyActivity: "Активность", adminStatsEvents: "События", adminStatsPlays: "{n} раз",
      eventUserRegistered: "Новые пользователи", eventUserOpenedApp: "Открытий приложения",
      eventMovieOpened: "Открытий фильмов", eventPlaybackStarted: "Запущенных просмотров",
      eventPlaybackCompleted: "Завершённых просмотров", eventPlaybackFailed: "Ошибок воспроизведения",
      eventFavoriteAdded: "Добавлено в избранное", eventFavoriteRemoved: "Удалено из избранного",
      eventHistoryUpdated: "Обновлений истории",
      addGenre: "Добавить жанр", genrePlaceholder: "Название нового жанра", addBtn: "Добавить",
      adminChannelsHint: "Пользователи должны подписаться на добавленные здесь каналы.",
      adminChannelChatIdPlaceholder: "@username канала или -100xxxxxxxxxx",
      adminChannelTitlePlaceholder: "Название канала",
      adminChannelLinkPlaceholder: "Ссылка на канал (необязательно)",
      adminChannelChatIdRequired: "Введите ID/username канала",
      adminChannelLinkRequiredPrivate: "Для приватного канала (-100...) укажите и ссылку-приглашение, иначе пользователи не смогут присоединиться",
      confirmDeleteChannel: "Удалить этот канал из списка?",
      subscribeTitle: "Подпишитесь",
      subscribeMessage: "Подпишитесь на каналы ниже, чтобы пользоваться приложением",
      subscribeJoinBtn: "Подписаться",
      subscribeCheckBtn: "Проверить",
      subscribeStillMissing: "Вы ещё не подписались на все каналы",
      usersEmpty: "Пока нет пользователей",
      name: "Имя", username: "Логин", registered: "Зарегистрирован", historyFull: "Просмотрено полностью",
      historyPct: "{n}% просмотрено", logoutConfirm: "Выйти из Telegram?", connected: "Подключено",
      errorLoad: "Не удалось загрузить данные",
      blockedTitle: "Ваш аккаунт заблокирован",
      blockedDesc: "Администратор временно заблокировал ваш аккаунт. Пожалуйста, попробуйте позже или обратитесь к администратору за помощью.",
      block: "Заблокировать", unblock: "Разблокировать",
      makeAdmin: "Сделать админом", removeAdmin: "Убрать из админов",
      userDetailTitle: "Данные пользователя", userStats: "Статистика",
      favCount: "Избранное", histCount: "Записей истории", completedCount: "Просмотрено полностью",
      watchTime: "Время просмотра", lastSeen: "Последний вход",
      searchUsers: "Поиск...", allUsers: "Все", activeUsers: "Активные", blockedUsers: "Заблокированные",
      userStatus: "Статус", userStatusActive: "Активен", userStatusBlocked: "Заблокирован",
      noUsers: "Пока нет пользователей",
      adminAuditTab: "Журнал аудита", adminContactTab: "Сообщения", adminPremiumTab: "Премиум", contactMarkRead: "Прочитано", contactBlockUser: "Заблокировать от сообщений", contactUserBlockedToast: "Пользователь заблокирован от формы связи", auditTitle: "Журнал аудита", auditAdminId: "ID админа",
      auditAction: "Действие", auditEntity: "Объект", auditTime: "Время", backBtn: "Назад",
      closeBtn: "Закрыть", userBlockedToast: "Пользователь заблокирован", userUnblockedToast: "Пользователь разблокирован",
      adminRoleUpdatedToast: "Роль админа обновлена",
      offlineToast: "Нет интернет-соединения. Данные не обновляются.",
      onlineToast: "Интернет-соединение восстановлено. Обновление данных...",
      loadMoreBtn: "Загрузить еще",
      loading: "Загрузка...",
      videoManageTitle: "Видео источники",
      videoUploadBtn: "Загрузить",
      videoNotUploaded: "Не загружено",
      videoDeleteConfirm: "Удалить видео {quality}?",
      videoUploading: "Загрузка...",
      videoLegacyNote: "Также есть устаревший URL-источник (прямая ссылка)",
      videoStorageR2: "Облако R2",
      videoStorageLocal: "Сервер Kali",
      videoStorageSel: "Хранилище:",
      videoHint: "R2 хранит видео в облаке, сервер Kali — на вашем компьютере. После загрузки выбор качества появится на странице фильма.",
      studioTitleNew: "Студия нового фильма", studioTitleEdit: "Редактировать фильм",
      studioSaveDraft: "Сохранить черновик", studioPublish: "Сохранить и опубликовать",
      studioPublishEdit: "Сохранить изменения", studioSaving: "Сохранение...",
      studioStepInfo: "Основное", studioStepMedia: "Медиа", studioStepVideo: "Видео",
      studioStepExtra: "Доп.", studioStepNote: "Шаг {n}/4",
      studioPosterOr: "или", studioPosterAuto: "Авто из видео",
      studioNoMovie: "Сначала сохраните фильм", studioNeedTitle: "Название и год обязательны",
      studioVideoAfterSave: "Сохраните фильм для загрузки видео", studioMovieCreatedNowUploadVideo: "Фильм создан! Теперь загрузите видео.",
      studioUploadedOk: "Видео загружено", studioSectionPoster: "Постер",
      studioSectionVideo: "Видеоисточники",
      // Premium и оплата
      premiumMenu: "Премиум", premiumMenuActive: "Премиум активен",
      premiumTitle: "Премиум", premiumChoosePlan: "Выберите пакет",
      premiumPlan1Month: "1 месяц", premiumPlan3Months: "3 месяца", premiumPlan1Year: "1 год",
      premiumPaymentDetails: "Реквизиты для оплаты", premiumNoCardSettings: "Реквизиты карты ещё не заданы",
      premiumUploadCheck: "Загрузите чек оплаты", premiumCheckHint: "Выберите изображение чека (JPG/PNG, до 3МБ)",
      premiumSubmitBtn: "Отправить оплату", premiumSubmitting: "Отправка...",
      premiumPendingHint: "После отправки администратор проверит и активирует Премиум.",
      premiumSelectPlanFirst: "Сначала выберите пакет", premiumCheckRequired: "Загрузите изображение чека",
      premiumCheckTooLarge: "Изображение слишком большое (макс. 3МБ)", premiumSubmittedToast: "Оплата отправлена! Ожидайте подтверждения администратора.",
      premiumActiveTitle: "Премиум активен", premiumActivePlan: "Пакет", premiumActiveExpires: "Истекает",
      premiumExpiredToast: "Срок действия Премиум истёк", premiumRequiredToast: "Этот фильм доступен только для Премиум пользователей",
      premiumHistoryTitle: "История платежей", unlockWithPremium: "Открыть с Премиум",
      paymentStatusPending: "Ожидает", paymentStatusApproved: "Подтверждено", paymentStatusRejected: "Отклонено",
      adminPaymentsTab: "Платежи", adminPaymentSettingsTab: "Настройки оплаты", adminPremiumEnabledLabel: "Премиум-система включена", adminStreamingPremiumLabel: "Стрим только для Премиум",
      adminPlansTab: "Пакеты", adminNoPlans: "Пакетов нет",
      moviePlanAssignment: "Назначить пакетам", moviePlanHint: "Выберите, какие пакеты открывают этот фильм. Пусто = все пакеты",
      adminPlanPrice: "Цена: {price}", adminPlanDuration: "Срок: {days} дн.", adminPlanMovies: "фильмов", adminPlanAllMovies: "Все премиум фильмы",
      confirmDeletePlan: "Удалить пакет \"{name}\"?", adminNoPremiumMovies: "Нет премиум фильмов",
      searchMovies: "Поиск фильмов...", backBtn: "Назад",
      planName: "Название пакета", planNamePlaceholder: "Напр.: Basic, Pro, VIP", planPrice: "Цена", planDuration: "Срок", planActive: "Активен",
      planFieldsRequired: "Заполните все поля", planNewTitle: "Новый пакет", planEditTitle: "Редактировать пакет",
      paymentViewCheck: "Смотреть чек", paymentApprove: "Подтвердить", paymentReject: "Отклонить",
      paymentApprovedToast: "Оплата подтверждена, Премиум активирован", paymentRejectedToast: "Оплата отклонена",
      paymentDetailTitle: "Детали платежа", paymentUser: "Пользователь", paymentAmount: "Сумма",
      paymentStatus: "Статус", paymentDate: "Дата", paymentNoCheck: "Изображение чека не найдено", paymentDownloadCheck: "Скачать чек",
      paymentSettingsCardNumber: "Номер карты", paymentSettingsCardHolder: "Владелец карты",
      paymentSettingsCardInvalid: "Неверный номер карты", paymentSettingsHolderRequired: "Требуется имя владельца карты",
      paymentSettingsUpdatedAt: "Последнее обновление",
    },
  };

  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace("{" + k + "}", v);
    return s;
  }

  // Tarjima elementlariga qo'llash (statik matnlar)
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPh);
    });
    if (lang === "uz") document.documentElement.lang = "uz";
    else if (lang === "ru") document.documentElement.lang = "ru";
    else document.documentElement.lang = "en";
    // Sozlamalardagi faol holatlarni yangilash
    document.querySelectorAll("#langRow .chip-select").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === lang);
    });
    document.querySelectorAll("#themeRow .chip-select").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeSet === themePref);
    });
  }

  // ===================== THEME =====================
  function currentDark() {
    if (themePref === "dark") return true;
    if (themePref === "light") return false;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? false : true;
  }

  function applyTheme() {
    const dark = currentDark();
    if (dark) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    if (tg) {
      try {
        tg.setHeaderColor(dark ? "#0a0a0f" : "#f6f6fa");
        tg.setBackgroundColor(dark ? "#0a0a0f" : "#f6f6fa");
      } catch (e) {}
    }
    document.querySelectorAll("#themeRow .chip-select").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeSet === themePref);
    });
  }

  function setThemePref(p) {
    themePref = p;
    try { localStorage.setItem("kb_theme", p); } catch (e) {}
    applyTheme();
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  // ===================== SVG ICONS =====================
  const ICONS = {
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    ghost: '<path d="M12 2a8 8 0 0 0-8 8v10l2-2 2 2 2-2 2 2 2-2 2 2 2-2V10a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    gem: '<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    arrow: '<polyline points="9 18 15 12 9 6"/>',
    back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    filmStrip: '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    chevronRight: '<polyline points="9 18 15 12 9 6"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    megaphone: '<path d="M4.5 15.5h3.5a2 2 0 0 0 0-4h-3.5v4z"/><path d="M10 6a7 7 0 0 1 7 7v4a7 7 0 0 1-7 7H6v-18h4z"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  };
  function icon(name, size, filled) {
    const p = ICONS[name];
    if (!p) return "";
    const fillAttr = filled ? ' fill="currentColor" stroke="none"' : ' fill="none"';
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24"${fillAttr} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  }

  // ===================== HELPERS =====================
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function gClass(m) { return (m && m.poster) || "g0"; }
  function findMovie(id) {
    return state.movies.find((m) => m.id === id) || null;
  }

  // Progress saqlangandan so'ng state.history'ni joyida yangilaymiz —
  // "Davom etish" qatori yoki tarix sahifasi qayta yuklanmasdan yangi turadi.
  function upsertLocalHistory(movieId, pct, pos) {
    const m = findMovie(movieId);
    if (!m) return;
    const now = new Date().toISOString();
    const existing = state.history.find((h) => h.movieId === movieId);
    if (existing) {
      existing.progressPct = pct;
      existing.positionSeconds = pos;
      existing.lastWatchedAt = now;
    } else {
      state.history.push({ movieId, progressPct: pct, positionSeconds: pos, lastWatchedAt: now, movie: m });
    }
    // Bosh sahifa ko'rinayotgan bo'lsa "Davom etish" qatorini joyida yangilaymiz
    const home = document.getElementById("screen-home");
    if (home && home.classList.contains("active")) {
      renderContinueWatching();
    }
  }
  function genreCount(name) {
    return state.movies.filter((m) => m.genres.includes(name)).length;
  }
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : lang === "en" ? "en-GB" : "uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch (e) { return ""; }
  }
  // Audit log / lastSeenAt uchun qisqa sana + vaqt (kun, oy, soat, daqiqa).
  function fmtDateTime(iso) {
    try {
      const d = new Date(iso);
      const loc = lang === "ru" ? "ru-RU" : lang === "en" ? "en-GB" : "uz-UZ";
      return d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit", year: "numeric" }) +
        " " + d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }
  // Ko'rilgan vaqt (soniya) -> o'qiladigan format (masalan "1 soat 5 daq").
  function fmtWatchTime(sec) {
    sec = Number(sec) || 0;
    if (sec <= 0) return "0";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + (lang === "ru" ? " soat " : lang === "en" ? "h " : " soat ") + m + (lang === "ru" ? " daq" : lang === "en" ? "m" : " daq");
    return m + (lang === "ru" ? " daq" : lang === "en" ? " min" : " daq");
  }

  // Poster: posterUrl mavjud bo'lsa rasm, aks holda gradient fallback
  function posterImg(m, overrideUrl) {
    const url = overrideUrl || m.posterUrl;
    if (url) {
      return `<div class="poster-img" style="background-image:url('${esc(url)}');background-size:cover;background-position:center"><span class="poster-overlay"></span></div>`;
    }
    return `<div class="poster-img ${gClass(m)}"><span class="poster-letter">${esc(m.title.charAt(0))}</span><span class="poster-overlay"></span></div>`;
  }

  // ===================== RENDER HELPERS =====================
  function posterCard(m, i, overrideImgUrl) {
    const delay = Math.min(i * 50, 200);
    const isFav = state.favorites.has(m.id);
    return `
    <div class="poster-card anim-in" style="animation-delay:${delay}ms" data-open="detail" data-id="${esc(m.id)}">
      ${posterImg(m, overrideImgUrl)}
      <span class="rating-badge">${icon("star", 10)} ${m.rating}</span>
      <span class="fav-chip ${isFav ? "on" : ""}">${icon("heart", 13, isFav)}</span>
      <div class="poster-name">${esc(m.title)}</div>
      <div class="poster-sub">${m.year}${m.originalTitle ? " · " + esc(m.originalTitle) : ""}</div>
    </div>`;
  }

  function listCard(m) {
    const fav = state.favorites.has(m.id);
    return `
    <div class="list-card" data-open="detail" data-id="${esc(m.id)}">
      <div class="thumb ${gClass(m)}">
        ${m.posterUrl ? `<img src="${esc(m.posterUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">` : `<span class="thumb-letter">${esc(m.title.charAt(0))}</span>`}
        <span class="play-mini">${icon("play", 12, true)}</span>
      </div>
      <div class="info">
        <div class="t">${esc(m.title)}</div>
        <div class="m">${m.year} • ${esc(m.genres.slice(0, 2).join(", "))}</div>
        <div class="rating">${icon("star", 11)} ${m.rating}</div>
      </div>
      <div class="side-actions">
        <button class="heart-btn ${fav ? "filled" : ""}" data-fav="${esc(m.id)}" aria-label="fav">${icon("heart", 18, fav)}</button>
      </div>
    </div>`;
  }

  function historyCard(h) {
    const m = h.movie;
    if (!m) return "";
    const progressText = h.progressPct >= 100
      ? t("historyFull")
      : t("historyPct", { n: h.progressPct });
    return `
    <div class="list-card" data-open="detail" data-id="${esc(m.id)}">
      <div class="thumb ${gClass(m)}">
        ${m.posterUrl ? `<img src="${esc(m.posterUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">` : `<span class="thumb-letter">${esc(m.title.charAt(0))}</span>`}
        <span class="play-mini">${icon("play", 12, true)}</span>
      </div>
      <div class="info">
        <div class="t">${esc(m.title)}</div>
        <div class="m">${fmtDate(h.watchedAt)} • ${progressText}</div>
        <div class="progress-mini"><i style="width:${Math.max(0, Math.min(100, h.progressPct))}%"></i></div>
      </div>
    </div>`;
  }

  // Continue Watching kartasi — o'yinchiga to'g'ridan-to'g'ri davom etadi.
  function continueCard(h) {
    const m = h.movie;
    if (!m) return "";
    const pct = Math.max(0, Math.min(100, h.progressPct || 0));
    const bg = m.posterUrl
      ? `background-image:url('${esc(m.posterUrl)}');background-size:cover;background-position:center`
      : "";
    return `
    <div class="continue-card" data-open="player" data-id="${esc(m.id)}">
      <div class="poster-img ${gClass(m)}" style="${bg}">
        ${m.posterUrl ? "" : `<span class="poster-letter">${esc(m.title.charAt(0))}</span>`}
        <span class="poster-overlay"></span>
        <span class="continue-resume">${icon("play", 16, true)} ${t("resumeBtn")}</span>
      </div>
      <div class="poster-name">${esc(m.title)}</div>
      <div class="continue-progress"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  // Bosh sahifadagi "Davom etish" qatori — progress 1..94% bo'lgan filmlar.
  function renderContinueWatching() {
    const wrap = document.getElementById("continueRowWrap");
    const row = document.getElementById("continueRow");
    if (!wrap || !row) return;
    const cw = state.history
      .filter((h) => h.movie && h.progressPct > 0 && h.progressPct < 95)
      .sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt))
      .slice(0, 10);
    wrap.hidden = !cw.length;
    row.innerHTML = cw.map(continueCard).join("");
  }

  function genreTile(g, i) {
    const count = genreCount(g);
    const grads = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7"];
    const cls = grads[i % grads.length];
    return `<div class="genre-tile ${cls}" data-genre="${esc(g)}">
      <div class="gt-ic">${icon("film", 21)}</div>
      <div class="gt-info">
        <div class="gt-name">${esc(g)}</div>
        <div class="gt-count">${t("genreCount", { n: count })}</div>
      </div>
    </div>`;
  }

  // ===================== TOAST =====================
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      el.hidden = true;
    }, 2200);
  }

  // ===================== MODAL =====================
  let modalCloseHandler = null;
  function openModal(html) {
    const overlay = document.getElementById("modalOverlay");
    overlay.innerHTML = html;
    overlay.hidden = false;
    overlay.classList.add("show");
  }
  function closeModal() {
    const overlay = document.getElementById("modalOverlay");
    overlay.hidden = true;
    overlay.classList.remove("show");
    overlay.innerHTML = "";
    modalCloseHandler = null;
  }
  function modalShell(title, bodyHtml, { footer = true, onCancel } = {}) {
    modalCloseHandler = onCancel || closeModal;
    return `
      <div class="modal-card">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" data-modal-close aria-label="close">${icon("back", 18)}</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footer ? `<div class="modal-footer" data-modal-footer></div>` : ""}
      </div>`;
  }

  // ===================== FULL-SCREEN MODAL (video/movie forms) =====================
  // Skrinshotdagi kabi: orqaga strelka + markazlashgan sarlavha, pastda
  // yopishqoq (sticky) ikkita tugmali footer. Faqat vizual qobiq — mavjud
  // modalOverlay bilan bir vaqtda ishlamaydi, shuning uchun alohida
  // #fsModalOverlay konteyneridan foydalanadi.
  function openFsModal(html) {
    const el = document.getElementById("fsModalOverlay");
    if (!el) return;
    el.innerHTML = html;
    el.classList.add("show");
  }
  function closeFsModal() {
    const el = document.getElementById("fsModalOverlay");
    if (!el) return;
    el.classList.remove("show");
    el.innerHTML = "";
  }
  function fsModalShell(title, bodyHtml, footerHtml) {
    return `
      <div class="modal-fs-header">
        <button class="icon-btn" data-fsmodal-close aria-label="back">${icon("back", 20)}</button>
        <h3>${esc(title)}</h3>
        <span class="icon-btn" style="visibility:hidden" aria-hidden="true"></span>
      </div>
      <div class="modal-fs-body">${bodyHtml}</div>
      <div class="modal-fs-footer">${footerHtml}</div>`;
  }

  // ===================== "BIZ BILAN BOG'LANISH" =====================
  function showContactModal() {
    const body = `
      <p class="contact-modal-hint">${t("contactHint")}</p>
      <textarea id="contactText" rows="5" maxlength="2000" placeholder="${esc(t("contactPlaceholder"))}"></textarea>`;
    const footer = `
      <button class="btn-secondary" data-modal-close>${t("cancelBtn")}</button>
      <button class="btn-primary" id="contactSendBtn">${icon("link", 15)}${t("contactSend")}</button>`;
    openModal(modalShell(t("contactMenu"), body, { footer: false }) +
      `<div class="modal-footer">${footer}</div>`);

    document.getElementById("contactSendBtn").addEventListener("click", async () => {
      const textEl = document.getElementById("contactText");
      const text = textEl.value.trim();
      if (!text) { toast(t("contactEmpty")); return; }
      const btn = document.getElementById("contactSendBtn");
      btn.disabled = true;
      const res = await KinoBotApi.sendContactMessage(text);
      btn.disabled = false;
      if (!res.ok) {
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
        return;
      }
      closeModal();
      toast(t("contactSent"));
    });
  }

  // ===================== DATA LOADING =====================
  async function loadData() {
    // Offline rejimda ma'lumotlarni yuklab bo'lmaydi
    if (!navigator.onLine) {
      toast(t("offlineToast") || "Internet ulanishi yo'q. Ma'lumotlar yangilanmaydi.");
      return;
    }

    const results = await Promise.all([
      KinoBotApi.getMovies(),
      KinoBotApi.getGenres(),
      KinoBotApi.getFavorites().catch(() => null),
      KinoBotApi.getHistory().catch(() => null),
      KinoBotApi.getProfile().catch(() => null),
      KinoBotApi.getBanner().catch(() => null),
      KinoBotApi.getPremiumEnabled().catch(() => null),
      KinoBotApi.getPremiumStatus().catch(() => null),
      KinoBotApi.getPremiumPlans().catch(() => null),
    ]);

    const [moviesRes, genresRes, favsRes, histRes, profRes, bannerRes, premiumEnabledRes, premiumRes, plansRes] = results;

    if (moviesRes && moviesRes.ok) state.movies = moviesRes.data.movies || [];
    else toast(t("errorLoad"));
    if (genresRes && genresRes.ok) state.genres = genresRes.data.genres || [];
    if (favsRes && favsRes.ok) state.favorites = new Set((favsRes.data.movies || []).map((m) => m.id));
    if (histRes && histRes.ok) state.history = histRes.data.history || [];
    if (profRes && profRes.ok) state.profile = profRes.data.user || null;
    if (bannerRes && bannerRes.ok) state.banner = bannerRes.data.banner || null;
    // Endpoint ishlamasa (eski backend, tarmoq xatosi) — standart holat
    // YOQILGAN deb hisoblanadi, aks holda tarmoq xatosi Premium bo'limini
    // asossiz yashirib qo'yardi.
    state.premiumEnabled = premiumEnabledRes && premiumEnabledRes.ok ? premiumEnabledRes.data.enabled !== false : true;
    state.streamingPremiumOnly = premiumEnabledRes && premiumEnabledRes.ok ? !!premiumEnabledRes.data.streamingPremiumOnly : false;
    if (premiumRes && premiumRes.ok) state.premium = premiumRes.data.premium || null;
    if (plansRes && plansRes.ok) state.planList = plansRes.data.plans || [];
  }

  // ===================== SCREEN RENDERS =====================

  // Bosh sahifa banneri — admin o'rnatgan reklama (ad) yoki tanlangan film (movie).
  function renderBanner() {
    const wrap = document.getElementById("homeBanner");
    if (!wrap) return;
    const b = state.banner;
    if (!b) { wrap.hidden = true; wrap.innerHTML = ""; return; }

    if (b.type === "movie" && b.movie) {
      const m = b.movie;
      const bg = m.posterUrl
        ? `background-image:url('${esc(m.posterUrl)}');background-size:cover;background-position:center`
        : `background:linear-gradient(135deg,#241a3d,#0e0b16)`;
      wrap.innerHTML = `
      <div class="home-banner home-banner-movie" data-open="detail" data-id="${esc(m.id)}" style="${bg}">
        <div class="home-banner-bg"></div>
        <div class="home-banner-veil"></div>
        <div class="home-banner-badge">${icon("star", 12)} ${t("bannerMovieBadge")}</div>
        <div class="home-banner-title">${esc(m.title)}</div>
        <div class="home-banner-sub">${m.year}${m.originalTitle ? " · " + esc(m.originalTitle) : ""}${m.rating != null ? " · " + icon("star", 11) + " " + m.rating : ""}</div>
        <button class="btn-primary btn-sm">${icon("play", 13, true)} ${t("watchNow")}</button>
      </div>`;
    } else if (b.type === "ad") {
      const img = b.imageUrl
        ? `<div class="home-banner-bg" style="background-image:url('${esc(b.imageUrl)}');background-size:cover;background-position:center"></div>`
        : "";
      // "Reklama" yorlig'i va "Batafsil" tugmasi ko'rsatilmaydi — rasmning
      // o'zi asosiy element. Bannerga bosilganda modal avvalgidek ochiladi.
      // Matn (sarlavha/tavsif) bo'lmasa qoraytiruvchi veil ham qo'yilmaydi,
      // shunda rasm to'liq va toza ko'rinadi.
      const hasCaption = !!(b.title || b.text);
      wrap.innerHTML = `
      <div class="home-banner home-banner-ad${hasCaption ? "" : " home-banner-ad-plain"}" data-banner-info tabindex="0" role="button" aria-label="${esc(b.title || t("bannerAdBadge"))}">
        ${img}
        ${hasCaption ? `<div class="home-banner-veil"></div>` : ""}
        ${b.title ? `<div class="home-banner-title">${esc(b.title)}</div>` : ""}
        ${b.text ? `<div class="home-banner-text">${esc(b.text)}</div>` : ""}
      </div>`;
    } else {
      wrap.hidden = true; wrap.innerHTML = ""; return;
    }
    wrap.hidden = false;
  }

  // Reklama banneriga bosilganda to'liq matn/rasm/havolani modalda ko'rsatadi.
  function showBannerInfoModal() {
    const b = state.banner;
    if (!b || b.type !== "ad") return;
    const img = b.imageUrl ? `<div class="banner-info-img" style="background-image:url('${esc(b.imageUrl)}')"></div>` : "";
    const linkBtn = b.link
      ? `<button class="btn-primary full" data-banner-link="${esc(b.link)}">${icon("link", 13)} ${t("bannerGo")}</button>`
      : "";
    const body = `
      ${img}
      ${b.text ? `<p class="banner-info-text">${esc(b.text)}</p>` : ""}
      ${linkBtn}`;
    openModal(modalShell(b.title || t("bannerAdBadge"), body, { footer: false }));
  }

  function renderHome() {
    const trending = document.getElementById("trendingRow");
    const newRow = document.getElementById("newRow");

    renderBanner();

    if (!state.movies.length) {
      trending.innerHTML = skelPoster(4);
      newRow.innerHTML = skelPoster(8);
      return;
    }
    renderContinueWatching();
    const byRating = state.movies.slice().sort((a, b) => b.rating - a.rating);
    const byNew = state.movies.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Trenddagi filmlar — admin qo'lda belgilagan (trending=true) filmlar,
    // trendingOrder bo'yicha saralanadi. Hech qaysi belgilanmagan bo'lsa,
    // reyting bo'yicha avtomatik tanlanadi (fallback).
    const manualTrending = state.movies
      .filter((m) => m.trending)
      .sort((a, b) => (a.trendingOrder || 0) - (b.trendingOrder || 0));
    const trendingList = manualTrending.length ? manualTrending : byRating.slice(0, 4);

    trending.innerHTML = trendingList.slice(0, 10).map((m, i) => posterCard(m, i, m.trendingBannerUrl)).join("");
    newRow.innerHTML = byNew.slice(0, 8).map((m, i) => posterCard(m, i)).join("");
  }

  // Catalog — backend orqali (genre / filter parametrlari bilan)
  async function renderCatalog(opts) {
    state.catalogOpts = opts || {};
    const { genre, filter } = state.catalogOpts;
    const listEl = document.getElementById("catalogList");
    const genreGrid = document.getElementById("genreGrid");
    const titleEl = document.getElementById("catalogResultTitle");

    genreGrid.innerHTML = state.genres.map((g, i) => genreTile(g, i)).join("");

    const params = {};
    if (genre) params.genre = genre;
    if (filter) {
      if (filter.genre) params.genre = filter.genre;
      if (filter.yearMin) params.yearMin = filter.yearMin;
      if (filter.ratingMin) params.ratingMin = filter.ratingMin;
    }

    // Pagination state
    state.catalogPage = 1;
    state.catalogMovies = [];
    state.catalogHasMore = true;

    // Skeletonda boshlang, so'ng backenddan yuklang
    listEl.innerHTML = skelCard(5);
    await loadCatalogPage(params, listEl, titleEl);
  }

  async function loadCatalogPage(params, listEl, titleEl) {
    if (!state.catalogHasMore) return;

    const pageParams = { ...params, page: state.catalogPage, limit: 20 };
    const res = await KinoBotApi.getMovies(pageParams);
    if (res && res.ok) {
      const movies = res.data.movies || [];
      if (state.catalogPage === 1) {
        state.catalogMovies = movies;
      } else {
        state.catalogMovies = state.catalogMovies.concat(movies);
      }

      state.catalogHasMore = movies.length >= 20; // Agar 20 tadan kam bo'lsa, yana yo'q
      state.catalogPage++;

      const activeGenre = params.genre || null;
      const title = activeGenre
        ? `${activeGenre} · ${t("genreCount", { n: state.catalogMovies.length })}`
        : params.filter
          ? `${t("filterTitle")} (${state.catalogMovies.length})`
          : `${t("allMovies")} (${state.catalogMovies.length})`;
      titleEl.textContent = title;
      listEl.innerHTML = state.catalogMovies.map((m) => listCard(m)).join("") ||
        `<p class="search-empty">${t("searchEmpty")}</p>`;
      document.querySelectorAll(".genre-tile").forEach((el) => {
        el.classList.toggle("selected", el.dataset.genre === activeGenre);
      });

      // "Yana yuklash" tugmasini ko'rsatish
      renderLoadMoreButton(listEl);
    } else {
      if (state.catalogPage === 1) {
        listEl.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`;
      }
    }
  }

  function renderLoadMoreButton(listEl) {
    // Eski tugmani o'chirish
    const oldBtn = listEl.parentNode.querySelector(".load-more-container");
    if (oldBtn) oldBtn.remove();

    if (state.catalogHasMore) {
      const container = document.createElement("div");
      container.className = "load-more-container";
      container.style.textAlign = "center";
      container.style.marginTop = "16px";
      container.innerHTML = `
        <button class="btn btn-secondary load-more-btn" style="min-width: 200px;">
          ${icon("download", 16)} ${t("loadMoreBtn") || "Yana yuklash"}
        </button>
      `;
      listEl.parentNode.appendChild(container);

      container.querySelector(".load-more-btn").addEventListener("click", async () => {
        const btn = container.querySelector(".load-more-btn");
        btn.disabled = true;
        btn.innerHTML = `${icon("clock", 16)} ${t("loading") || "Yuklanmoqda..."}`;
        await loadCatalogPage(getCatalogParams(), listEl, document.getElementById("catalogResultTitle"));
        btn.disabled = false;
      });
    }
  }

  function getCatalogParams() {
    const { genre, filter } = state.catalogOpts || {};
    const params = {};
    if (genre) params.genre = genre;
    if (filter) {
      if (filter.genre) params.genre = filter.genre;
      if (filter.yearMin) params.yearMin = filter.yearMin;
      if (filter.ratingMin) params.ratingMin = filter.ratingMin;
    }
    return params;
  }

  function renderSearch(query) {
    const q = (query || "").trim();
    const resultsEl = document.getElementById("searchResults");
    const popularEl = document.getElementById("popularSearches");

    if (!popularEl.innerHTML) {
      const tags = ["Interstellar", "Dune", "Batman", "John Wick", "Spider-Man", "Avengers"];
      popularEl.innerHTML = tags.map((s) => `<div class="tag-chip" data-search="${esc(s)}">${esc(s)}</div>`).join("");
    }

    if (!q) {
      resultsEl.innerHTML = `<p class="search-empty">${t("searchType")}</p>`;
      return;
    }
    // Debounce bosilgan — oldin skeleton, so'ng backend qidiruvi
    resultsEl.innerHTML = skelCard(3);
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(async () => {
      if (state.searchQuery !== q) return; // eski so'rov bekor
      const res = await KinoBotApi.getMovies({ q });
      if (!res || !res.ok) {
        resultsEl.innerHTML = `<p class="search-empty">${t("searchEmpty")}</p>`;
        return;
      }
      const movies = res.data.movies || [];
      resultsEl.innerHTML = movies.map((m) => listCard(m)).join("") ||
        `<p class="search-empty">${t("searchEmpty")}</p>`;
    }, 300);
  }

  function renderFavorites() {
    const favs = state.movies.filter((m) => state.favorites.has(m.id));
    const listEl = document.getElementById("favList");
    const emptyEl = document.getElementById("favEmpty");
    emptyEl.hidden = favs.length > 0;
    listEl.innerHTML = favs.map((m) => listCard(m)).join("") ||
      `<p class="search-empty">${t("favEmpty")}</p>`;
  }

  function renderHistory() {
    const listEl = document.getElementById("historyList");
    const emptyEl = document.getElementById("historyEmpty");
    emptyEl.hidden = state.history.length > 0;
    listEl.innerHTML = state.history.map(historyCard).join("");
  }

  function renderProfile() {
    const p = state.profile;
    const nameEl = document.getElementById("profileName");
    const userEl = document.getElementById("profileUsername");
    const avEl = document.getElementById("profileAvatar");

    // Premium admin panel orqali o'chirilgan bo'lsa, profildagi Premium
    // menyu punkti butunlay ko'rinmaydi.
    const premiumItem = document.getElementById("premiumMenuItem");
    if (premiumItem) premiumItem.hidden = !state.premiumEnabled;

    if (!p) {
      nameEl.textContent = "—";
      userEl.textContent = "";
      avEl.textContent = "?";
      return;
    }
    const full = [p.firstName, p.lastName].filter(Boolean).join(" ") || t("profileTitle");
    nameEl.textContent = full;
    const handle = p.username ? "@" + p.username : "#" + p.id;
    userEl.textContent = handle;
    if (p.photoUrl) {
      avEl.innerHTML = `<img src="${esc(p.photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      avEl.textContent = full.charAt(0).toUpperCase();
    }
  }

  function renderDetail(id) {
    const m = findMovie(id);
    if (!m) return;
    state.currentDetailId = id;
    state.currentDetailMovie = m;

    const hero = document.getElementById("detailHero");
    hero.className = "detail-hero";
    if (m.backdropUrl) {
      hero.style.background = `linear-gradient(to bottom, rgba(10,10,15,0.35), rgba(10,10,15,0.85)), url('${esc(m.backdropUrl)}') center/cover`;
    } else if (m.posterUrl) {
      hero.style.background = `linear-gradient(to bottom, rgba(10,10,15,0.45), rgba(10,10,15,0.9)), url('${esc(m.posterUrl)}') center/cover`;
    } else {
      hero.style.background = "";
      hero.classList.add(gClass(m));
    }

    document.getElementById("detailTitle").textContent = m.title;
    document.getElementById("detailMeta").innerHTML =
      `<span>${m.year}</span> • <span>${esc(m.duration)}</span> • <span class="star">${icon("star", 12)} ${m.rating}</span>` +
      (m.isPremium ? ` • <span class="premium-tag">${icon("star", 11, true)} PREMIUM</span>` : "");
    document.getElementById("detailGenres").innerHTML =
      m.genres.map((g) => `<span class="tag-chip">${esc(g)}</span>`).join("");
    document.getElementById("detailDesc").textContent = m.description || "";

    // Premium film, lekin foydalanuvchida faol Premium yo'q — tugma matni
    // moslashtiriladi, bosilganda esa player o'rniga Premium sahifasi ochiladi.
    const needsPremium = m.isPremium && !(state.premium && state.premium.isActive);
    const watchBtnText = document.getElementById("detailWatchBtnText");
    if (watchBtnText) watchBtnText.textContent = needsPremium ? t("unlockWithPremium") : t("watchInBot");

    const isFav = state.favorites.has(m.id);
    const favBtn = document.getElementById("detailFavBtn");
    favBtn.classList.toggle("active", isFav);
    document.getElementById("detailFavText").textContent = isFav ? t("inFav") : t("addToFav");

    // O'xshash filmlar backenddan
    KinoBotApi.getMovie(id).then((res) => {
      const similarEl = document.getElementById("similarRow");
      if (!res || !res.ok) return;
      const similar = res.data.similar || [];
      similarEl.innerHTML = similar.length
        ? similar.map((x, i) => posterCard(x, i)).join("")
        : `<p class="search-empty">${t("searchEmpty")}</p>`;
    });
  }

  // Film tarixdan qanday pozitsiyadan davom ettirishni hisoblaydi.
  // Faqat qisman ko'rilgan (1..94%) va pozitsiyasi saqlangan filmlar resume bo'ladi.
  function resumeAtFor(movieId) {
    const h = state.history.find((x) => x.movieId === movieId);
    if (!h || !h.positionSeconds) return 0;
    if (h.progressPct <= 0 || h.progressPct >= 95) return 0;
    return Math.floor(h.positionSeconds);
  }

  // Player modulidan kelgan progress callback — backendga yozamiz va
  // mahalliy keshi yangilaymiz ("Davom etish" qatori shu zahoti yangi turadi).
  function savePlayerProgress(movieId, pct, pos) {
    KinoBotApi.recordHistory(movieId, pct, pos).then((res) => {
      if (res.ok) upsertLocalHistory(movieId, pct, pos);
    }).catch(() => {});
  }

  function renderPlayer(id) {
    const m = (id && findMovie(id)) || state.currentDetailMovie || state.movies[0];
    if (!m) return;

    // Premium film — faol Premium bo'lmasa, player ochilmaydi (video
    // manbasi so'ralmaydi ham) va foydalanuvchi Premium sahifasiga
    // yo'naltiriladi. R2/Kali fallback tizimiga bu tegmaydi.
    if (m.isPremium && !(state.premium && state.premium.isActive)) {
      toast(t("premiumRequiredToast"));
      openScreen("premium", { noPush: true });
      return;
    }

    state.currentDetailId = m.id;
    state.currentDetailMovie = m;

    const posterEl = document.getElementById("playerPoster");
    posterEl.className = "player-poster";
    posterEl.hidden = false; // keyingi film yuklanganda poster yana ko'rinadi
    if (m.posterUrl) {
      posterEl.style.background = `url('${esc(m.posterUrl)}') center/cover`;
    } else {
      posterEl.style.background = "";
      posterEl.classList.add(gClass(m));
    }

    document.getElementById("playerTitle").textContent = m.title;
    document.getElementById("playerYear").textContent = `${m.year} · ${esc(m.duration)}`;

    const isFav = state.favorites.has(m.id);
    const favBtn = document.getElementById("playerFavBtn");
    favBtn.classList.toggle("active", isFav);
    document.getElementById("playerFavText").textContent = isFav ? t("inFav") : t("addToFavPlayer");

    // Video element bilan ishlashni player moduliga topshiramiz.
    const videoEl = document.getElementById("playerEl");
    const emptyEl = document.getElementById("playerEmpty");
    emptyEl.hidden = true;
    videoEl.hidden = true;

    const hasSrc = m.videoSources && (
      m.videoSources.url ||
      (Array.isArray(m.videoSources) && m.videoSources.length && m.videoSources[0].url) ||
      (typeof m.videoSources === "object" && ["360p", "480p", "720p", "1080p"].some((q) => m.videoSources[q]))
    );

    // O'yinchi ochilgani — haqiqiy tarix hodisasi. Faqat ilgari progress
    // bo'lmasa 0 dan boshlanganini yozamiz (resume pozitsiyasini o'chirib qo'ymaymiz).
    const hasProgress = state.history.some((x) => x.movieId === m.id && x.progressPct > 0);
    if (!hasProgress) {
      KinoBotApi.recordHistory(m.id, 0).catch(() => {});
    }

    if (!hasSrc) {
      // Manba yo'q — bo'sh holat
      videoEl.removeAttribute("src");
      emptyEl.hidden = false;
      emptyEl.innerHTML = `${icon("filmStrip", 40)}<p>${esc(t("playerNoSource")).replace(/\n/g, "<br>")}</p>`;
      KinoBotPlayer.destroy();
      return;
    }

    const loaded = KinoBotPlayer.load(m, {
      resumeAt: resumeAtFor(m.id),
      onProgress: (pct, pos) => savePlayerProgress(m.id, pct, pos),
      onEnded: () => {
        // Film tugadi — 100% deb belgilaymiz, keyingi marta davom etish shart emas
        KinoBotApi.recordHistory(m.id, 100, 0).catch(() => {});
        upsertLocalHistory(m.id, 100, 0);
      },
      onError: (msg) => toast(msg || t("playerError")),
      // R2 manbalari uchun: backend orqali vaqtinchalik signed URL olish.
      // Backend ok:false qaytarsa ham aniq sabab ko'rinishi uchun (masalan
      // "Telegram video xizmati sozlanmagan" yoki "SUBSCRIPTION_REQUIRED"),
      // generic "Video URL olinmadi" bilan yashirib qo'ymasdan xato xabarini
      // shu yerda uzatamiz.
      resolveUrl: (quality) =>
        KinoBotApi.getVideoUrl(m.id, quality).then((json) => {
          if (json && json.ok) return json.data.url;
          const errMsg = json && json.error && json.error.message;
          throw new Error(errMsg || "Video URL olinmadi");
        }),
    });

    if (!loaded) {
      emptyEl.hidden = false;
      emptyEl.innerHTML = `${icon("filmStrip", 40)}<p>${esc(t("playerNoSource")).replace(/\n/g, "<br>")}</p>`;
    }
  }

  function renderFilter() {
    const row = document.getElementById("filterGenres");
    const cur = state.catalogOpts.filter && state.catalogOpts.filter.genre;
    row.innerHTML = state.genres.map((g) =>
      `<button class="chip-select ${cur === g ? "active" : ""}" data-fgenre="${esc(g)}">${esc(g)}</button>`
    ).join("");
    const f = state.catalogOpts.filter;
    const yearVal = (f && f.yearMin) || 1900;
    const ratingVal = (f && f.ratingMin) || 0;
    document.getElementById("yearSlider").value = yearVal;
    document.getElementById("ratingSlider").value = ratingVal;
    document.getElementById("yearSliderVal").textContent = String(yearVal);
    document.getElementById("ratingSliderVal").textContent = String(ratingVal);
  }

  // ===================== PREMIUM =====================
  function fmtSum(n) {
    return Number(n || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
  }

  const PLAN_LABELS = { "1month": "premiumPlan1Month", "3months": "premiumPlan3Months", "1year": "premiumPlan1Year" };

  function updatePremiumBadge() {
    const badge = document.getElementById("profilePremiumBadge");
    const menuLabel = document.getElementById("premiumMenuLabel");
    if (!badge) return;
    const active = state.premium && state.premium.isActive;
    if (active) {
      badge.hidden = false;
      badge.innerHTML = `${icon("star", 11, true)} PREMIUM`;
    } else {
      badge.hidden = true;
      badge.innerHTML = "";
    }
    if (menuLabel) menuLabel.textContent = active ? t("premiumMenuActive") : t("premiumMenu");
  }

  async function renderPremium() {
    const statusCard = document.getElementById("premiumStatusCard");
    const purchaseWrap = document.getElementById("premiumPurchaseWrap");
    const historyWrap = document.getElementById("premiumHistoryWrap");
    const historyList = document.getElementById("premiumHistoryList");

    // Joriy holatni har safar yangilaymiz (masalan boshqa qurilmada
    // tasdiqlangan bo'lishi mumkin).
    const [statusRes, plansRes, settingsRes, paymentsRes] = await Promise.all([
      KinoBotApi.getPremiumStatus(),
      state.premiumPlans.length ? Promise.resolve({ ok: true, data: { plans: state.premiumPlans } }) : KinoBotApi.getPremiumPlans(),
      KinoBotApi.getPremiumPaymentSettings(),
      KinoBotApi.getMyPayments(),
    ]);

    if (statusRes && statusRes.ok) state.premium = statusRes.data.premium || null;
    if (plansRes && plansRes.ok) state.premiumPlans = plansRes.data.plans || [];
    if (settingsRes && settingsRes.ok) state.premiumPaymentSettings = settingsRes.data.settings || null;
    updatePremiumBadge();

    const p = state.premium;
    const isActive = p && p.isActive;

    if (isActive) {
      const expiresText = p.expiresAt ? fmtDateTime(p.expiresAt) : "—";
      statusCard.hidden = false;
      statusCard.innerHTML = `
        <div class="premium-active-badge">${icon("star", 16, true)} ${t("premiumActiveTitle")}</div>
        <div class="premium-active-row"><span>${t("premiumActivePlan")}</span><b>${esc(t(PLAN_LABELS[p.plan] || "premiumPlan1Month"))}</b></div>
        <div class="premium-active-row"><span>${t("premiumActiveExpires")}</span><b>${esc(expiresText)}</b></div>`;
      purchaseWrap.hidden = false; // Muddat tugagach yangi paket sotib olish uchun ochiq qoladi
    } else {
      statusCard.hidden = true;
      statusCard.innerHTML = "";
      purchaseWrap.hidden = false;
      if (p && p.expired) toast(t("premiumExpiredToast"));
    }

    // Paketlar
    const plansEl = document.getElementById("premiumPlans");
    const plans = state.premiumPlans.length ? state.premiumPlans : [
      { id: "1month", name: "1 oy", duration: 30, price: 50000 },
      { id: "3months", name: "3 oy", duration: 90, price: 120000 },
      { id: "1year", name: "1 yil", duration: 365, price: 400000 },
    ];
    plansEl.innerHTML = plans.map((plan) => `
      <div class="premium-plan-card ${state.premiumSelectedPlan === plan.id ? "active" : ""}" data-plan="${esc(plan.id)}">
        <div class="premium-plan-name">${esc(t(PLAN_LABELS[plan.id]) || plan.name)}</div>
        <div class="premium-plan-price">${fmtSum(plan.price)}</div>
      </div>`).join("");
    if (!state.premiumSelectedPlan && plans[0]) state.premiumSelectedPlan = plans[0].id;

    // Karta rekvizitlari
    const cardInfoEl = document.getElementById("premiumCardInfo");
    const settings = state.premiumPaymentSettings;
    if (settings && settings.cardNumber) {
      cardInfoEl.innerHTML = `
        <div class="premium-card-number">${esc(formatCardNumber(settings.cardNumber))}</div>
        <div class="premium-card-holder">${esc(settings.cardHolder || "")}</div>`;
    } else {
      cardInfoEl.innerHTML = `<p class="search-empty">${t("premiumNoCardSettings")}</p>`;
    }

    // Foydalanuvchining o'z to'lovlar tarixi (agar bo'lsa)
    if (paymentsRes && paymentsRes.ok && Array.isArray(paymentsRes.data.payments) && paymentsRes.data.payments.length) {
      historyWrap.hidden = false;
      historyList.innerHTML = paymentsRes.data.payments.map(paymentHistoryRow).join("");
    } else {
      historyWrap.hidden = true;
      historyList.innerHTML = "";
    }
  }

  function formatCardNumber(num) {
    const digits = String(num || "").replace(/\D/g, "");
    return digits.replace(/(.{4})/g, "$1 ").trim();
  }

  function formatNumber(num) {
    return String(num || 0).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  }

  function paymentHistoryRow(p) {
    const statusLabel = p.status === "approved" ? t("paymentStatusApproved")
      : p.status === "rejected" ? t("paymentStatusRejected")
      : t("paymentStatusPending");
    const statusClass = p.status === "approved" ? "ok" : p.status === "rejected" ? "bad" : "pending";
    return `
      <div class="premium-history-row">
        <div class="phr-main">
          <b>${esc(t(PLAN_LABELS[p.plan] || p.plan))}</b>
          <span>${fmtSum(p.amount)}</span>
        </div>
        <div class="phr-meta">
          <span class="payment-status-badge ${statusClass}">${statusLabel}</span>
          <span>${fmtDateTime(p.createdAt)}</span>
        </div>
      </div>`;
  }

  // Tanlangan chek faylini vaqtincha saqlab turamiz (yuborilguncha).
  let premiumCheckFile = null;

  function bindPremiumCheckInput() {
    const fileInput = document.getElementById("premiumCheckFile");
    if (!fileInput) return;
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) {
        toast(t("premiumCheckTooLarge"));
        fileInput.value = "";
        return;
      }
      premiumCheckFile = f;
      const preview = document.getElementById("premiumCheckPreview");
      const reader = new FileReader();
      reader.onload = () => {
        if (preview) preview.innerHTML = `<img src="${esc(String(reader.result))}" alt="">`;
      };
      reader.readAsDataURL(f);
    });
  }

  async function submitPremiumPurchase() {
    if (!state.premiumSelectedPlan) { toast(t("premiumSelectPlanFirst")); return; }
    if (!premiumCheckFile) { toast(t("premiumCheckRequired")); return; }

    const btn = document.getElementById("premiumSubmitBtn");
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = t("premiumSubmitting");

    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(premiumCheckFile);
    });

    if (!dataUrl) {
      btn.disabled = false;
      btn.textContent = oldText;
      toast(t("toastError"));
      return;
    }

    const res = await KinoBotApi.purchasePremium(state.premiumSelectedPlan, dataUrl);
    btn.disabled = false;
    btn.textContent = oldText;

    if (!res.ok) {
      toast(res.error && res.error.message ? res.error.message : t("toastError"));
      return;
    }

    // Tozalash va holatni yangilash
    premiumCheckFile = null;
    const fileInput = document.getElementById("premiumCheckFile");
    if (fileInput) fileInput.value = "";
    const preview = document.getElementById("premiumCheckPreview");
    if (preview) preview.innerHTML = `<span class="poster-preview-empty">—</span>`;

    toast(t("premiumSubmittedToast"));
    await renderPremium();
  }

  // ===================== ADMIN =====================
  async function renderAdmin() {
    const statsEl = document.getElementById("adminStats");
    const addBtn = document.getElementById("addFilmBtn");
    const pwBtn = document.getElementById("adminPasswordBtn");
    const bannerBtn = document.getElementById("adminBannerBtn");
    const pane = document.getElementById("adminPane");

    if (!state.adminKey) {
      statsEl.innerHTML = "";
      addBtn.hidden = true;
      pwBtn.hidden = true;
      bannerBtn.hidden = true;
      pane.innerHTML = `
        <div class="admin-login">
          <div class="admin-login-ic">${icon("lock", 30)}</div>
          <p>${t("adminKeyPrompt")}</p>
          <input type="password" class="admin-key-input" id="adminKeyInput" placeholder="${t("adminKeyPlaceholder")}">
          <button class="btn-primary full" id="adminLoginBtn">${t("adminConnect")}</button>
        </div>`;
      return;
    }

    // Kalit bor — stats orqali tekshiramiz
    const stats = await KinoBotApi.adminStats(state.adminKey);
    if (!stats.ok) {
      if (stats.error && stats.error.code === "FORBIDDEN") {
        state.adminKey = "";
        try { localStorage.removeItem("kb_admin_key"); } catch (e) {}
        toast(t("adminKeyInvalid"));
        renderAdmin();
      } else {
        toast(t("errorLoad"));
      }
      return;
    }
    state.adminAuthed = true;
    state.adminStats = stats.data;
    addBtn.hidden = true;
    pwBtn.hidden = false;
    bannerBtn.hidden = false;

    // Tab badge'lari — Premium (kutilayotgan to'lovlar) va Xabarlar (o'qilmagan).
    const contactBadge = document.getElementById("contactTabBadge");
    const premiumBadge = document.getElementById("premiumTabBadge");
    if (contactBadge) {
      const n = stats.data.unreadMessages || 0;
      contactBadge.hidden = n === 0;
      contactBadge.textContent = n > 99 ? "99+" : String(n);
    }
    if (premiumBadge) {
      const n = stats.data.pendingPayments || 0;
      premiumBadge.hidden = n === 0;
      premiumBadge.textContent = n > 99 ? "99+" : String(n);
    }
    statsEl.innerHTML = `
      <div class="admin-stats-grid">
        <div class="admin-stat"><b>${stats.data.totalMovies}</b><span>${t("adminStatsMovies")}</span></div>
        <div class="admin-stat"><b>${stats.data.totalUsers}</b><span>${t("adminStatsUsers")}</span></div>
        <div class="admin-stat"><b>${stats.data.totalGenres}</b><span>${t("adminStatsGenres")}</span></div>
        <div class="admin-stat"><b>${stats.data.totalFavorites}</b><span>${t("adminStatsFavs")}</span></div>
        <div class="admin-stat"><b>${stats.data.totalHistory}</b><span>${t("adminStatsHistory")}</span></div>
      </div>`;

    if (state.adminTab === "films") renderAdminFilms(pane);
    else if (state.adminTab === "channels") renderAdminChannels(pane);
    else if (state.adminTab === "storage") renderAdminStorageVideos(pane);
    else if (state.adminTab === "stats") renderAdminStats(pane);
    else if (state.adminTab === "audit") renderAdminAudit(pane);
    else if (state.adminTab === "contact") renderAdminContact(pane);
    else if (state.adminTab === "premium") renderAdminPremium(pane);
    else renderAdminUsers(pane);
  }

  // -- Admin: Premium bo'limi — barcha premium xizmatlari bitta tugma ostida
  // (to'lovlar, paketlar va to'lov sozlamalari ichki sub-tablar sifatida)
  async function renderAdminPremium(pane) {
    const sub = state.adminPremiumTab || "payments";
    const enabled = state.premiumEnabled;
    const streamingOnly = state.streamingPremiumOnly;
    pane.innerHTML = `
      <div class="admin-premium-toggle-row">
        <span>${t("adminPremiumEnabledLabel")}</span>
        <label class="switch">
          <input type="checkbox" id="adminPremiumToggle" ${enabled ? "checked" : ""}>
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="admin-premium-toggle-row">
        <span>${t("adminStreamingPremiumLabel")}</span>
        <label class="switch">
          <input type="checkbox" id="adminStreamingPremiumToggle" ${streamingOnly ? "checked" : ""}>
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="admin-subtabs">
        <button class="admin-subtab ${sub === "payments" ? "active" : ""}" data-premium-tab="payments">${t("adminPaymentsTab")}</button>
        <button class="admin-subtab ${sub === "plans" ? "active" : ""}" data-premium-tab="plans">${t("adminPlansTab")}</button>
        <button class="admin-subtab ${sub === "settings" ? "active" : ""}" data-premium-tab="settings">${t("adminPaymentSettingsTab")}</button>
      </div>
      <div id="adminPremiumPane"></div>`;

    document.getElementById("adminPremiumToggle")?.addEventListener("change", async (e) => {
      const next = e.target.checked;
      e.target.disabled = true;
      const res = await KinoBotApi.adminSetPremiumEnabled(state.adminKey, next);
      e.target.disabled = false;
      if (res.ok) {
        state.premiumEnabled = res.data.enabled;
        toast(t("toastSaved"));
      } else {
        e.target.checked = !next;
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
      }
    });

    document.getElementById("adminStreamingPremiumToggle")?.addEventListener("change", async (e) => {
      const next = e.target.checked;
      e.target.disabled = true;
      const res = await KinoBotApi.adminSetStreamingPremiumOnly(state.adminKey, next);
      e.target.disabled = false;
      if (res.ok) {
        state.streamingPremiumOnly = res.data.enabled;
        toast(t("toastSaved"));
      } else {
        e.target.checked = !next;
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
      }
    });

    const subPane = document.getElementById("adminPremiumPane");
    if (sub === "settings") renderAdminPaymentSettings(subPane);
    else if (sub === "plans") renderAdminPlans(subPane);
    else renderAdminPayments(subPane);
  }

  // Premium sub-tab ichidagi joriy render nishonini topadi (to'lovlar/sozlamalar
  // amallaridan keyin qayta chizish uchun). Premium bo'limida bo'lmasa, adminPane'ga tushadi.
  function adminPremiumSubPane() {
    return document.getElementById("adminPremiumPane") || document.getElementById("adminPane");
  }

  // ===================== ADMIN PLANS (Paketlar) =====================
  async function renderAdminPlans(pane) {
    const res = await KinoBotApi.adminListPlans(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const plans = res.data.plans || [];

    pane.innerHTML = `
      <div class="admin-add-row">
        <button class="btn-primary" id="adminAddPlanBtn">${t("addBtn")}</button>
      </div>
      <div class="admin-plan-list">
        ${plans.map((p) => `
          <div class="admin-plan-row ${!p.isActive ? "inactive" : ""}" data-id="${esc(p.id)}">
            <div class="admin-plan-info">
              <div class="t">${esc(p.name)}${!p.isActive ? ` <span class="admin-inactive-badge">${t("adminStatusInactive")}</span>` : ""}</div>
              <div class="m">${t("adminPlanPrice", { price: formatNumber(p.price) })} · ${t("adminPlanDuration", { days: p.durationDays })} · ${p.movieIds && p.movieIds.length ? p.movieIds.length + " " + t("adminPlanMovies") : t("adminPlanAllMovies")}</div>
            </div>
            <div class="admin-actions">
              <button data-admin-plan-movies="${esc(p.id)}" aria-label="${t("adminPlanMovies")}">${icon("list", 15)}</button>
              <button data-admin-edit-plan="${esc(p.id)}" aria-label="${t("edit")}">${icon("edit", 15)}</button>
              <button data-admin-delete-plan="${esc(p.id)}" aria-label="${t("delete")}">${icon("trash", 15)}</button>
            </div>
          </div>`).join("") || `<p class="search-empty">${t("adminNoPlans")}</p>`}
      </div>`;

    // Event listeners
    document.getElementById("adminAddPlanBtn")?.addEventListener("click", () => openPlanModal());
    pane.querySelectorAll("[data-admin-edit-plan]").forEach((btn) => {
      btn.addEventListener("click", () => openPlanModal(btn.dataset.adminEditPlan));
    });
    pane.querySelectorAll("[data-admin-delete-plan]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("confirmDeletePlan", { name: btn.dataset.adminDeletePlan }))) return;
        const res = await KinoBotApi.adminDeletePlan(state.adminKey, btn.dataset.adminDeletePlan);
        if (res.ok) { toast(t("toastDeleted")); renderAdminPlans(pane); }
        else toast(res.error?.message || t("toastError"));
      });
    });
    pane.querySelectorAll("[data-admin-plan-movies]").forEach((btn) => {
      btn.addEventListener("click", () => renderAdminPlanMovies(pane, btn.dataset.adminPlanMovies));
    });
  }

  async function renderAdminPlanMovies(pane, planId) {
    // Load all movies and the plan's current movieIds
    const [moviesRes, plansRes] = await Promise.all([
      KinoBotApi.adminListMovies(state.adminKey, {}),
      KinoBotApi.adminListPlans(state.adminKey),
    ]);
    if (!moviesRes.ok || !plansRes.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const movies = moviesRes.data.movies || [];
    const plan = (plansRes.data.plans || []).find((p) => p.id === planId);
    if (!plan) { toast(t("errorLoad")); renderAdminPlans(pane); return; }
    const assignedIds = new Set(plan.movieIds || []);

    pane.innerHTML = `
      <div class="admin-plan-movies-header">
        <button class="btn-ghost" id="backToPlansBtn">${icon("chevron-left", 15)} ${t("backBtn")}</button>
        <h3>${esc(plan.name)} — ${t("adminPlanMovies")}</h3>
      </div>
      <div class="admin-plan-movies-search">
        <input type="text" id="planMoviesSearch" placeholder="${t("searchMovies")}" aria-label="${t("searchMovies")}">
      </div>
      <div class="admin-plan-movies-grid">
        ${movies.filter((m) => m.isPremium).map((m) => `
          <label class="admin-plan-movie-chip ${assignedIds.has(m.id) ? "checked" : ""}" data-id="${esc(m.id)}">
            <input type="checkbox" ${assignedIds.has(m.id) ? "checked" : ""} value="${esc(m.id)}">
            ${m.posterUrl ? `<img src="${esc(m.posterUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:4px">` : esc(m.title.charAt(0))}
            <span class="chip-title">${esc(m.title)}</span>
            <span class="chip-year">${m.year}</span>
          </label>`).join("") || `<p class="search-empty">${t("adminNoPremiumMovies")}</p>`}
      </div>
      <div class="admin-plan-movies-footer">
        <button class="btn-primary" id="savePlanMoviesBtn">${t("saveBtn")}</button>
      </div>`;

    // Search filter
    const searchInput = document.getElementById("planMoviesSearch");
    searchInput?.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase();
      pane.querySelectorAll(".admin-plan-movie-chip").forEach((chip) => {
        const title = chip.querySelector(".chip-title").textContent.toLowerCase();
        chip.style.display = title.includes(q) ? "flex" : "none";
      });
    });

    // Checkbox click
    pane.querySelectorAll(".admin-plan-movie-chip input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        cb.closest(".admin-plan-movie-chip").classList.toggle("checked", cb.checked);
      });
    });

    // Back button
    document.getElementById("backToPlansBtn")?.addEventListener("click", () => renderAdminPlans(pane));

    // Save
    document.getElementById("savePlanMoviesBtn")?.addEventListener("click", async () => {
      const movieIds = Array.from(pane.querySelectorAll(".admin-plan-movie-chip input[type=checkbox]:checked")).map((el) => el.value);
      const res = await KinoBotApi.adminAssignPlanMovies(state.adminKey, planId, movieIds);
      if (res.ok) { toast(t("toastSaved")); renderAdminPlans(pane); }
      else toast(res.error?.message || t("toastError"));
    });
  }

  function openPlanModal(planId = null) {
    const isEdit = !!planId;
    let plan = { name: "", price: 0, durationDays: 30, isActive: true };

    const body = `
      <div class="plan-form">
        <div class="form-row">
          <label class="form-field-label">${t("planName")}</label>
          <input type="text" id="planNameInput" value="${esc(isEdit ? plan.name : "")}" placeholder="${t("planNamePlaceholder")}" required>
        </div>
        <div class="form-row">
          <label class="form-field-label">${t("planPrice")} (so'm)</label>
          <input type="number" id="planPriceInput" value="${esc(isEdit ? plan.price : "")}" placeholder="0" min="0" step="1000" required>
        </div>
        <div class="form-row">
          <label class="form-field-label">${t("planDuration")} (kun)</label>
          <input type="number" id="planDurationInput" value="${esc(isEdit ? plan.durationDays : 30)}" placeholder="30" min="1" max="365" required>
        </div>
        <div class="form-row form-checkbox">
          <label>
            <input type="checkbox" id="planActiveInput" ${isEdit ? (plan.isActive ? "checked" : "") : "checked"}>
            <span>${t("planActive")}</span>
          </label>
        </div>
      </div>`;

    const modal = modalShell(isEdit ? t("planEditTitle") : t("planNewTitle"), body, { footer: false });
    const footerHtml = `
      <button class="btn-ghost" data-modal-close>${t("cancelBtn")}</button>
      <button class="btn-primary" id="savePlanBtn">${t("saveBtn")}</button>`;
    openModal(modal + `<div class="modal-footer">${footerHtml}</div>`);

    // If editing, fetch plan details
    if (isEdit) {
      KinoBotApi.adminListPlans(state.adminKey).then((res) => {
        if (res.ok) {
          const p = (res.data.plans || []).find((x) => x.id === planId);
          if (p) {
            document.getElementById("planNameInput").value = p.name;
            document.getElementById("planPriceInput").value = p.price;
            document.getElementById("planDurationInput").value = p.durationDays;
            document.getElementById("planActiveInput").checked = p.isActive;
            plan = p;
          }
        }
      });
    }

    document.getElementById("savePlanBtn")?.addEventListener("click", async () => {
      const name = document.getElementById("planNameInput").value.trim();
      const price = Number(document.getElementById("planPriceInput").value);
      const durationDays = Number(document.getElementById("planDurationInput").value);
      const isActive = document.getElementById("planActiveInput").checked;

      if (!name || !price || !durationDays) { toast(t("planFieldsRequired")); return; }

      const targetPane = adminPremiumSubPane();
      if (isEdit) {
        const res = await KinoBotApi.adminUpdatePlan(state.adminKey, planId, { name, price, durationDays, isActive });
        if (res.ok) { toast(t("toastSaved")); closeModal(); renderAdminPlans(targetPane); }
        else toast(res.error?.message || t("toastError"));
      } else {
        const res = await KinoBotApi.adminCreatePlan(state.adminKey, { name, price, durationDays, isActive });
        if (res.ok) { toast(t("toastSaved")); closeModal(); renderAdminPlans(targetPane); }
        else toast(res.error?.message || t("toastError"));
      }
    });
  }

  function adminFilmStatusLabel(m) {
    if (m.status === "inactive") return t("adminStatusInactive");
    if (m.status === "hidden") return t("adminStatusHidden");
    return t("adminStatusActive");
  }

  async function renderAdminFilms(pane) {
    pane.innerHTML = skelCard(3);
    const filter = state.adminFilmsFilter;
    const params = filter === "ALL" ? {} : { status: filter };
    const res = await KinoBotApi.adminListMovies(state.adminKey, params);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const movies = res.data.movies || [];

    const chip = (key, label) =>
      `<button class="admin-filter-chip ${filter === key ? "active" : ""}" data-film-filter="${key}">${label}</button>`;

    pane.innerHTML = `
      <div class="admin-film-list">
        ${movies.map((m) => `
          <div class="admin-film-row" data-id="${esc(m.id)}">
            <div class="admin-thumb ${gClass(m)}">
              ${m.posterUrl ? `<img src="${esc(m.posterUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:6px">` : esc(m.title.charAt(0))}
            </div>
            <div class="admin-film-info">
              <div class="t">${esc(m.title)}${m.featured ? ` <span class="admin-featured-badge">${icon("star", 12, true)}</span>` : ""}</div>
              <div class="m">${m.year} • ${esc(m.genres.slice(0, 2).join(", "))} • ${m.rating}</div>
              <span class="user-status-badge ${m.status === "active" ? "" : "blocked"}"><span class="dot"></span>${esc(adminFilmStatusLabel(m))}</span>
            </div>
            <div class="admin-actions">
              <button data-admin-edit="${esc(m.id)}" aria-label="${t("edit")}">${icon("edit", 15)}</button>
              <button data-admin-delete="${esc(m.id)}" aria-label="${t("delete")}">${icon("trash", 15)}</button>
            </div>
          </div>`).join("") || `<p class="search-empty">${t("adminNoData")}</p>`}
      </div>`;
  }

  // Janrlar bo'limi olib tashlandi — janrlar endi faqat film qo'shish/tahrirlash
  // formasida (mavjud ro'yxatdan tanlab) ishlatiladi, alohida boshqaruv kerak emas.

  // -- Admin: majburiy obuna kanallari
  async function renderAdminChannels(pane) {
    const res = await KinoBotApi.adminListChannels(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const channels = res.data.channels || [];
    pane.innerHTML = `
      <p class="poster-hint" style="margin-bottom:12px;">${t("adminChannelsHint")}</p>
      <div class="admin-add-row" style="flex-direction:column; align-items:stretch; gap:8px;">
        <input type="text" id="adminChannelChatId" placeholder="${t("adminChannelChatIdPlaceholder")}">
        <input type="text" id="adminChannelTitle" placeholder="${t("adminChannelTitlePlaceholder")}">
        <input type="url" id="adminChannelLink" placeholder="${t("adminChannelLinkPlaceholder")}">
        <button class="btn-primary full" id="adminAddChannelBtn">${t("addBtn")}</button>
      </div>
      <div class="admin-genre-list" style="margin-top:16px;">
        ${channels.map((c) => `
          <div class="admin-genre-row">
            <span>${esc(c.title)}<br><small style="opacity:.65">${esc(c.chatId)}</small></span>
            <button data-admin-delchannel="${esc(c.id)}" aria-label="${t("delete")}">${icon("trash", 15)}</button>
          </div>`).join("") || `<p class="search-empty">${t("adminNoData")}</p>`}
      </div>`;
  }

  // Admin uchun oddiy video pleyer modal — storage kanal videolarini
  // ko'rish uchun (asosiy KinoBotPlayer sifat/HLS mantig'i kerak emas,
  // bu yerda bitta to'g'ridan-to'g'ri MP4 stream URL bor).
  function openPlayerWithUrl(url, title) {
    openModal(
      modalShell(title || t("adminStoragePlay"), `
        <video id="adminStorageVideo" controls autoplay playsinline
          style="width:100%; max-height:70vh; background:#000; border-radius:8px;"
          src="${esc(url)}"></video>`, { footer: false })
    );
  }

  // -- Admin: storage kanalga avtomatik saqlangan videolar (Telegram MTProto)
  async function renderAdminStorageVideos(pane) {
    const res = await KinoBotApi.adminListStorageVideos(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    if (res.data.enabled === false) {
      pane.innerHTML = `<p class="poster-hint">${t("adminStorageDisabled")}</p>`;
      return;
    }
    const videos = res.data.videos || [];
    const fmtSize = (n) => {
      if (!n) return "";
      const mb = n / (1024 * 1024);
      return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
    };
    pane.innerHTML = `
      <p class="poster-hint" style="margin-bottom:12px;">${t("adminStorageHint")}</p>
      <div class="admin-genre-list">
        ${videos.map((v) => `
          <div class="admin-genre-row">
            <span>${esc(v.fileName || v.caption || v.id)}${v.code ? ` <small style="opacity:.65">#${esc(v.code)}</small>` : ""}<br>
              <small style="opacity:.65">${esc(fmtSize(v.fileSize))} · ${esc(new Date(v.savedAt).toLocaleString())}</small></span>
            <span style="display:flex; gap:8px;">
              <button data-admin-storage-play="${esc(v.id)}" aria-label="${t("adminStoragePlay")}">${icon("eye", 15)}</button>
              <button data-admin-storage-del="${esc(v.id)}" aria-label="${t("delete")}">${icon("trash", 15)}</button>
            </span>
          </div>`).join("") || `<p class="search-empty">${t("adminStorageEmpty")}</p>`}
      </div>`;
  }

  async function renderAdminUsers(pane) {
    const filter = state.adminUsersFilter;
    const q = state.adminUsersQuery;
    const res = await KinoBotApi.adminUsers(state.adminKey, { status: filter === "ALL" ? "" : filter, q });
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const users = res.data.users || [];

    const chip = (key, label) =>
      `<button class="admin-filter-chip ${filter === key ? "active" : ""}" data-user-filter="${key}">${label}</button>`;

    pane.innerHTML = `
      <div class="admin-user-toolbar">
        <input type="text" class="admin-user-search" id="adminUserSearch" value="${esc(q)}" placeholder="${t("searchUsers")}">
        <div class="admin-filter-chips">
          ${chip("ALL", t("allUsers"))}
          ${chip("ACTIVE", t("activeUsers"))}
          ${chip("BLOCKED", t("blockedUsers"))}
        </div>
      </div>
      <div class="admin-user-list">
        ${users.map(userRow).join("") || `<p class="search-empty">${t("noUsers")}</p>`}
      </div>`;
  }

  // Bir foydalanuvchi qatori (admin ro'yxati uchun).
  function userRow(u) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.id;
    const blocked = u.status === "BLOCKED" || Boolean(u.isBlocked);
    const admin = Boolean(u.isAdmin);
    return `
      <div class="admin-user-row" data-user-id="${esc(u.id)}">
        <div class="admin-user-av">${u.photoUrl ? `<img src="${esc(u.photoUrl)}" alt="">` : esc(name.charAt(0).toUpperCase())}</div>
        <div class="admin-user-info">
          <div class="t">${esc(name)}${admin ? ` ${icon("shield", 12)}` : ""}</div>
          <div class="m">${u.username ? "@" + esc(u.username) : esc(u.id)}</div>
          <span class="user-status-badge ${blocked ? "blocked" : ""}"><span class="dot"></span>${blocked ? t("userStatusBlocked") : t("userStatusActive")}</span>
        </div>
        <div class="admin-user-actions">
          <button data-user-stats="${esc(u.id)}" aria-label="${t("userStats")}">${icon("eye", 15)}</button>
          <button class="admin-admin-btn ${admin ? "on" : ""}" data-user-admin="${esc(u.id)}" aria-label="${admin ? t("removeAdmin") : t("makeAdmin")}">${icon("shield", 15)}</button>
          <button class="${blocked ? "admin-unblock-btn" : "admin-block-btn"}" data-user-toggle="${esc(u.id)}" aria-label="${blocked ? t("unblock") : t("block")}">${icon("lock", 15)}</button>
        </div>
      </div>`;
  }

  // GET /api/admin/users/:id -> user detali + statistika ko'rinishi (modal).
  async function userDetailModal(id) {
    const res = await KinoBotApi.adminUserDetail(state.adminKey, id);
    if (!res.ok) {
      toast(res.error && res.error.message ? res.error.message : t("toastError"));
      return;
    }
    const u = res.data.user;
    const st = res.data.stats || {};
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.id;
    const blocked = u.status === "BLOCKED" || Boolean(u.isBlocked);
    const body = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
        <div class="admin-user-av" style="width:52px;height:52px;flex:0 0 52px;font-size:19px">${u.photoUrl ? `<img src="${esc(u.photoUrl)}" alt="">` : esc(name.charAt(0).toUpperCase())}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:16px;font-weight:800;color:var(--text)">${esc(name)}${u.isAdmin ? " " + icon("shield", 14) : ""}</div>
          <div style="font-size:12px;color:var(--text-faint);font-family:ui-monospace,monospace">@${esc(u.username || u.id)}</div>
        </div>
        <span class="user-status-badge ${blocked ? "blocked" : ""}"><span class="dot"></span>${blocked ? t("userStatusBlocked") : t("userStatusActive")}</span>
      </div>
      <div class="admin-user-stats">
        <div class="admin-user-stat"><b>${st.favoritesCount || 0}</b><span>${t("favCount")}</span></div>
        <div class="admin-user-stat"><b>${st.historyCount || 0}</b><span>${t("histCount")}</span></div>
        <div class="admin-user-stat"><b>${st.completedCount || 0}</b><span>${t("completedCount")}</span></div>
        <div class="admin-user-stat"><b>${fmtWatchTime(st.totalWatchSeconds)}</b><span>${t("watchTime")}</span></div>
      </div>
      <div class="admin-user-meta">
        <div class="row"><span>${t("lastSeen")}</span><b>${fmtDateTime(u.lastSeenAt) || "—"}</b></div>
        <div class="row"><span>${t("registered")}</span><b>${fmtDate(u.createdAt) || "—"}</b></div>
        <div class="row"><span>${t("userStatus")}</span><b>${blocked ? t("userStatusBlocked") : t("userStatusActive")}</b></div>
        <div class="admin-user-id">ID: ${esc(u.id)}</div>
      </div>`;
    openModal(modalShell(t("userDetailTitle"), body, { footer: false }));
  }

  // GET /api/admin/stats -> batafsil statistika ko'rinishi.
  async function renderAdminStats(pane) {
    pane.innerHTML = skelCard(3);
    const period = state.adminStatsPeriod;
    const res = await KinoBotApi.adminStats(state.adminKey, period === "all" ? "all" : period);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const data = res.data;
    const events = data.events || {};
    const mostWatched = data.mostWatched || [];
    const dailyActivity = data.dailyActivity || [];

    // Period selector chips
    const periodChip = (key, label) =>
      `<button class="admin-filter-chip ${period === key ? "active" : ""}" data-stats-period="${key}">${label}</button>`;

    // Simple bar chart for daily activity (max 14 days shown)
    const maxEvents = Math.max(1, ...dailyActivity.map(d => d.events || 0));
    const barChart = dailyActivity.slice(-14).map(d => {
      const h = Math.round((d.events / maxEvents) * 60);
      return `<div class="daily-bar" style="height:${h}px" title="${d.date}: ${d.events}"></div>`;
    }).join("");

    pane.innerHTML = `
      <div class="admin-stats-section">
        <div class="admin-period-selector">
          ${periodChip(7, t("adminStatsPeriod7d"))}
          ${periodChip(30, t("adminStatsPeriod30d"))}
          ${periodChip("all", t("adminStatsPeriodAll"))}
        </div>
        <div class="admin-stats-cards">
          <div class="admin-stats-card"><b>${data.totalMovies || 0}</b><span>${t("adminStatsMovies")}</span></div>
          <div class="admin-stats-card"><b>${data.totalUsers || 0}</b><span>${t("adminStatsUsers")}</span></div>
          <div class="admin-stats-card"><b>${data.activeUsers || 0}</b><span>${t("adminStatsActiveUsers")}</span></div>
          <div class="admin-stats-card"><b>${data.blockedUsers || 0}</b><span>${t("adminStatsBlockedUsers")}</span></div>
          <div class="admin-stats-card"><b>${data.newUsers || 0}</b><span>${t("adminStatsNewUsers")}</span></div>
          <div class="admin-stats-card"><b>${data.totalGenres || 0}</b><span>${t("adminStatsGenres")}</span></div>
          <div class="admin-stats-card"><b>${data.totalFavorites || 0}</b><span>${t("adminStatsFavs")}</span></div>
          <div class="admin-stats-card"><b>${data.totalHistory || 0}</b><span>${t("adminStatsHistory")}</span></div>
        </div>
      </div>
      <div class="admin-stats-section">
        <h3 class="admin-section-title">${t("adminStatsEvents")}</h3>
        <div class="admin-events-grid">
          <div class="admin-event-item"><span>${t("eventUserRegistered")}</span><b>${events.userRegistered || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventUserOpenedApp")}</span><b>${events.userOpenedApp || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventMovieOpened")}</span><b>${events.movieOpened || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventPlaybackStarted")}</span><b>${events.playbackStarted || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventPlaybackCompleted")}</span><b>${events.playbackCompleted || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventPlaybackFailed")}</span><b>${events.playbackFailed || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventFavoriteAdded")}</span><b>${events.favoriteAdded || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventFavoriteRemoved")}</span><b>${events.favoriteRemoved || 0}</b></div>
          <div class="admin-event-item"><span>${t("eventHistoryUpdated")}</span><b>${events.historyUpdated || 0}</b></div>
        </div>
      </div>
      <div class="admin-stats-section">
        <h3 class="admin-section-title">${t("adminStatsMostWatched")}</h3>
        <div class="admin-most-watched">
          ${mostWatched.slice(0, 10).map((m, i) => {
            const movie = state.movies.find(x => x.id === m.movieId);
            const title = movie ? movie.title : m.movieId;
            return `<div class="admin-most-watched-row">
              <span class="rank">${i + 1}</span>
              <span class="title">${esc(title)}</span>
              <span class="count">${t("adminStatsPlays", { n: m.count })}</span>
            </div>`;
          }).join("") || `<p class="search-empty">${t("adminNoData")}</p>`}
        </div>
      </div>
      <div class="admin-stats-section">
        <h3 class="admin-section-title">${t("adminStatsDailyActivity")}</h3>
        <div class="admin-daily-chart">${barChart || `<p class="search-empty">${t("adminNoData")}</p>`}</div>
      </div>`;
  }

  // GET /api/admin/audit-log -> audit log ko'rinishi.
  async function renderAdminAudit(pane) {
    pane.innerHTML = skelCard(3);
    const res = await KinoBotApi.adminAuditLog(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const entries = res.data.entries || [];
    pane.innerHTML = entries.length ? `
      <div class="admin-audit-list">
        ${entries.map((e) => `
          <div class="admin-audit-row">
            <div class="ent"><b>${esc(e.action || "")}</b> · ${esc(e.entityType || "")} ${e.entityId ? esc("#" + e.entityId) : ""}</div>
            <div class="meta"><b>${esc(e.adminId || "")}</b><span>${fmtDateTime(e.timestamp)}</span></div>
          </div>`).join("")}
      </div>` : `<p class="search-empty">${t("adminNoData")}</p>`;
  }

  // -- Admin: "Biz bilan bog'lanish" xabarlari
  async function renderAdminContact(pane) {
    pane.innerHTML = skelCard(3);
    const res = await KinoBotApi.adminContactMessages(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const messages = res.data.messages || [];
    pane.innerHTML = messages.length ? `
      <div class="admin-contact-list">
        ${messages.map(contactMessageRow).join("")}
      </div>` : `<p class="search-empty">${t("adminNoData")}</p>`;
  }

  function contactMessageRow(m) {
    const who = m.username ? "@" + esc(m.username) : (esc(m.userName) || esc(m.userId));
    return `
      <div class="admin-contact-row ${m.status === "new" ? "unread" : ""}" data-contact-id="${esc(m.id)}">
        <div class="admin-contact-head">
          <div class="who"><b>${who}</b><span class="admin-contact-uid">ID: ${esc(m.userId)}</span></div>
          <span class="admin-contact-time">${fmtDateTime(m.createdAt)}</span>
        </div>
        <p class="admin-contact-text">${esc(m.text)}</p>
        <div class="admin-contact-actions">
          ${m.status === "new" ? `<button class="btn-secondary btn-sm" data-contact-read="${esc(m.id)}">${icon("eye", 13)} ${t("contactMarkRead")}</button>` : ""}
          <button class="btn-secondary btn-sm ${m.blocked ? "admin-unblock-btn" : "admin-block-btn"}" data-contact-toggle-block="${esc(m.userId)}">${icon("lock", 13)} ${m.blocked ? t("unblock") : t("contactBlockUser")}</button>
        </div>
      </div>`;
  }

  // -- Admin: To'lovlar (Premium)
  async function renderAdminPayments(pane) {
    pane.innerHTML = skelCard(3);
    const filter = state.adminPaymentsFilter || "pending";
    const res = await KinoBotApi.adminListPayments(state.adminKey, filter === "ALL" ? {} : { status: filter });
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const payments = res.data.payments || [];
    const stats = res.data.stats || {};

    const chip = (key, label) =>
      `<button class="admin-filter-chip ${filter === key ? "active" : ""}" data-payment-filter="${key}">${label}</button>`;

    pane.innerHTML = `
      <div class="admin-payment-stats">
        <div class="admin-stat"><b>${stats.pending || 0}</b><span>${t("paymentStatusPending")}</span></div>
        <div class="admin-stat"><b>${stats.approved || 0}</b><span>${t("paymentStatusApproved")}</span></div>
        <div class="admin-stat"><b>${stats.rejected || 0}</b><span>${t("paymentStatusRejected")}</span></div>
      </div>
      <div class="admin-user-toolbar">
        <div class="admin-filter-chips">
          ${chip("pending", t("paymentStatusPending"))}
          ${chip("approved", t("paymentStatusApproved"))}
          ${chip("rejected", t("paymentStatusRejected"))}
          ${chip("ALL", t("adminStatusAll"))}
        </div>
      </div>
      <div class="admin-payment-list">
        ${payments.map(paymentRow).join("") || `<p class="search-empty">${t("adminNoData")}</p>`}
      </div>`;
  }

  function paymentRow(p) {
    const who = p.user ? (p.user.username ? "@" + esc(p.user.username) : esc([p.user.firstName, p.user.lastName].filter(Boolean).join(" ") || p.user.id)) : esc(p.userId);
    const statusLabel = p.status === "approved" ? t("paymentStatusApproved")
      : p.status === "rejected" ? t("paymentStatusRejected")
      : t("paymentStatusPending");
    const statusClass = p.status === "approved" ? "ok" : p.status === "rejected" ? "bad" : "pending";
    return `
      <div class="admin-payment-row" data-payment-id="${esc(p.id)}">
        <div class="admin-payment-head">
          <div class="who"><b>${who}</b><span class="admin-contact-uid">ID: ${esc(p.userId)}</span></div>
          <span class="payment-status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="admin-payment-meta">
          <span><b>${esc(t(PLAN_LABELS[p.plan] || p.plan))}</b></span>
          <span>${fmtSum(p.amount)}</span>
          <span>${fmtDateTime(p.createdAt)}</span>
        </div>
        <div class="admin-payment-actions">
          <button class="btn-secondary btn-sm" data-payment-view="${esc(p.id)}">${icon("eye", 13)} ${t("paymentViewCheck")}</button>
          ${p.status === "pending" ? `
            <button class="btn-primary btn-sm" data-payment-approve="${esc(p.id)}">${icon("save", 13)} ${t("paymentApprove")}</button>
            <button class="btn-danger btn-sm" data-payment-reject="${esc(p.id)}">${icon("trash", 13)} ${t("paymentReject")}</button>` : ""}
        </div>
      </div>`;
  }

  // Chek rasmini yuklab olish uchun fayl nomi — data URL'dagi MIME turidan
  // kengaytmani aniqlaydi (masalan "image/jpeg" -> .jpg).
  function checkImageFilename(payment) {
    const m = /^data:image\/([a-zA-Z0-9+.-]+);/.exec(payment.checkImageData || "");
    let ext = m ? m[1].toLowerCase() : "jpg";
    if (ext === "jpeg") ext = "jpg";
    if (ext === "svg+xml") ext = "svg";
    const who = (payment.userId || "check").toString().replace(/[^a-zA-Z0-9_-]/g, "");
    return `chek-${who}-${payment.id || ""}.${ext}`;
  }

  // Chek rasmini yuklab olish — Telegram Mini App WebView'ida
  // <a download href="data:..."> ko'p hollarda ishlamaydi, shuning uchun
  // data URL'ni Blob'ga aylantirib, blob URL orqali yuklaymiz.
  function downloadCheckImage(dataUrl, filename) {
    try {
      const parts = dataUrl.split(",");
      const mimeMatch = /^data:(.*?);base64/.exec(parts[0]);
      const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const binary = atob(parts[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || "chek.jpg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
    } catch (e) {
      // Blob usuli ham ishlamasa (ba'zi Telegram WebView versiyalarida),
      // rasmni yangi oynada ochamiz — foydalanuvchi qo'lda saqlab olishi mumkin.
      if (tg && tg.openLink) {
        tg.openLink(dataUrl);
      } else {
        window.open(dataUrl, "_blank");
      }
    }
  }

  // To'lov detali (chek rasmi) modalda ko'rsatiladi.
  async function paymentDetailModal(paymentId) {
    const res = await KinoBotApi.adminPaymentDetail(state.adminKey, paymentId);
    if (!res.ok) { toast(res.error && res.error.message ? res.error.message : t("toastError")); return; }
    const p = res.data.payment;
    const u = res.data.user;
    const who = u ? (u.username ? "@" + esc(u.username) : esc([u.firstName, u.lastName].filter(Boolean).join(" ") || u.id)) : esc(p.userId);
    const statusLabel = p.status === "approved" ? t("paymentStatusApproved")
      : p.status === "rejected" ? t("paymentStatusRejected")
      : t("paymentStatusPending");
    const body = `
      <div class="payment-detail-info">
        <div class="premium-active-row"><span>${t("paymentUser")}</span><b>${who}</b></div>
        <div class="premium-active-row"><span>${t("premiumActivePlan")}</span><b>${esc(t(PLAN_LABELS[p.plan] || p.plan))}</b></div>
        <div class="premium-active-row"><span>${t("paymentAmount")}</span><b>${fmtSum(p.amount)}</b></div>
        <div class="premium-active-row"><span>${t("paymentStatus")}</span><b>${statusLabel}</b></div>
        <div class="premium-active-row"><span>${t("paymentDate")}</span><b>${fmtDateTime(p.createdAt)}</b></div>
      </div>
      ${p.checkImageData ? `
        <img src="${esc(p.checkImageData)}" alt="" class="payment-check-img">
        <button type="button" class="btn-secondary full" data-download-check="${esc(p.id)}" data-check-image="${esc(p.checkImageData)}" data-check-filename="${esc(checkImageFilename(p))}" style="margin-top:10px;">${icon("download", 16)} ${t("paymentDownloadCheck")}</button>
      ` : `<p class="search-empty">${t("paymentNoCheck")}</p>`}`;
    const footer = p.status === "pending" ? `
      <button class="btn-danger" data-payment-reject="${esc(p.id)}">${t("paymentReject")}</button>
      <button class="btn-primary" data-payment-approve="${esc(p.id)}">${t("paymentApprove")}</button>` :
      `<button class="btn-secondary" data-modal-close>${t("cancelBtn")}</button>`;
    openModal(modalShell(t("paymentDetailTitle"), body, { footer: false }) + `<div class="modal-footer">${footer}</div>`);
  }

  async function approvePaymentAction(paymentId) {
    const res = await KinoBotApi.adminApprovePayment(state.adminKey, paymentId);
    if (res.ok) {
      toast(t("paymentApprovedToast"));
      closeModal();
      renderAdminPayments(adminPremiumSubPane());
    } else {
      toast(res.error && res.error.message ? res.error.message : t("toastError"));
    }
  }

  async function rejectPaymentAction(paymentId) {
    const res = await KinoBotApi.adminRejectPayment(state.adminKey, paymentId);
    if (res.ok) {
      toast(t("paymentRejectedToast"));
      closeModal();
      renderAdminPayments(adminPremiumSubPane());
    } else {
      toast(res.error && res.error.message ? res.error.message : t("toastError"));
    }
  }

  // -- Admin: To'lov sozlamalari (karta rekvizitlari)
  async function renderAdminPaymentSettings(pane) {
    pane.innerHTML = skelCard(1);
    const res = await KinoBotApi.adminGetPaymentSettings(state.adminKey);
    if (!res.ok) { pane.innerHTML = `<p class="search-empty">${t("errorLoad")}</p>`; return; }
    const s = res.data.settings || {};
    pane.innerHTML = `
      <div class="form-grid">
        <label class="span2">${t("paymentSettingsCardNumber")}
          <input type="text" id="ps_cardNumber" value="${esc(s.cardNumber || "")}" placeholder="8600 1234 5678 9012" maxlength="32">
        </label>
        <label class="span2">${t("paymentSettingsCardHolder")}
          <input type="text" id="ps_cardHolder" value="${esc(s.cardHolder || "")}" placeholder="ISM FAMILIYA" maxlength="100">
        </label>
      </div>
      <button class="btn-primary full" id="ps_save" style="margin-top:16px">${t("saveBtn")}</button>
      ${s.updatedAt ? `<p class="premium-hint" style="margin-top:10px">${t("paymentSettingsUpdatedAt")}: ${fmtDateTime(s.updatedAt)}</p>` : ""}`;

    document.getElementById("ps_save").addEventListener("click", async () => {
      const cardNumber = document.getElementById("ps_cardNumber").value.trim();
      const cardHolder = document.getElementById("ps_cardHolder").value.trim();
      if (cardNumber.length < 10) { toast(t("paymentSettingsCardInvalid")); return; }
      if (cardHolder.length < 2) { toast(t("paymentSettingsHolderRequired")); return; }
      const btn = document.getElementById("ps_save");
      btn.disabled = true;
      const r = await KinoBotApi.adminSavePaymentSettings(state.adminKey, cardNumber, cardHolder);
      btn.disabled = false;
      if (r.ok) {
        toast(t("toastSaved"));
        renderAdminPaymentSettings(pane);
      } else {
        toast(r.error && r.error.message ? r.error.message : t("toastError"));
      }
    });
  }

  // -- Admin: film ma'lumotlari (to'liq ekran shakli — skrinshotdagi dizayn)
  function movieFormModal(movie) {
    const m = movie || {};
    const isEdit = !!movie;
    const genresVal = Array.isArray(m.genres) ? m.genres.join(", ") : "";
    const hasPoster = !!m.posterUrl;
    const posterPreview = hasPoster
      ? `<img src="${esc(m.posterUrl)}" alt="">`
      : `${icon("upload", 26)}<span>${t("posterUploadHint")}</span>`;

    const body = `
      <div class="film-form-simple">
        <div class="form-grid">
          <label>${t("movieTitle")} *<input type="text" id="mf_title" value="${esc(m.title || "")}" required placeholder="${t("movieTitlePlaceholder") || "Film nomi"}"></label>
          <label>${t("movieOriginalTitle")}<input type="text" id="mf_orig" value="${esc(m.originalTitle || "")}" placeholder="${t("movieOriginalTitlePlaceholder") || "Asl nomi"}"></label>
          <label>${t("movieYear")} *<input type="number" id="mf_year" value="${m.year || 2024}" min="1888" max="2030" placeholder="${t("movieYearPlaceholder") || "Masalan: 2024"}"></label>
          <label>${t("movieRating")}<input type="number" id="mf_rating" value="${m.rating != null ? m.rating : ""}" min="0" max="10" step="0.1" placeholder="${t("movieRatingPlaceholder") || "Masalan: 5"}"></label>
          <div class="span2 form-field-label">${t("movieGenres")}
            <div class="plan-multiselect" id="mf_genres">
              ${state.genres.map((g) => `
                <label class="plan-chip">
                  <input type="checkbox" value="${esc(g)}" ${Array.isArray(m.genres) && m.genres.some((mg) => String(mg).trim().toLowerCase() === g.trim().toLowerCase()) ? "checked" : ""}>
                  <span>${esc(g)}</span>
                </label>`).join("") || `<span class="search-empty">${t("adminNoData")}</span>`}
            </div>
          </div>
          <label class="span2">${t("movieDuration")}<input type="text" id="mf_duration" value="${esc(m.duration || "")}" placeholder="2h 10m"></label>
          <label class="span2">${t("moviePosterUrl")}<input type="url" id="mf_posterUrl" value="${esc(m.posterUrl || "")}" placeholder="https://example.com/poster.jpg"></label>
          <div class="span2 form-field-label">${t("studioSectionPoster")}
            <div class="poster-upload-zone" id="mf_posterWrapper">
              <div class="poster-dropzone ${hasPoster ? "has-image" : ""}" id="mf_posterDropzone" role="button" tabindex="0">
                <span class="poster-preview" id="mf_posterPreview">${posterPreview}</span>
                ${hasPoster ? `<button type="button" class="poster-remove-btn" id="mf_posterDel" aria-label="${t("posterDeleteBtn")}">${icon("trash", 16)}</button>` : ""}
              </div>
              <div class="poster-native-row">
                <input type="file" id="mf_posterFile" accept="image/*" class="poster-native-input">
              </div>
              <small class="poster-hint">${t("posterUploadHint")}</small>
            </div>
          </div>
          <label class="span2">${t("movieDescription")}<textarea id="mf_desc" rows="4" placeholder="${t("movieDescriptionPlaceholder") || "Film haqida qisqacha tavsif..."}">${esc(m.description || "")}</textarea></label>
          <label>${t("movieStatus")}
            <select id="mf_status">
              <option value="active" ${(m.status || "active") === "active" ? "selected" : ""}>${t("movieStatusActive")}</option>
              <option value="inactive" ${m.status === "inactive" ? "selected" : ""}>${t("movieStatusInactive")}</option>
              <option value="hidden" ${m.status === "hidden" ? "selected" : ""}>${t("movieStatusHidden")}</option>
            </select>
          </label>
          <label class="chk-label span2">
            <input type="checkbox" id="mf_featured" ${m.featured ? "checked" : ""}>
            <span>${icon("star", 16)}${t("movieFeatured")}</span>
          </label>
          <label class="chk-label span2">
            <input type="checkbox" id="mf_isPremium" ${m.isPremium ? "checked" : ""}>
            <span>${icon("star", 16, true)} ${t("movieIsPremium")}</span>
          </label>
          <div class="span2 mf-premium-only" ${m.isPremium ? "" : 'style="display:none"'}>
            <label class="form-field-label">${t("moviePlanAssignment")}</label>
            <div class="plan-multiselect" id="mf_plans">
              ${state.planList.map((p) => `
                <label class="plan-chip">
                  <input type="checkbox" value="${esc(p.id)}" ${Array.isArray(m.planIds) && m.planIds.includes(p.id) ? "checked" : ""}>
                  <span>${esc(p.name)}</span>
                </label>`).join("") || `<span class="search-empty">${t("adminNoPlans")}</span>`}
            </div>
            <small class="poster-hint">${t("moviePlanHint")}</small>
          </div>
          <label class="chk-label span2">
            <input type="checkbox" id="mf_trending" ${m.trending ? "checked" : ""}>
            <span>${icon("zap", 16)}${t("movieTrending")}</span>
          </label>
          <label class="span2 mf-trending-only" ${m.trending ? "" : 'style="display:none"'}>${t("movieTrendingOrder")}
            <input type="number" id="mf_trendingOrder" value="${m.trendingOrder || 0}" min="0" step="1">
          </label>
          <label class="span2 mf-trending-only" ${m.trending ? "" : 'style="display:none"'}>${t("movieTrendingBanner")}
            <input type="url" id="mf_trendingBannerUrl" value="${esc(m.trendingBannerUrl || "")}" placeholder="https://...">
          </label>
        </div>
      </div>`;

    const footer = `
      <button class="btn-secondary" data-fsmodal-close>${t("cancelBtn")}</button>
      <button class="btn-primary" id="mf_save">${t(isEdit ? "saveBtn" : "addBtn")}</button>`;

    openFsModal(fsModalShell(isEdit ? t("movieFormTitleEdit") : t("movieFormTitleNew"), body, footer));

    const trendingChk = document.getElementById("mf_trending");
    if (trendingChk) {
      trendingChk.addEventListener("change", () => {
        document.querySelectorAll(".mf-trending-only").forEach((el) => {
          el.style.display = trendingChk.checked ? "" : "none";
        });
      });
    }

    // Premium checkbox -> show/hide plan assignment
    const premiumChk = document.getElementById("mf_isPremium");
    if (premiumChk) {
      premiumChk.addEventListener("change", () => {
        document.querySelectorAll(".mf-premium-only").forEach((el) => {
          el.style.display = premiumChk.checked ? "" : "none";
        });
      });
    }

    // --- Poster fayl tanlash / o'chirish ---
    const fileInput = document.getElementById("mf_posterFile");
    const previewEl = document.getElementById("mf_posterPreview");
    const wrapperEl = document.getElementById("mf_posterWrapper");
    const dropzoneEl = document.getElementById("mf_posterDropzone");
    let posterFile = null;
    let removePoster = false;
    if (dropzoneEl && fileInput) {
      dropzoneEl.addEventListener("click", (e) => {
        if (e.target.closest("#mf_posterDel")) return;
        fileInput.click();
      });
      dropzoneEl.addEventListener("keydown", (e) => {
        if (e.target.closest("#mf_posterDel")) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
      });
    }
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { toast(t("posterUploadHint")); fileInput.value = ""; return; }
        posterFile = f;
        removePoster = false;
        const reader = new FileReader();
        reader.onload = () => {
          if (previewEl) previewEl.innerHTML = `<img src="${esc(String(reader.result))}" alt="">`;
          if (wrapperEl) wrapperEl.classList.add("has-image");
          const dz = document.getElementById("mf_posterDropzone");
          if (dz) dz.classList.add("has-image");
          if (!delBtn) addRemoveBtn();
        };
        reader.readAsDataURL(f);
      });
    }
    let delBtn = document.getElementById("mf_posterDel");
    function addRemoveBtn() {
      const dz = document.getElementById("mf_posterDropzone");
      if (!dz || document.getElementById("mf_posterDel")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "mf_posterDel";
      btn.className = "poster-remove-btn";
      btn.setAttribute("aria-label", t("posterDeleteBtn"));
      btn.innerHTML = icon("trash", 16);
      dz.appendChild(btn);
      delBtn = btn;
      bindDelBtn();
    }
    function bindDelBtn() {
      if (!delBtn) return;
      delBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        posterFile = null;
        removePoster = true;
        if (fileInput) fileInput.value = "";
        if (previewEl) previewEl.innerHTML = `${icon("upload", 26)}<span>${t("posterUploadHint")}</span>`;
        if (wrapperEl) wrapperEl.classList.remove("has-image");
        const dz = document.getElementById("mf_posterDropzone");
        if (dz) dz.classList.remove("has-image");
        if (delBtn) { delBtn.remove(); delBtn = null; }
        document.getElementById("mf_posterUrl").value = "";
      });
    }
    bindDelBtn();

    document.getElementById("mf_save").addEventListener("click", async () => {
      const planIds = Array.from(document.querySelectorAll("#mf_plans input[type=checkbox]:checked")).map((el) => el.value);
      const genres = Array.from(document.querySelectorAll("#mf_genres input[type=checkbox]:checked")).map((el) => el.value);
      const data = {
        title: document.getElementById("mf_title").value.trim(),
        originalTitle: document.getElementById("mf_orig").value.trim(),
        year: Number(document.getElementById("mf_year").value),
        rating: Number(document.getElementById("mf_rating").value) || 0,
        genres,
        duration: document.getElementById("mf_duration").value.trim(),
        description: document.getElementById("mf_desc").value,
        posterUrl: document.getElementById("mf_posterUrl").value.trim(),
        status: document.getElementById("mf_status").value,
        featured: document.getElementById("mf_featured").checked,
        isPremium: document.getElementById("mf_isPremium").checked,
        planIds,
        trending: document.getElementById("mf_trending").checked,
        trendingOrder: Number(document.getElementById("mf_trendingOrder").value) || 0,
        trendingBannerUrl: document.getElementById("mf_trendingBannerUrl").value.trim(),
      };
      if (!data.title || !data.year) { toast(t("toastError")); return; }
      const saveBtn = document.getElementById("mf_save");
      const originalBtnText = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = t("savingBtn");
      const res = movie
        ? await KinoBotApi.adminUpdateMovie(state.adminKey, movie.id, data)
        : await KinoBotApi.adminCreateMovie(state.adminKey, data);
      if (!res.ok) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalBtnText;
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
        return;
      }
      const id = movie ? movie.id : (res.data && res.data.movie && res.data.movie.id);
      if (posterFile && id != null) {
        const dataUrl = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(posterFile);
        });
        if (dataUrl) {
          const pr = await KinoBotApi.adminUploadPosterWithProgress(state.adminKey, id, dataUrl, (pct) => {
            saveBtn.textContent = `${t("uploadingBtn")}... ${pct}%`;
          });
          if (!pr.ok) {
            toast(pr.error && pr.error.message ? pr.error.message : t("toastError"));
          }
        }
      } else if (removePoster && id != null) {
        await KinoBotApi.adminDeletePoster(state.adminKey, id);
      }
      saveBtn.textContent = originalBtnText;
      await refreshMovies();
      if (!isEdit) {
        // Yangi film birinchi marta yaratilganda video hali yo'q — foydalanuvchi
        // darhol video yuklashi uchun "Video manbalari" ekraniga o'tkaziladi.
        toast(t("studioMovieCreatedNowUploadVideo"));
        closeFsModal();
        const fresh = state.movies.find((x) => String(x.id) === String(id)) || { ...data, id };
        videoManageModal(fresh);
      } else {
        toast(t("toastSaved"));
        closeFsModal();
        renderAdmin();
      }
    });
  }

  // -- Admin modal: panel parolini o'zgartirish
  function adminPasswordModal() {
    const body = `
      <div class="form-grid" style="gap:16px;">
        <label class="span2" style="flex-direction:column; gap:8px;">
          <span style="display:flex; align-items:center; gap:8px;">${icon("lock", 16)} ${t("adminPasswordCurrent")}</span>
          <input type="password" id="pw_current" autocomplete="current-password" placeholder="Joriy parol" style="padding:14px 16px; font-size:15px;">
        </label>
        <label class="span2" style="flex-direction:column; gap:8px;">
          <span style="display:flex; align-items:center; gap:8px;">${icon("key", 16)} ${t("adminPasswordNew")}</span>
          <input type="password" id="pw_new" autocomplete="new-password" placeholder="Yangi parol (min 8 ta belgi)" style="padding:14px 16px; font-size:15px;">
          <div id="pw_strength" style="height:4px; background:var(--bg-elev); border-radius:2px; overflow:hidden; margin-top:4px;">
            <div id="pw_strength_bar" style="height:100%; width:0%; background:var(--danger); border-radius:2px; transition:width .2s ease, background .2s ease;"></div>
          </div>
          <small id="pw_strength_text" style="font-size:11px; color:var(--text-faint);"></small>
        </label>
        <label class="span2" style="flex-direction:column; gap:8px;">
          <span style="display:flex; align-items:center; gap:8px;">${icon("shield", 16)} ${t("adminPasswordConfirm")}</span>
          <input type="password" id="pw_confirm" autocomplete="new-password" placeholder="Yangi parolni tasdiqlang" style="padding:14px 16px; font-size:15px;">
          <small id="pw_match_text" style="font-size:11px; color:var(--text-faint);"></small>
        </label>
      </div>`;
    const footer = `
      <button class="btn-secondary" data-modal-close>${t("cancelBtn")}</button>
      <button class="btn-primary" id="pw_save" disabled>${t("saveBtn")}</button>`;
    openModal(modalShell(t("adminPassword"), body, { footer: false }) +
      `<div class="modal-footer">${footer}</div>`);

    // Real-time validation
    const newInput = document.getElementById("pw_new");
    const confirmInput = document.getElementById("pw_confirm");
    const saveBtn = document.getElementById("pw_save");
    const strengthBar = document.getElementById("pw_strength_bar");
    const strengthText = document.getElementById("pw_strength_text");
    const matchText = document.getElementById("pw_match_text");

    function checkPasswordStrength(pwd) {
      let score = 0;
      if (pwd.length >= 8) score++;
      if (pwd.length >= 12) score++;
      if (/[A-Z]/.test(pwd)) score++;
      if (/[a-z]/.test(pwd)) score++;
      if (/[0-9]/.test(pwd)) score++;
      if (/[^A-Za-z0-9]/.test(pwd)) score++;
      return Math.min(score, 5);
    }

    function updateStrengthUI(pwd) {
      if (!pwd) {
        strengthBar.style.width = "0%";
        strengthBar.style.background = "var(--danger)";
        strengthText.textContent = "";
        return;
      }
      const score = checkPasswordStrength(pwd);
      const widths = ["0%", "20%", "40%", "60%", "80%", "100%"];
      const colors = ["var(--danger)", "var(--danger)", "#f59e0b", "#eab308", "#84cc16", "#22c55e"];
      const texts = [
        "",
        t("pwStrengthVeryWeak") || "Juda zaif",
        t("pwStrengthWeak") || "Zaif",
        t("pwStrengthFair") || "O'rtacha",
        t("pwStrengthGood") || "Yaxshi",
        t("pwStrengthStrong") || "Kuchli"
      ];
      strengthBar.style.width = widths[score];
      strengthBar.style.background = colors[score];
      strengthText.textContent = texts[score];
      strengthText.style.color = colors[score];
    }

    function validateForm() {
      const current = document.getElementById("pw_current").value;
      const next = newInput.value;
      const confirm = confirmInput.value;
      const match = next && next === confirm;
      const strong = next.length >= 8 && checkPasswordStrength(next) >= 3;
      saveBtn.disabled = !(current && next && confirm && match && strong);
      if (confirm) {
        matchText.textContent = match ? (t("pwMatch") || "Parollar mos keladi") : (t("pwMismatch") || "Parollar mos kelmayapti");
        matchText.style.color = match ? "#22c55e" : "var(--danger)";
      } else {
        matchText.textContent = "";
      }
    }

    newInput.addEventListener("input", () => {
      updateStrengthUI(newInput.value);
      validateForm();
    });
    confirmInput.addEventListener("input", validateForm);
    document.getElementById("pw_current").addEventListener("input", validateForm);

    saveBtn.addEventListener("click", async () => {
      const current = document.getElementById("pw_current").value;
      const next = newInput.value;
      const confirm = confirmInput.value;
      if (next.length < 8) { toast(t("adminPasswordNew")); return; }
      if (next !== confirm) { toast(t("adminPasswordMismatch")); return; }
      const res = await KinoBotApi.adminChangePassword(state.adminKey, current, next);
      if (res.ok) {
        state.adminKey = next;
        try { localStorage.setItem("kb_admin_key", next); } catch (e) {}
        toast(t("adminPasswordSaved"));
        closeModal();
        renderAdmin();
      } else {
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
      }
    });
  }

  // -- Admin modal: bosh sahifa banneri (reklama yoki tanlangan film)
  function bannerModal() {
    const b = state.banner || {};
    const type = b.type === "ad" ? "ad" : "movie";
    const movieOptions = state.movies
      .filter((m) => m.status !== "inactive")
      .map((m) => `<option value="${esc(m.id)}" ${b.movieId === m.id ? "selected" : ""}>${esc(m.title)} (${m.year})</option>`)
      .join("");
    const hasImage = !!b.imageUrl;
    const imagePreview = hasImage
      ? `<img src="${esc(b.imageUrl)}" alt="">`
      : `${icon("upload", 26)}<span>${t("posterUploadHint")}</span>`;

    // Dizayn film qo'shish oynasi (movieFormModal) bilan bir xil, sinovdan
    // o'tgan klasslardan foydalanadi (.form-grid/.poster-upload-zone/...) —
    // avvalgi versiya mavjud bo'lmagan maxsus "banner-*" klasslarga tayanib
    // butunlay stilsiz chiqar edi.
    const body = `
      <div class="film-form-simple">
        <div class="form-grid">
          <div class="span2" style="display:flex; gap:8px;">
            <button type="button" class="admin-subtab ${type === "movie" ? "active" : ""}" style="flex:1; display:none;" data-btype="movie" hidden>${icon("film", 14)} ${t("bannerTypeMovie")}</button>
            <button type="button" class="admin-subtab active" style="flex:1;" data-btype="ad">${icon("megaphone", 14)} ${t("bannerTypeAd")}</button>
          </div>

          <label class="span2 bf-movie-only">${t("bannerMoviePick")}
            <select id="bf_movieId">${movieOptions || `<option value="">${t("bannerEmpty")}</option>`}</select>
          </label>

          <label class="span2 bf-ad-only">${t("bannerTitle")}<input type="text" id="bf_title" value="${esc(b.title || "")}" maxlength="200" placeholder="${t("bannerTitle")}"></label>
          <label class="span2 bf-ad-only">${t("bannerText")}<textarea id="bf_text" rows="2" maxlength="500" placeholder="${t("bannerText")}">${esc(b.text || "")}</textarea></label>
          <label class="span2 bf-ad-only">${t("bannerLink")}<input type="url" id="bf_link" value="${esc(b.link || "")}" placeholder="https://..." maxlength="1000"></label>

          <div class="span2 form-field-label bf-ad-only">${t("bannerImage")}
            <div class="poster-upload-zone" id="bf_imageWrapper">
              <div class="poster-dropzone ${hasImage ? "has-image" : ""}" id="bf_imageDropzone" role="button" tabindex="0">
                <span class="poster-preview" id="bf_imagePreview">${imagePreview}</span>
                ${hasImage ? `<button type="button" class="poster-remove-btn" id="bf_imageRemove" aria-label="${t("bannerImageRemove")}">${icon("trash", 16)}</button>` : ""}
              </div>
              <div class="poster-native-row">
                <input type="file" id="bf_imageFile" accept="image/*" class="poster-native-input">
              </div>
              <small class="poster-hint">${t("posterUploadHint")}</small>
            </div>
          </div>

          <label class="chk-label span2">
            <input type="checkbox" id="bf_active" ${b.active === false ? "" : "checked"}>
            <span>${t("bannerActive")}</span>
          </label>
        </div>
      </div>`;

    const footer = `
      <button class="btn-secondary" data-fsmodal-close>${t("cancelBtn")}</button>
      ${state.banner ? `<button class="btn-danger" id="bf_delete">${icon("trash", 13)} ${t("bannerRemove")}</button>` : ""}
      <button class="btn-primary" id="bf_save">${t("saveBtn")}</button>`;

    openFsModal(fsModalShell(t("bannerModalTitle"), body, footer));

    // Turga qarab maydonlarni ko'rsatish/yashirish
    // "Film" turi tugmasi yashirilgani uchun banner doim "Reklama" rejimida ochiladi.
    let currentType = "ad";
    const typeBtns = document.querySelectorAll("[data-btype]");
    const toggleFields = (isAd) => {
      document.querySelectorAll(".bf-movie-only").forEach((el) => { el.style.display = isAd ? "none" : ""; });
      document.querySelectorAll(".bf-ad-only").forEach((el) => { el.style.display = isAd ? "" : "none"; });
    };
    typeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        typeBtns.forEach((x) => x.classList.remove("active"));
        btn.classList.add("active");
        currentType = btn.dataset.btype;
        toggleFields(currentType === "ad");
      });
    });
    toggleFields(true);

    // Rasm tanlash
    const fileInput = document.getElementById("bf_imageFile");
    const dz = document.getElementById("bf_imageDropzone");
    const previewEl = document.getElementById("bf_imagePreview");
    let bannerImage = null;
    let removeImage = false;
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { toast(t("posterUploadHint")); fileInput.value = ""; return; }
        bannerImage = f;
        removeImage = false;
        const reader = new FileReader();
        reader.onload = () => {
          if (previewEl) previewEl.innerHTML = `<img src="${esc(String(reader.result))}" alt="">`;
          if (dz) dz.classList.add("has-image");
        };
        reader.readAsDataURL(f);
      });
    }
    const remBtn = document.getElementById("bf_imageRemove");
    if (remBtn) {
      remBtn.addEventListener("click", () => {
        bannerImage = null;
        removeImage = true;
        if (fileInput) fileInput.value = "";
        if (previewEl) previewEl.innerHTML = `${icon("upload", 26)}<span>${t("posterUploadHint")}</span>`;
        if (dz) dz.classList.remove("has-image");
        remBtn.remove();
      });
    }

    // O'chirish
    const delBtn = document.getElementById("bf_delete");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        const res = await KinoBotApi.adminDeleteBanner(state.adminKey);
        if (res.ok) {
          state.banner = null;
          toast(t("toastDeleted"));
          closeFsModal();
          renderBanner();
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
    }

    // Saqlash — DIQQAT: avvalgi versiyada bu yerda hech qachon e'lon
    // qilinmagan `typeSel` o'zgaruvchisi ishlatilgani uchun tugma
    // bosilganda ReferenceError bilan jimgina yiqilardi (hech narsa
    // saqlanmas edi). Endi joriy tur `currentType`dan olinadi.
    document.getElementById("bf_save").addEventListener("click", async () => {
      const isAd = currentType === "ad";
      const data = { type: isAd ? "ad" : "movie", active: document.getElementById("bf_active").checked };
      if (isAd) {
        data.title = document.getElementById("bf_title").value.trim();
        data.text = document.getElementById("bf_text").value.trim();
        data.link = document.getElementById("bf_link").value.trim();
        if (!data.title && !data.link) { toast(t("bannerEmpty")); return; }
      } else {
        data.movieId = document.getElementById("bf_movieId").value;
        if (!data.movieId) { toast(t("bannerEmpty")); return; }
      }
      if (removeImage) data.removeImage = true;
      if (bannerImage) {
        const dataUrl = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.readAsDataURL(bannerImage);
        });
        if (dataUrl) data.image = dataUrl;
      }
      const saveBtn = document.getElementById("bf_save");
      saveBtn.disabled = true;
      const res = await KinoBotApi.adminSetBanner(state.adminKey, data);
      saveBtn.disabled = false;
      if (!res.ok) {
        toast(res.error && res.error.message ? res.error.message : t("toastError"));
        return;
      }
      state.banner = res.data.banner || null;
      toast(t("toastSaved"));
      closeFsModal();
      renderBanner();
    });
  }

  // ===================== VIDEO MANAGE (R2) =====================
  const VIDEO_QUALITIES = ["360p", "480p", "720p", "1080p"];

  // R2 quality manbasini qaytaradi (mavjud bo'lmasa null).
  function videoSrcFor(movie, quality) {
    const vs = movie && movie.videoSources;
    if (!vs || typeof vs !== "object" || Array.isArray(vs)) return null;
    const s = vs[quality];
    return s && typeof s === "object" ? s : null;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  // Video manbalarini boshqarish (yuklash / o'chirish) — sifat darajalari
  // bo'yicha alohida ekran, movieFormModal'dan chaqiriladi.
  function videoManageModal(movie) {
    const vs = movie && movie.videoSources;
    const hasLegacy = vs && (
      typeof vs.url === "string" ||
      (Array.isArray(vs) && vs.length > 0)
    );
    // Selector uchun standart saqlash joyi: mavjud source'lardan birinchisining
    // storageType'i; agar hech biri aniqlanmagan bo'lsa — lokal (Kali).
    const defaultStorage = (VIDEO_QUALITIES
      .map((q) => { const s = videoSrcFor(movie, q); return s && s.storageType; })
      .find((s) => s === "r2" || s === "local")) || "local";

    const storageSel = `
      <div class="video-storage-sel" role="radiogroup" aria-label="${esc(t("videoStorageSel"))}">
        <span class="video-storage-label">${esc(t("videoStorageSel"))}</span>
        <button type="button" class="video-storage-btn ${defaultStorage === "r2" ? "active" : ""}" role="radio" aria-checked="${defaultStorage === "r2"}" data-storage="r2">${icon("cloud", 14)} ${esc(t("videoStorageR2"))}</button>
        <button type="button" class="video-storage-btn ${defaultStorage === "local" ? "active" : ""}" role="radio" aria-checked="${defaultStorage === "local"}" data-storage="local">${icon("server", 14)} ${esc(t("videoStorageLocal"))}</button>
      </div>`;

    function rowsHtmlFor(mm) {
      return VIDEO_QUALITIES.map((q) => {
        const src = videoSrcFor(mm, q);
        const meta = src
          ? (src.uploadedAt ? `${fmtBytes(src.size)} · ${fmtDateTime(src.uploadedAt)}` : fmtBytes(src.size))
          : t("videoNotUploaded");
        const badge = src && src.storageType === "r2"
          ? `<span class="video-badge r2">${icon("cloud", 11)} ${esc(t("videoStorageR2"))}</span>`
          : (src && src.storageType === "local"
            ? `<span class="video-badge local">${icon("server", 11)} ${esc(t("videoStorageLocal"))}</span>`
            : "");
        return `
          <div class="video-row" data-video-q="${q}">
            <span class="video-q">${q}</span>
            <span class="video-state ${src ? "up" : ""}">${badge}${esc(meta)}</span>
            <span class="video-actions">
              ${src
                ? `<button class="btn-danger btn-sm" data-video-del="${q}">${icon("trash", 13)} ${t("deleteBtn")}</button>`
                : `<button class="btn-primary btn-sm" data-video-up="${q}">${icon("upload", 13)} ${t("videoUploadBtn")}</button>`}
            </span>
          </div>`;
      }).join("");
    }

    const legacyNote = hasLegacy
      ? `<div class="video-legacy-note">${icon("filmStrip", 13)} ${esc(t("videoLegacyNote"))}</div>`
      : "";
    const vmBody = `
      <div class="video-manage">
        <div class="video-head"><b>${esc(movie.title)}</b> <span class="video-year">${esc(movie.year)}</span></div>
        ${storageSel}
        <div class="video-rows-list">${rowsHtmlFor(movie)}</div>
        ${legacyNote}
        <p class="video-hint">${esc(t("videoHint"))}</p>
      </div>`;
    const vmFooter = `
      <button class="btn-secondary" data-fsmodal-close>${t("cancelBtn")}</button>
      <button class="btn-primary" id="vm_done">${t("saveBtn")}</button>`;
    openFsModal(fsModalShell(t("videoManageTitle"), vmBody, vmFooter));

    document.getElementById("vm_done").addEventListener("click", async () => {
      closeFsModal();
      await refreshMovies();
      renderAdmin();
    });

    // Saqlash joyini tanlash (faqat bitta faol).
    const selBtns = document.querySelectorAll(".video-storage-btn");
    selBtns.forEach((b) => {
      b.addEventListener("click", () => {
        selBtns.forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-checked", "false"); });
        b.classList.add("active");
        b.setAttribute("aria-checked", "true");
      });
    });

    const selectedStorage = () => {
      const active = document.querySelector(".video-storage-btn.active");
      return active && active.dataset.storage ? active.dataset.storage : defaultStorage;
    };

    function bindRowButtons(mm) {
      document.querySelectorAll("[data-video-up]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "video/*";
          input.onchange = () => {
            const f = input.files && input.files[0];
            if (f) {
              startVideoUpload(mm, btn.dataset.videoUp, f, selectedStorage(), (fresh) => {
                const list = document.querySelector(".video-rows-list");
                if (list) list.innerHTML = rowsHtmlFor(fresh);
                bindRowButtons(fresh);
              });
            }
          };
          input.click();
        });
      });
      document.querySelectorAll("[data-video-del]").forEach((btn) => {
        btn.addEventListener("click", () => removeVideoSource(mm, btn.dataset.videoDel, (fresh) => {
          const list = document.querySelector(".video-rows-list");
          if (list) list.innerHTML = rowsHtmlFor(fresh);
          bindRowButtons(fresh);
        }));
      });
    }
    bindRowButtons(movie);
  }

  async function startVideoUpload(movie, quality, file, storage, onSuccess) {
    const row = document.querySelector(`[data-video-q="${quality}"]`);
    const btn = row && row.querySelector(`[data-video-up="${quality}"]`);
    const stateEl = row && row.querySelector(".video-state");
    let progressBar = row && row.querySelector(".video-progress-bar");
    // Create progress bar if not exists
    if (!progressBar && row) {
      const progressContainer = document.createElement("div");
      progressContainer.className = "video-progress";
      progressContainer.innerHTML = '<div class="video-progress-bar" style="width:0%"></div>';
      row.appendChild(progressContainer);
      progressBar = progressContainer.querySelector(".video-progress-bar");
    }
    const loading = (pct) => {
      if (stateEl) stateEl.textContent = `${t("videoUploading")} ${pct}%`;
      if (progressBar) progressBar.style.width = `${pct}%`;
    };
    if (btn) btn.disabled = true;
    loading(0);

    const presign = await KinoBotApi.adminPresignVideo(state.adminKey, movie.id, {
      quality,
      contentType: file.type || "video/mp4",
      size: file.size,
      storage,
    });
    if (!presign.ok || !presign.data || !presign.data.uploadUrl) {
      toast(presign.error && presign.error.message ? presign.error.message : t("toastError"));
      if (btn) { btn.disabled = false; stateEl.textContent = t("videoNotUploaded"); if (progressBar) progressBar.style.width = "0%"; }
      return;
    }

    const res = await KinoBotApi.uploadToR2(presign.data.uploadUrl, file, (loaded, total) => {
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      loading(pct);
    }, state.adminKey);
    if (!res.ok) {
      toast(res.message || t("toastError"));
      if (btn) { btn.disabled = false; stateEl.textContent = t("videoNotUploaded"); }
      return;
    }

    const confirm = await KinoBotApi.adminConfirmVideo(state.adminKey, movie.id, { quality, size: file.size, storage });
    if (confirm.ok) {
      toast(t("toastSaved"));
      const m = await KinoBotApi.getMovie(movie.id);
      const fresh = m.ok && m.data && m.data.movie ? m.data.movie : movie;
      if (m.ok && m.data && m.data.movie) {
        state.movies = state.movies.map((x) => (String(x.id) === String(movie.id) ? m.data.movie : x));
      }
      // Video yuklangandan keyin qaysi modal (Studio wizard yoki eski
      // videoManageModal) ochiq bo'lsa, o'sha o'z holicha yangilanadi —
      // ikkalasi bir-birini almashtirib qo'ymasligi uchun callback orqali.
      if (onSuccess) onSuccess(fresh);
      else videoManageModal(fresh);
      // Filmda poster bo'lmasa — video kadridan avtomatik poster olamiz.
      if (!fresh.posterUrl) autoExtractPoster(fresh, quality);
    } else {
      toast(confirm.error && confirm.error.message ? confirm.error.message : t("toastError"));
      if (btn) { btn.disabled = false; stateEl.textContent = t("videoNotUploaded"); }
    }
  }

  // Filmda poster bo'lmasa, videoning kadridan avtomatik poster olinadi.
  // Video yuklangach qo'zg'atiladi; modalni bloklamaydi. CORS sababli
  // kadr olinmasa — indamay o'tkazib yuboriladi (xato ko'rsatilmaydi).
  function autoExtractPoster(movie, quality) {
    return new Promise((resolve) => {
      if (!movie || !movie.id || movie.posterUrl) { resolve(false); return; }
      let video;
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { video.removeAttribute("src"); video.load(); } catch (e) {}
        resolve(ok);
      };
      try {
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.crossOrigin = "anonymous";
        video.onerror = () => done(false);
        video.onloadeddata = () => {
          if (settled) return;
          const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
          // Boshlanishi ma'lumot bilan to'lgan bo'lmasligi uchun 15% yoki 6s ichi.
          video.currentTime = Math.max(0, Math.min(dur * 0.15, 6));
        };
        video.onseeked = () => {
          if (settled) return;
          try {
            if (!video.videoWidth || !video.videoHeight) { done(false); return; }
            const W = 640;
            const H = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * W));
            const canvas = document.createElement("canvas");
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext("2d");
            if (!ctx) { done(false); return; }
            ctx.drawImage(video, 0, 0, W, H);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
            KinoBotApi.adminUploadPoster(state.adminKey, movie.id, dataUrl).then((r) => {
              if (r.ok) {
                toast(t("posterAutoExtracted"));
                const pUrl = `/api/movies/${encodeURIComponent(movie.id)}/poster`;
                state.movies = state.movies.map((x) =>
                  String(x.id) === String(movie.id) ? { ...x, posterUrl: pUrl } : x);
              }
              done(!!r.ok);
            });
          } catch (e) { done(false); }
        };
      } catch (e) { resolve(false); return; }
      KinoBotApi.getVideoUrl(movie.id, quality).then((r) => {
        if (!r.ok || !r.data || !r.data.url) { done(false); return; }
        try { video.src = r.data.url; } catch (e) { done(false); }
      });
    });
  }

  function removeVideoSource(movie, quality, onSuccess) {
    confirmModal(t("videoDeleteConfirm", { quality }), async () => {
      const res = await KinoBotApi.adminDeleteVideo(state.adminKey, movie.id, quality);
      if (res.ok) {
        toast(t("toastDeleted"));
        const m = await KinoBotApi.getMovie(movie.id);
        const fresh = m.ok && m.data && m.data.movie ? m.data.movie : movie;
        if (m.ok && m.data && m.data.movie) {
          state.movies = state.movies.map((x) => (String(x.id) === String(movie.id) ? m.data.movie : x));
        }
        if (onSuccess) onSuccess(fresh);
        else videoManageModal(fresh);
      } else toast(t("toastError"));
    });
  }

  function confirmModal(message, onYes) {
    const footer = `
      <button class="btn-secondary" data-modal-close>${t("cancelBtn")}</button>
      <button class="btn-danger" id="confirmYes">${t("deleteBtn")}</button>`;
    openModal(modalShell(t("confirmTitle"), `<p class="confirm-text">${esc(message)}</p>`, { footer: false }) +
      `<div class="modal-footer">${footer}</div>`);
    document.getElementById("confirmYes").addEventListener("click", async () => {
      closeModal();
      await onYes();
    });
  }

  async function refreshMovies() {
    const res = await KinoBotApi.getMovies();
    if (res.ok) state.movies = res.data.movies || [];
    renderHome();
  }

  // ===================== NAVIGATION =====================
  const NAV_SCREENS = ["home", "catalog", "search", "favorites", "profile"];
  const navStack = []; // { name, opts } — orqaga qaytishda ekran o'z holati (masalan detail id) bilan tiklanadi

  function openScreen(name, opts) {
    opts = opts || {};
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    const el = document.getElementById("screen-" + name);
    if (el) el.classList.add("active");

    const showNav = NAV_SCREENS.includes(name);
    document.body.classList.toggle("nav-hidden", !showNav);

    // O'yinchidan boshqa sahifaga o'tilganda videoni to'xtatamiz
    if (name !== "player" && window.KinoBotPlayer) KinoBotPlayer.pause();
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.open === name);
    });

    if (name === "home") renderHome();
    if (name === "catalog") renderCatalog(opts);
    if (name === "search") renderSearch(document.getElementById("searchInput").value);
    if (name === "favorites") renderFavorites();
    if (name === "history") renderHistory();
    if (name === "profile") renderProfile();
    if (name === "detail") renderDetail(opts.id);
    if (name === "player") renderPlayer(opts.id);
    if (name === "admin") renderAdmin();
    if (name === "filter") renderFilter();
    if (name === "premium") renderPremium();

    document.getElementById("screens").scrollTop = 0;
    const sa = el && el.querySelector(".scroll-area");
    if (sa) sa.scrollTop = 0;

    // Bir xil ekran ketma-ket push bo'lsa (masalan "O'xshash filmlar"
    // orqali detail ekranida boshqa filmga o'tilganda), stack cheksiz
    // o'smasligi uchun avvalgi yozuv yangilanadi — aks holda orqaga
    // tugmasi bir necha marta bosilmaguncha "ishlamayotganday" tuyuladi.
    if (!opts.noPush) {
      if (navStack.length && navStack[navStack.length - 1].name === name) {
        navStack[navStack.length - 1].opts = opts;
      } else {
        navStack.push({ name, opts });
      }
    }
    if (tg) {
      try {
        if (name === "home") tg.BackButton.hide();
        else tg.BackButton.show();
      } catch (e) {}
    }
  }

  function goBack() {
    if (navStack.length > 1) {
      navStack.pop();
    } else if (navStack.length === 1 && navStack[0].name !== "home") {
      // Xavfsizlik chorasi: stack'da faqat bitta (home bo'lmagan) yozuv
      // qolgan bo'lsa ham, "home"ga qaytish kafolatlanadi.
      navStack[0] = { name: "home", opts: {} };
    }
    const prevEntry = navStack[navStack.length - 1];
    openScreen(prevEntry ? prevEntry.name : "home", Object.assign({}, prevEntry && prevEntry.opts, { noPush: true }));
  }

  // ===================== FAVORITES TOGGLE (optimistik) =====================
  async function toggleFav(movieId) {
    const was = state.favorites.has(movieId);
    // Optimistik yangilash
    if (was) state.favorites.delete(movieId);
    else state.favorites.add(movieId);
    reRenderActiveList();

    const res = await KinoBotApi.toggleFavorite(movieId);
    if (!res.ok) {
      // Rollback
      if (was) state.favorites.add(movieId);
      else state.favorites.delete(movieId);
      reRenderActiveList();
      toast(t("toastError"));
      return;
    }
    toast(was ? t("toastFavRemoved") : t("toastFavAdded"));
  }

  function reRenderActiveList() {
    const active = document.querySelector(".screen.active");
    if (!active) return;
    const id = active.id;
    if (id === "screen-catalog") renderCatalog(state.catalogOpts);
    if (id === "screen-search") renderSearch(document.getElementById("searchInput").value);
    if (id === "screen-favorites") renderFavorites();
    if (id === "screen-detail" && state.currentDetailId) renderDetail(state.currentDetailId);
    if (id === "screen-player" && state.currentDetailId) renderPlayer(state.currentDetailId);
  }

  // ===================== SKELETONS =====================
  const skelPoster = (n) => Array.from({ length: n }, () => `<div class="skeleton skeleton-poster"></div>`).join("");
  const skelCard = (n) => Array.from({ length: n }, () => `<div class="skeleton skeleton-card"></div>`).join("");
  const skelChip = (n) => Array.from({ length: n }, () => `<div class="skeleton skeleton-chip"></div>`).join("");

  // ===================== EVENT DELEGATION =====================
  document.addEventListener("click", async (e) => {
    // Modal ichidagi yopish
    if (e.target.closest("[data-modal-close]")) {
      closeModal();
      return;
    }
    // Modal overlay (tashqariga bosish)
    if (e.target.id === "modalOverlay") {
      if (modalCloseHandler) modalCloseHandler();
      else closeModal();
      return;
    }
    // To'liq ekran modal ichidagi orqaga/yopish tugmasi
    if (e.target.closest("[data-fsmodal-close]")) {
      closeFsModal();
      return;
    }

    // Fav toggle
    const favEl = e.target.closest("[data-fav]");
    if (favEl) {
      e.stopPropagation();
      toggleFav(favEl.dataset.fav);
      return;
    }

    // Navigatsiya — orqaga tugmasi boshqa navigatsiya elementlaridan oldin
    // tekshiriladi (ba'zi ekranlarda back-btn boshqa bosiladigan konteyner
    // ichida joylashgan bo'lishi mumkin — masalan detail-hero).
    const backEl = e.target.closest("[data-back]");
    if (backEl) { e.stopPropagation(); goBack(); return; }

    const openEl = e.target.closest("[data-open]");
    if (openEl) {
      const name = openEl.dataset.open;
      openScreen(name, { id: openEl.dataset.id, genre: openEl.dataset.genre });
      return;
    }

    // Genre tile (catalog)
    const genreTileEl = e.target.closest(".genre-tile");
    if (genreTileEl) {
      const g = genreTileEl.dataset.genre;
      const already = genreTileEl.classList.contains("selected");
      renderCatalog({ genre: already ? null : g });
      return;
    }

    // Ommabop qidiruv
    const searchTag = e.target.closest("[data-search]");
    if (searchTag) {
      document.getElementById("searchInput").value = searchTag.dataset.search;
      state.searchQuery = searchTag.dataset.search;
      renderSearch(searchTag.dataset.search);
      return;
    }

    // Detal/player fav
    if (e.target.closest("#detailFavBtn")) {
      if (state.currentDetailId) toggleFav(state.currentDetailId);
      return;
    }
    if (e.target.closest("#playerFavBtn")) {
      if (state.currentDetailId) toggleFav(state.currentDetailId);
      return;
    }
    const qualityBtn = e.target.closest("[data-quality]");
    if (qualityBtn) {
      KinoBotPlayer.setQuality(Number(qualityBtn.dataset.quality));
      return;
    }
    // Video ustidagi play tugmasi — video to'g'ridan-to'g'ri webappning
    // o'ziga o'rnatilgan pleyerida ochiladi (botga yuborilmaydi).
    if (e.target.closest("#detailPlayBtn")) {
      const mv = state.currentDetailMovie;
      if (mv && mv.isPremium && !(state.premium && state.premium.isActive)) {
        openScreen("premium");
        return;
      }
      const movieId = state.currentDetailId;
      if (!movieId) return;
      openScreen("player", { id: movieId });
      return;
    }

    if (e.target.closest("#detailWatchBtn")) {
      const mv = state.currentDetailMovie;
      if (mv && mv.isPremium && !(state.premium && state.premium.isActive)) {
        openScreen("premium");
        return;
      }

      const movieId = state.currentDetailId;
      if (!movieId) return;

      const watchBtn = document.getElementById("detailWatchBtn");
      const watchText = document.getElementById("detailWatchBtnText");
      if (watchBtn && watchBtn.disabled) return; // so'rov allaqachon ketmoqda — qayta bosishni e'tiborsiz qoldiramiz

      const prevText = watchText ? watchText.textContent : "";
      if (watchBtn) watchBtn.disabled = true;
      if (watchText) watchText.textContent = t("sendingVideo");

      // Pleyer o'rniga: video to'g'ridan-to'g'ri storage kanaldan
      // foydalanuvchining bot bilan shaxsiy chatiga forward qilinadi
      // (R2/lokal/MTProto strimga tayanmaydi).
      const res = await KinoBotApi.deliverMovie(movieId);

      if (watchBtn) watchBtn.disabled = false;
      if (watchText) watchText.textContent = prevText;

      if (res && res.ok) {
        try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("success"); } catch (err) {}
        toast(t("videoSentToast"));
        try { if (tg) tg.close(); } catch (err) {}
      } else {
        try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred("error"); } catch (err) {}
        toast(res && res.error && res.error.message ? res.error.message : t("toastError"));
      }
      return;
    }
    if (e.target.closest("#menuBtn")) { openScreen("profile"); return; }
    if (e.target.closest("#premiumMenuItem")) { openScreen("premium"); return; }
    if (e.target.closest("#contactMenuItem") || e.target.closest("#profileContactMenuItem")) {
      showContactModal();
      return;
    }
    if (e.target.closest("#searchShortcut")) { openScreen("search"); return; }

    // Premium: paket tanlash
    const planCardEl = e.target.closest("[data-plan]");
    if (planCardEl) {
      state.premiumSelectedPlan = planCardEl.dataset.plan;
      document.querySelectorAll(".premium-plan-card").forEach((el) => {
        el.classList.toggle("active", el.dataset.plan === state.premiumSelectedPlan);
      });
      return;
    }

    // Premium: to'lovni yuborish
    if (e.target.closest("#premiumSubmitBtn")) {
      submitPremiumPurchase();
      return;
    }

    // Filtr: janr chip tanlash (bitta tanlov, qayta bossa bekor qiladi)
    const fgenreBtn = e.target.closest("#filterGenres [data-fgenre]");
    if (fgenreBtn) {
      const wasActive = fgenreBtn.classList.contains("active");
      document.querySelectorAll("#filterGenres .chip-select").forEach((b) => b.classList.remove("active"));
      if (!wasActive) fgenreBtn.classList.add("active");
      return;
    }

    // Filtr
    if (e.target.closest("#filterApplyBtn")) {
      const activeGenre = document.querySelector("#filterGenres .chip-select.active");
      const yearMin = Number(document.getElementById("yearSlider").value) || null;
      const ratingMin = Number(document.getElementById("ratingSlider").value) || null;
      openScreen("catalog", {
        filter: {
          genre: activeGenre ? activeGenre.dataset.fgenre : null,
          yearMin: yearMin > 1900 ? yearMin : null,
          ratingMin: ratingMin > 0 ? ratingMin : null,
        },
      });
      return;
    }
    if (e.target.closest("#filterClearBtn")) {
      document.querySelectorAll("#filterGenres .chip-select").forEach((b) => b.classList.remove("active"));
      document.getElementById("yearSlider").value = 1900;
      document.getElementById("ratingSlider").value = 0;
      document.getElementById("yearSliderVal").textContent = "1900";
      document.getElementById("ratingSliderVal").textContent = "0";
      return;
    }

    // Sozlamalar: til / mavzu
    const langBtn = e.target.closest("[data-lang]");
    if (langBtn) {
      lang = langBtn.dataset.lang;
      try { localStorage.setItem("kb_lang", lang); } catch (e) {}
      applyI18n();
      reRenderActiveList();
      return;
    }
    const themeBtn = e.target.closest("[data-theme-set]");
    if (themeBtn) {
      setThemePref(themeBtn.dataset.themeSet);
      return;
    }

    // Chiqish — tezda chiqadi (tasdiqlash oynasiz)
    if (e.target.closest("#logoutItem")) {
      try { if (tg) tg.close(); } catch (e) {}
      if (!tg) window.location.reload();
      return;
    }

    // Admin
    if (e.target.closest("#adminLoginBtn")) {
      const key = document.getElementById("adminKeyInput").value.trim();
      if (!key) return;
      state.adminKey = key;
      try { localStorage.setItem("kb_admin_key", key); } catch (e) {}
      renderAdmin();
      return;
    }

    const adminTab = e.target.closest(".admin-tab");
    if (adminTab) {
      document.querySelectorAll(".admin-tab").forEach((b) => b.classList.remove("active"));
      adminTab.classList.add("active");
      state.adminTab = adminTab.dataset.tab;
      renderAdmin();
      return;
    }
    if (e.target.closest("#addFilmBtn")) {
      movieFormModal(null);
      return;
    }
    if (e.target.closest("#adminPasswordBtn")) {
      adminPasswordModal();
      return;
    }
    if (e.target.closest("#adminBannerBtn")) {
      bannerModal();
      return;
    }
    // Reklama banneriga bosilganda — to'liq ma'lumot modali ochiladi.
    const bannerInfoEl = e.target.closest("[data-banner-info]");
    if (bannerInfoEl) {
      showBannerInfoModal();
      return;
    }
    // Majburiy obuna: kanal havolasi — HAR DOIM Telegram ichida ochiladi.
    // t.me havolalari uchun tg.openTelegramLink() ishlatiladi (bu Telegram
    // WebView'ni tark etib tashqi Chrome brauzerga chiqib ketishning oldini
    // oladi); boshqa havolalar uchun tg.openLink() fallback qilinadi.
    const channelLinkEl = e.target.closest("[data-channel-link]");
    if (channelLinkEl) {
      e.preventDefault();
      const url = channelLinkEl.getAttribute("data-channel-link");
      if (!url) return;
      try {
        if (tg && tg.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) {
          tg.openTelegramLink(url);
        } else if (tg && tg.openLink) {
          tg.openLink(url, { try_instant_view: false });
        } else {
          window.open(url, "_blank", "noopener");
        }
      } catch (err) {
        try { window.open(url, "_blank"); } catch (e2) {}
      }
      return;
    }

    // Modal ichidagi "Havolaga o'tish" — Telegram'da tg.openLink.
    const bannerLink = e.target.closest("[data-banner-link]");
    if (bannerLink) {
      e.preventDefault();
      const url = bannerLink.getAttribute("data-banner-link");
      if (!url) return;
      try {
        if (tg && tg.openLink) tg.openLink(url, { try_instant_view: false });
        else window.open(url, "_blank", "noopener");
      } catch (err) {
        try { window.open(url, "_blank"); } catch (e2) {}
      }
      return;
    }
    const statsPeriodBtn = e.target.closest("[data-stats-period]");
    if (statsPeriodBtn) {
      const val = statsPeriodBtn.dataset.statsPeriod;
      state.adminStatsPeriod = val === "all" ? "all" : Number(val);
      renderAdminStats(document.getElementById("adminPane"));
      return;
    }
    const videoBtn = e.target.closest("[data-admin-video]");
    if (videoBtn) {
      const m = findMovie(videoBtn.dataset.adminVideo);
      if (m) videoManageModal(m);
      return;
    }
    const editBtn = e.target.closest("[data-admin-edit]");
    if (editBtn) {
      const m = findMovie(editBtn.dataset.adminEdit);
      if (m) movieFormModal(m);
      return;
    }
    const delBtn = e.target.closest("[data-admin-delete]");
    if (delBtn) {
      const m = findMovie(delBtn.dataset.adminDelete);
      if (!m) return;
      confirmModal(t("confirmDeleteFilm"), async () => {
        const res = await KinoBotApi.adminDeleteMovie(state.adminKey, m.id);
        if (res.ok) {
          toast(t("toastDeleted"));
          await refreshMovies();
          renderAdmin();
        } else toast(t("toastError"));
      });
      return;
    }
    if (e.target.closest("#adminAddChannelBtn")) {
      const chatId = document.getElementById("adminChannelChatId").value.trim();
      const title = document.getElementById("adminChannelTitle").value.trim();
      const inviteLink = document.getElementById("adminChannelLink").value.trim();
      if (!chatId) { toast(t("adminChannelChatIdRequired")); return; }
      // Shaxsiy kanal (@username emas, -100xxxxxxxxxx) uchun havola
      // avtomatik yaratilmaydi — bo'sh qoldirilsa "obuna bo'lish" tugmasi
      // foydalanuvchiga hech narsa qilmaydigan bo'lib qoladi.
      if (!chatId.startsWith("@") && !inviteLink) {
        toast(t("adminChannelLinkRequiredPrivate"));
        return;
      }
      KinoBotApi.adminAddChannel(state.adminKey, { chatId, title, inviteLink }).then((res) => {
        if (res.ok) {
          toast(t("toastSaved"));
          renderAdminChannels(document.getElementById("adminPane"));
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
      return;
    }
    const playStorageBtn = e.target.closest("[data-admin-storage-play]");
    if (playStorageBtn) {
      const id = playStorageBtn.dataset.adminStoragePlay;
      KinoBotApi.adminStorageVideoStreamUrl(state.adminKey, id).then((res) => {
        if (res.ok && res.data.url) {
          openPlayerWithUrl(res.data.url, res.data.title || "");
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
      return;
    }
    const delStorageBtn = e.target.closest("[data-admin-storage-del]");
    if (delStorageBtn) {
      const id = delStorageBtn.dataset.adminStorageDel;
      confirmModal(t("confirmDeleteChannel"), async () => {
        const res = await KinoBotApi.adminDeleteStorageVideo(state.adminKey, id);
        if (res.ok) {
          toast(t("toastDeleted"));
          renderAdminStorageVideos(document.getElementById("adminPane"));
        } else toast(res.error && res.error.message ? res.error.message : t("toastError"));
      });
      return;
    }
    const delChannelBtn = e.target.closest("[data-admin-delchannel]");
    if (delChannelBtn) {
      const id = delChannelBtn.dataset.adminDelchannel;
      confirmModal(t("confirmDeleteChannel"), async () => {
        const res = await KinoBotApi.adminDeleteChannel(state.adminKey, id);
        if (res.ok) {
          toast(t("toastDeleted"));
          renderAdminChannels(document.getElementById("adminPane"));
        } else toast(t("toastError"));
      });
      return;
    }

    // -- Admin: film status filtri
    const filmFilter = e.target.closest("[data-film-filter]");
    if (filmFilter) {
      state.adminFilmsFilter = filmFilter.dataset.filmFilter;
      renderAdminFilms(document.getElementById("adminPane"));
      return;
    }

    // -- Admin: to'lov status filtri
    const paymentFilter = e.target.closest("[data-payment-filter]");
    if (paymentFilter) {
      state.adminPaymentsFilter = paymentFilter.dataset.paymentFilter;
      renderAdminPayments(adminPremiumSubPane());
      return;
    }

    // -- Admin: Premium bo'limi ichidagi sub-tab (To'lovlar / To'lov sozlamalari)
    const premiumSubTab = e.target.closest("[data-premium-tab]");
    if (premiumSubTab) {
      state.adminPremiumTab = premiumSubTab.dataset.premiumTab;
      renderAdminPremium(document.getElementById("adminPane"));
      return;
    }

    // -- Admin: to'lov detalini ko'rish (chek rasmi)
    const paymentViewBtn = e.target.closest("[data-payment-view]");
    if (paymentViewBtn) {
      paymentDetailModal(paymentViewBtn.dataset.paymentView);
      return;
    }

    // -- Admin: chek rasmini yuklab olish (Telegram WebView'da data-URL + <a download>
    // ishlamasligi mumkin, shuning uchun Blob orqali yuklaymiz)
    const downloadCheckBtn = e.target.closest("[data-download-check]");
    if (downloadCheckBtn) {
      downloadCheckImage(downloadCheckBtn.dataset.checkImage, downloadCheckBtn.dataset.checkFilename);
      return;
    }

    // -- Admin: to'lovni tasdiqlash
    const paymentApproveBtn = e.target.closest("[data-payment-approve]");
    if (paymentApproveBtn) {
      approvePaymentAction(paymentApproveBtn.dataset.paymentApprove);
      return;
    }

    // -- Admin: to'lovni rad etish
    const paymentRejectBtn = e.target.closest("[data-payment-reject]");
    if (paymentRejectBtn) {
      rejectPaymentAction(paymentRejectBtn.dataset.paymentReject);
      return;
    }

    // -- Admin: user management --
    // Status filtri (Barchasi / Faol / Bloklangan)
    const userFilter = e.target.closest("[data-user-filter]");
    if (userFilter) {
      state.adminUsersFilter = userFilter.dataset.userFilter;
      renderAdminUsers(document.getElementById("adminPane"));
      return;
    }
    // Qidiruv (debounce 300ms)
    if (e.target.closest("#adminUserSearch")) {
      clearTimeout(state.adminUsersTimer);
      state.adminUsersTimer = setTimeout(() => {
        state.adminUsersQuery = e.target.value.trim();
        renderAdminUsers(document.getElementById("adminPane"));
      }, 300);
      return;
    }
    // Statistika ko'rinishi
    const statsBtn = e.target.closest("[data-user-stats]");
    if (statsBtn) {
      userDetailModal(statsBtn.dataset.userStats);
      return;
    }
    // isAdmin holatini toggle qilish
    const adminBtn = e.target.closest("[data-user-admin]");
    if (adminBtn) {
      const id = adminBtn.dataset.userAdmin;
      const row = adminBtn.closest(".admin-user-row");
      const wasAdmin = row ? row.querySelector(".admin-admin-btn").classList.contains("on") : false;
      KinoBotApi.adminUpdateUser(state.adminKey, id, { isAdmin: !wasAdmin }).then((res) => {
        if (res.ok) {
          toast(t("adminRoleUpdatedToast"));
          renderAdminUsers(document.getElementById("adminPane"));
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
      return;
    }
    // Block / Unblock
    const toggleBtn = e.target.closest("[data-user-toggle]");
    if (toggleBtn) {
      const id = toggleBtn.dataset.userToggle;
      const row = toggleBtn.closest(".admin-user-row");
      const isBlocked = row ? row.querySelector(".user-status-badge").classList.contains("blocked") : false;
      const action = isBlocked
        ? KinoBotApi.adminUnblockUser(state.adminKey, id)
        : KinoBotApi.adminBlockUser(state.adminKey, id);
      action.then((res) => {
        if (res.ok) {
          toast(isBlocked ? t("userUnblockedToast") : t("userBlockedToast"));
          renderAdminUsers(document.getElementById("adminPane"));
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
      return;
    }

    // Aloqa xabari — "o'qilgan" deb belgilash
    const contactReadBtn = e.target.closest("[data-contact-read]");
    if (contactReadBtn) {
      const id = contactReadBtn.dataset.contactRead;
      KinoBotApi.adminContactMarkRead(state.adminKey, id).then((res) => {
        if (res.ok) renderAdminContact(document.getElementById("adminPane"));
        else toast(res.error && res.error.message ? res.error.message : t("toastError"));
      });
      return;
    }

    // Aloqa xabari — foydalanuvchini faqat shu formadan bloklash/blokdan chiqarish
    const contactBlockBtn = e.target.closest("[data-contact-toggle-block]");
    if (contactBlockBtn) {
      const uid = contactBlockBtn.dataset.contactToggleBlock;
      const row = contactBlockBtn.closest(".admin-contact-row");
      const isBlocked = row ? row.querySelector("[data-contact-toggle-block]").classList.contains("admin-unblock-btn") : false;
      const action = isBlocked
        ? KinoBotApi.adminContactUnblockUser(state.adminKey, uid)
        : KinoBotApi.adminContactBlockUser(state.adminKey, uid);
      action.then((res) => {
        if (res.ok) {
          toast(isBlocked ? t("userUnblockedToast") : t("contactUserBlockedToast"));
          renderAdminContact(document.getElementById("adminPane"));
        } else {
          toast(res.error && res.error.message ? res.error.message : t("toastError"));
        }
      });
      return;
    }
  });

  // ===================== SEARCH INPUT (debounce 300ms) =====================
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderSearch(e.target.value);
    });
  }

  // ===================== PREMIUM CHECK FILE INPUT =====================
  bindPremiumCheckInput();

  // ===================== FILTER SLIDERS (live label) =====================
  const yearSliderEl = document.getElementById("yearSlider");
  if (yearSliderEl) {
    yearSliderEl.addEventListener("input", (e) => {
      document.getElementById("yearSliderVal").textContent = e.target.value;
    });
  }
  const ratingSliderEl = document.getElementById("ratingSlider");
  if (ratingSliderEl) {
    ratingSliderEl.addEventListener("input", (e) => {
      document.getElementById("ratingSliderVal").textContent = e.target.value;
    });
  }

  // ===================== BLOCKED SCREEN =====================
  // api.js 403 FORBIDDEN qaytarganda "kinobot:blocked" hodisasini yuboradi.
  // Bu yerda to'liq ekranli bloklangan sahifasi ko'rsatiladi va barcha UI to'xtatiladi.
  function showBlockedScreen() {
    const overlay = document.getElementById("blockedOverlay");
    if (!overlay) return;
    overlay.hidden = false;
    // To'liq ekranli xabarda i18n matnlarini qo'llaymiz.
    overlay.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    // O'yinchi/pulik ishlash davom etmasligi uchun videoni to'xtatamiz.
    try {
      const v = document.querySelector("#playerVideo, video");
      if (v && typeof v.pause === "function") v.pause();
    } catch (e) {}
    // Telegram da tizim orqasiga qaytish tugmasini yashirish.
    try { if (tg && tg.BackButton && tg.BackButton.hide) tg.BackButton.hide(); } catch (e) {}
  }
  // api.js'da block aniqlanganda darhol ishga tushadi.
  window.addEventListener("kinobot:blocked", showBlockedScreen);

  // ===================== GLOBAL ERROR HANDLING (PHASE 11) =====================
  function showErrorScreen(message) {
    const overlay = document.getElementById("screen-info");
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="info-card">
        <div class="info-icon">${icon("alert", 32)}</div>
        <h2 class="info-title">${esc(t("blockedTitle"))}</h2>
        <p class="info-desc">${esc(message)}</p>
        <button class="btn btn-primary" onclick="location.reload()">${icon("download", 16)} ${esc(t("toastSaved"))} / Qayta yuklash</button>
      </div>
    `;
    overlay.hidden = false;
    try {
      const v = document.querySelector("#playerVideo, video");
      if (v && typeof v.pause === "function") v.pause();
    } catch (e) {}
    try { if (tg && tg.BackButton && tg.BackButton.hide) tg.BackButton.hide(); } catch (e) {}
  }

  // Global xatolik ushlash
  window.onerror = function (msg, url, line, col, error) {
    const message = error && error.message ? error.message : String(msg);
    console.error("[Global Error]", { message, url, line, col, stack: error?.stack });
    showErrorScreen(`Xatolik: ${message}`);
    return true; // Prevent default browser handler
  };

  window.addEventListener("unhandledrejection", function (event) {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    console.error("[Unhandled Rejection]", { reason, stack: event.reason?.stack });
    showErrorScreen(`Kutilmagan xatolik: ${reason}`);
    event.preventDefault(); // Prevent default browser handler
  });

  // ===================== OFFLINE/ONLINE DETECTION (PHASE 11) =====================
  function onOffline() {
    console.warn("[Network] Offline");
    toast(t("offlineToast") || "Internet ulanishi yo'q");
  }
  function onOnline() {
    console.log("[Network] Online");
    toast(t("onlineToast") || "Internet ulanishi tiklandi");
    // Ma'lumotlarni qayta yuklash imkoniyati
    if (state.movies.length === 0) {
      loadData().then(() => { renderHome(); renderFavorites(); });
    }
  }
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);

  // ===================== INIT =====================
  async function init() {
    applyTheme();
    applyI18n();
    // Player modulini video element bilan bog'laymiz
    if (window.KinoBotPlayer) {
      KinoBotPlayer.init(document.getElementById("playerEl"), document.getElementById("playerQuality"));
    }

    // Majburiy obuna: kanallar bo'lsa va foydalanuvchi ularga obuna
    // bo'lmagan bo'lsa, ilovaning qolgan qismi ochilmasdan turib
    // to'liq ekranli obuna ekrani ko'rsatiladi.
    const subscribed = await ensureSubscribed();
    if (!subscribed) return; // continueInit() obuna tasdiqlanganda chaqiriladi

    await continueInit();
  }

  async function continueInit() {
    await loadData();

    // Ma'lumot yo'q bo'lsa (backend mavjud emas) — toza xabar
    if (!state.movies.length) {
      document.getElementById("trendingRow").innerHTML =
        `<p class="search-empty">${esc(t("errorLoad"))}</p>`;
    }

    renderHome();
    renderFavorites();

    if (tg && tg.BackButton) tg.BackButton.onClick(() => goBack());

    // #admin hash orqali admin panelga o'tish
    if (location.hash === "#admin") openScreen("admin", { noPush: true });
    // "home" ilova ishga tushganda navStack'ga PUSH QILINISHI SHART —
    // aks holda navStack uzunligi 1 dan boshlanadi va goBack() birinchi
    // navigatsiyadan keyin hech narsa qilmaydi (stack "pop" qiladigan
    // ortiqcha yozuvga ega bo'lmaydi).
    else openScreen("home");
  }

  // Majburiy obuna kanallarini tekshiradi. Kanal umuman qo'shilmagan bo'lsa
  // (yoki tekshiruv so'rovi o'zi ishlamasa — masalan backend mavjud emas)
  // ilova odatdagidek ochiladi. Faqat backend aniq "obuna yo'q" deb
  // javob berganda gate ekrani ko'rsatiladi.
  async function ensureSubscribed() {
    const reqRes = await KinoBotApi.getRequiredChannels();
    const channels = reqRes.ok ? (reqRes.data.channels || []) : [];
    if (!channels.length) return true;

    const checkRes = await KinoBotApi.checkChannelSubscription();
    if (!checkRes.ok) return true; // tekshirish ishlamasa — ilovani bloklamaymiz
    if (checkRes.data.subscribed) return true;

    showSubscribeOverlay(checkRes.data.missing.length ? checkRes.data.missing : channels);
    return false;
  }

  // DIQQAT: target="_blank" bilan oddiy <a> ishlatilmaydi — Telegram WebView
  // ichida bu tashqi Chrome brauzerga "chiqib ketish"ga olib kelardi.
  // Havola endi data-channel-link orqali delegated click handlerda
  // tg.openTelegramLink() bilan Telegram ICHIDA ochiladi.
  function renderSubscribeChannelList(channels) {
    const list = document.getElementById("subscribeChannelList");
    if (!list) return;
    list.innerHTML = channels.map((c) => `
      <a class="subscribe-channel-btn" href="${esc(c.inviteLink || "#")}" data-channel-link="${esc(c.inviteLink || "")}" rel="noopener">
        ${icon("link", 16)} ${esc(c.title)}
      </a>`).join("");
  }

  // Obuna oynasi ochiq turganda fonda a'zolikni kuzatib boradi: foydalanuvchi
  // kanalga obuna bo'lib ilovaga qaytganda "Tekshirish"ni bosmasdan ham oyna
  // O'ZI yo'qolishi kerak. Telegram WebView'da kanalga o'tib-qaytganda
  // visibilitychange hodisasi har doim ham ishlamagani uchun qisqa interval
  // bilan ham tekshiriladi.
  const SUBSCRIBE_POLL_MS = 3000;
  let subscribePollTimer = null;
  let subscribeChecking = false;   // parallel so'rovlarning oldini oladi
  let subscribeResolved = false;   // continueInit() faqat bir marta chaqiriladi

  function onSubscribeWindowActive() {
    if (document.hidden) return;
    runSubscribeCheck({ silent: true });
  }

  function startSubscribeWatcher() {
    stopSubscribeWatcher();
    subscribePollTimer = setInterval(() => {
      if (!document.hidden) runSubscribeCheck({ silent: true });
    }, SUBSCRIBE_POLL_MS);
    document.addEventListener("visibilitychange", onSubscribeWindowActive);
    window.addEventListener("focus", onSubscribeWindowActive);
    window.addEventListener("pageshow", onSubscribeWindowActive);
  }

  function stopSubscribeWatcher() {
    if (subscribePollTimer) {
      clearInterval(subscribePollTimer);
      subscribePollTimer = null;
    }
    document.removeEventListener("visibilitychange", onSubscribeWindowActive);
    window.removeEventListener("focus", onSubscribeWindowActive);
    window.removeEventListener("pageshow", onSubscribeWindowActive);
  }

  // silent=true — fon tekshiruvi: muvaffaqiyatsiz bo'lsa xato yozuvi
  // ko'rsatilmaydi (foydalanuvchi hech narsa bosmagan).
  async function runSubscribeCheck({ silent } = {}) {
    const overlay = document.getElementById("subscribeOverlay");
    if (!overlay || overlay.hidden || subscribeChecking) return false;

    const checkBtn = document.getElementById("subscribeCheckBtn");
    const hint = document.getElementById("subscribeRecheckHint");

    subscribeChecking = true;
    if (!silent && checkBtn) checkBtn.disabled = true;
    const res = await KinoBotApi.checkChannelSubscription();
    subscribeChecking = false;
    if (!silent && checkBtn) checkBtn.disabled = false;

    if (res.ok && res.data && res.data.subscribed) {
      stopSubscribeWatcher();
      overlay.hidden = true;
      if (hint) hint.classList.remove("show");
      if (!subscribeResolved) {
        subscribeResolved = true;
        continueInit();
      }
      return true;
    }

    if (!silent) {
      if (hint) hint.classList.add("show");
      if (res.ok && res.data && Array.isArray(res.data.missing) && res.data.missing.length) {
        renderSubscribeChannelList(res.data.missing);
      }
    }
    return false;
  }

  function showSubscribeOverlay(missingChannels) {
    const overlay = document.getElementById("subscribeOverlay");
    if (!overlay) return;
    overlay.hidden = false;
    overlay.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    renderSubscribeChannelList(missingChannels);

    const checkBtn = document.getElementById("subscribeCheckBtn");
    if (checkBtn) checkBtn.onclick = () => runSubscribeCheck({ silent: false });

    startSubscribeWatcher();
  }

  // Telegram ma'lumotlari tayyor bo'lguncha kutish
  if (tg) {
    try {
      if (tg.ready) tg.ready();
    } catch (e) {}
  }
  init();

  // player.js moduli ishlatadigan umumiy yordamchilar.
  window.KinoBotEsc = esc;
  window.KinoBotIcon = icon;
  window.KinoBotT = t;
})();
