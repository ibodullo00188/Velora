// src/repositories/index.js
// Barcha repository'lar bitta nuqtadan export qilinadi.
// server.js faqat shu modul orqali DB bilan ishlaydi.
//
// server.js → repositories → db (JSON file)
//
// SQLite/PostgreSQL'ga o'tishda har bir repository implementatsiyasi
// almashtiriladi — server.js o'zgarmaydi.

const usersRepository = require("./usersRepository");
const moviesRepository = require("./moviesRepository");
const favoritesRepository = require("./favoritesRepository");
const historyRepository = require("./historyRepository");
const genresRepository = require("./genresRepository");
const analyticsRepository = require("./analyticsRepository");
const settingsRepository = require("./settingsRepository");
const paymentsRepository = require("./paymentsRepository");
const premiumRepository = require("./premiumRepository");
const plansRepository = require("./plansRepository");
const contactRepository = require("./contactRepository");
const channelsRepository = require("./channelsRepository");

module.exports = {
  users: usersRepository,
  movies: moviesRepository,
  favorites: favoritesRepository,
  history: historyRepository,
  genres: genresRepository,
  analytics: analyticsRepository,
  settings: settingsRepository,
  payments: paymentsRepository,
  premium: premiumRepository,
  plans: plansRepository,
  contact: contactRepository,
  channels: channelsRepository,
};
