// SQLite storage. Everything the app needs to survive a restart lives here.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// The installed app sets WAPZAP_DATA_DIR (to ~/.local/share/wapzap); when run
// from the project folder with "npm start" it falls back to ./data.
export const DATA_DIR = process.env.WAPZAP_DATA_DIR || path.join(import.meta.dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'wapzap.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    message      TEXT NOT NULL,
    daily_limit  INTEGER NOT NULL DEFAULT 50,
    window_start TEXT NOT NULL DEFAULT '09:00',
    window_end   TEXT NOT NULL DEFAULT '18:00',
    start_date   TEXT NOT NULL,
    delay_min    INTEGER NOT NULL DEFAULT 30,
    delay_max    INTEGER NOT NULL DEFAULT 90,
    status       TEXT NOT NULL DEFAULT 'running',  -- running | paused | completed
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    number      TEXT NOT NULL,                     -- digits only, international, no "+"
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed
    error       TEXT,
    sent_at     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts (campaign_id, status);

  -- Attachments (photo, video, voice message, document). Files live in data/media.
  CREATE TABLE IF NOT EXISTS media (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,      -- image | video | voice | document
    mime       TEXT NOT NULL,
    name       TEXT NOT NULL,      -- original file name, shown to the user
    file       TEXT NOT NULL,      -- file name inside data/media
    size       INTEGER NOT NULL,
    duration   INTEGER,            -- seconds, voice messages only
    waveform   TEXT,               -- base64, voice messages only
    created_at INTEGER NOT NULL
  );

  -- Google Maps scraper: one row per search, one row per business found.
  CREATE TABLE IF NOT EXISTS scrapes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    query       TEXT NOT NULL,
    max_results INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',  -- running | done | stopped | failed
    stage       TEXT,                             -- what it is doing right now
    error       TEXT,
    found       INTEGER NOT NULL DEFAULT 0,       -- places in the result list
    processed   INTEGER NOT NULL DEFAULT 0,       -- places whose details were read
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS places (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    scrape_id INTEGER NOT NULL REFERENCES scrapes(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    phone_raw TEXT,              -- as shown on Google Maps
    number    TEXT,              -- international digits, NULL if missing or invalid
    display   TEXT,
    mobile    INTEGER NOT NULL DEFAULT 0,
    category  TEXT,
    address   TEXT,
    rating    TEXT,
    website   TEXT,
    maps_url  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_places_scrape ON places (scrape_id);
`);

// A search that was running when the app stopped cannot be continued.
db.prepare(
  `UPDATE scrapes SET status = 'stopped', stage = NULL, finished_at = ?,
     error = 'The app was closed before this search finished'
   WHERE status = 'running'`
).run(Date.now());

// Linked WhatsApp accounts. The login files live in data/accounts/<id>.
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    number     TEXT,               -- last number this account connected as
    created_at INTEGER NOT NULL
  );
`);
if (!db.prepare('PRAGMA table_info(campaigns)').all().some((col) => col.name === 'account_id')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN account_id INTEGER'); // filled in by whatsapp.init()
}

// Upgrade databases created before attachments existed.
if (!db.prepare('PRAGMA table_info(campaigns)').all().some((col) => col.name === 'media_id')) {
  db.exec('ALTER TABLE campaigns ADD COLUMN media_id TEXT');
}

// A contact left in "sending" means the app stopped in the middle of a send.
// We can't know whether WhatsApp delivered it, so we do NOT resend automatically.
db.prepare(
  `UPDATE contacts SET status = 'failed',
     error = 'App stopped while sending - check the chat before retrying'
   WHERE status = 'sending'`
).run();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
