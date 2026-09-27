const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kinobot-telegram-backup-"));
process.env.DATABASE_PATH = path.join(root, "db.json");
process.env.BOT_TOKEN = "test-token-not-real";
process.env.ADMIN_ID = "42";
process.env.BACKUP_CHANNEL_ID = "-100123";
process.env.TELEGRAM_BACKUP_ENABLED = "1";
const db = require("../src/db");
const backup = require("../src/telegramBackup");
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/seed-db.json")));
const originalFetch = global.fetch;
const originalNow = Date.now;
let calls, remoteFile, failSend;
function fixture() {
  return { format: "kinobot-backup", version: 1, createdAt: "2026-09-27T04:00:00.000Z", database: structuredClone(seed), assets: {} };
}
beforeEach(() => {
  Date.now = originalNow;
  db.replaceDatabase(structuredClone(seed));
  calls = []; failSend = false; remoteFile = backup.encode(fixture());
  global.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body instanceof FormData ? opts.body : JSON.parse(opts?.body || "{}") });
    if (url.includes("/file/bot")) return new Response(remoteFile);
    const method = url.split("/").at(-1);
    if (method === "sendDocument" && failSend) return Response.json({ ok: false, error_code: 500 }, { status: 500 });
    const result = method === "getFile" ? { file_path: "documents/test.kbak", file_size: remoteFile.length }
      : method === "sendDocument" ? { message_id: 101, document: { file_id: "backup-101" } } : true;
    return Response.json({ ok: true, result });
  };
});
after(() => { global.fetch = originalFetch; Date.now = originalNow; fs.rmSync(root, { recursive: true, force: true }); });
test("schedule: exactly 09:00 / 21:00 Tashkent, including midnight", () => {
  for (const [now, expected] of [
    ["2026-09-27T03:59:59Z", "2026-09-26T16:00:00Z"],
    ["2026-09-27T04:00:00Z", "2026-09-27T04:00:00Z"],
    ["2026-09-27T15:59:59Z", "2026-09-27T04:00:00Z"],
    ["2026-09-27T16:00:00Z", "2026-09-27T16:00:00Z"],
    ["2026-09-28T00:00:00Z", "2026-09-27T16:00:00Z"],
  ]) assert.equal(backup.slotAt(Date.parse(now)), Date.parse(expected));
});
test("encrypted snapshot round-trips; tampering and wrong keys rejected", () => {
  const value = fixture(); const encrypted = backup.encode(value);
  assert.deepEqual(backup.decode(encrypted), value);
  assert.ok(!encrypted.includes(Buffer.from('"users"')));
  const bad = Buffer.from(encrypted); bad[bad.length - 1] ^= 1;
  assert.throws(() => backup.decode(bad));
  process.env.BACKUP_ENCRYPTION_KEY = "wrong-key";
  assert.throws(() => backup.decode(encrypted));
  delete process.env.BACKUP_ENCRYPTION_KEY;
});
test("bad schemas and path traversal are rejected before restore", () => {
  const value = fixture(); value.database.movies = {};
  assert.throws(() => backup.decode(backup.encode(value)), /movies/);
  const other = fixture(); other.assets["../../.env"] = "YQ==";
  assert.throws(() => backup.decode(backup.encode(other)), /Rasm/);
  assert.throws(() => backup.decode(Buffer.from("not-a-backup")), /formati/);
});
test("startup never fetches or restores remote data, even after disk loss", async () => {
  fs.unlinkSync(db.getDbPath());
  await backup.initializeLocal();
  assert.equal(calls.length, 0);
  assert.equal(db.load().movies.length, 0);
  assert.ok(fs.existsSync(db.getDbPath()));
});
test("new startup waits until next slot; send succeeds once per slot", async () => {
  let now = Date.parse("2026-09-27T04:30:00Z"); Date.now = () => now;
  await backup.initializeLocal(); await backup.tick(now);
  assert.equal(calls.length, 0);
  now = Date.parse("2026-09-27T16:01:00Z");
  await backup.tick(now); await backup.tick(now + 60000);
  assert.equal(calls.filter(x => x.url.endsWith("/sendDocument")).length, 1);
  assert.ok(!calls.some(x => /getChat|pinChatMessage/.test(x.url)));
});
test("every manual backup is a new upload; failure does not mark successful", async () => {
  await backup.handleAdminMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "💾 Backup yaratish" });
  await backup.sendBackup();
  assert.equal(calls.filter(x => x.url.endsWith("/sendDocument")).length, 2);
  const old = structuredClone(db.load().settings.telegramBackup);
  failSend = true;
  await assert.rejects(backup.sendBackup(), /sendDocument/);
  assert.deepEqual(db.load().settings.telegramBackup, old);
});
test("restore applies data and images; saves pre-restore copy and removes stale image variants", () => {
  fs.mkdirSync(path.join(root, "banner"), { recursive: true });
  fs.writeFileSync(path.join(root, "banner/image.jpg"), "old");
  const value = fixture(); value.database.movies = [];
  value.assets["banner/image.png"] = Buffer.from("new").toString("base64");
  backup.applySnapshot(value);
  assert.equal(db.load().movies.length, 0);
  assert.equal(fs.readFileSync(path.join(root, "banner/image.png"), "utf8"), "new");
  assert.ok(!fs.existsSync(path.join(root, "banner/image.jpg")));
  assert.ok(fs.readdirSync(path.join(root, "backups")).some(x => x.endsWith(".kbak")));
});
test("unauthorized users and group chats cannot upload or restore", async () => {
  for (const msg of [
    { chat: { id: 7, type: "private" }, from: { id: 7 }, text: "/backup" },
    { chat: { id: 7, type: "private" }, from: { id: 7 }, text: "💾 Backup yaratish" },
    { chat: { id: 7, type: "private" }, from: { id: 7 }, text: "♻️ Backupni qayta tiklash" },
    { chat: { id: 7, type: "private" }, from: { id: 7 }, document: { file_name: "test.kbak", file_id: "x" } },
    { chat: { id: -7, type: "group" }, from: { id: 42 }, text: "/restore" },
  ]) assert.equal(await backup.handleAdminMessage(msg), true);
  assert.equal(calls.length, 0);
});
test("admin forwarding only previews; nonce confirmation performs manual restore", async () => {
  const value = fixture(); value.database.movies = []; remoteFile = backup.encode(value);
  const msg = { chat: { id: 42, type: "private" }, from: { id: 42 }, document: { file_name: "kinobot-test.kbak", file_id: "x" } };
  const before = db.load().movies.length; assert.ok(before > 0);
  await backup.handleAdminMessage(msg);
  assert.equal(db.load().movies.length, before);
  const preview = calls.find(x => x.body.text?.includes("/restore_confirm")).body.text;
  const nonce = preview.match(/\/restore_confirm ([a-f0-9]+)/)[1];
  await backup.handleAdminMessage({ ...msg, document: undefined, text: "/restore_confirm wrong" });
  assert.equal(db.load().movies.length, before);
  await backup.handleAdminMessage({ ...msg, document: undefined, text: `/restore_confirm ${nonce}` });
  assert.equal(db.load().movies.length, 0);
});
test("restore without a file only gives instructions; no channel history or automatic restore", async () => {
  await backup.handleAdminMessage({ chat: { id: 42, type: "private" }, from: { id: 42 }, text: "♻️ Backupni qayta tiklash" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.text.includes("forward"));
});
test("a failed database replacement rolls image changes back and keeps the old database", () => {
  const before = fs.readFileSync(db.getDbPath(), "utf8");
  fs.mkdirSync(path.join(root, "banner"), { recursive: true });
  fs.writeFileSync(path.join(root, "banner/image.jpg"), "original");
  const value = fixture(); value.assets["banner/image.jpg"] = Buffer.from("replacement").toString("base64");
  const rename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (dest === db.getDbPath()) throw new Error("disk write failed");
    return rename(src, dest);
  };
  try { assert.throws(() => backup.applySnapshot(value), /disk write/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(db.getDbPath(), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(root, "banner/image.jpg"), "utf8"), "original");
});
test("corrupt local file is retained, never causes an automatic remote restore", async () => {
  fs.writeFileSync(db.getDbPath(), "broken");
  await backup.initializeLocal();
  assert.equal(calls.length, 0);
  assert.equal(db.load().movies.length, 0);
  assert.ok(fs.readdirSync(root).some(x => x.startsWith("db.json.corrupt-")));
});
