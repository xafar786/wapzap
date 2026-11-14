// WhatsApp connections (Baileys). Several WhatsApp accounts can be linked at
// once; each has its own saved login in data/accounts/<id>, so a QR code only
// has to be scanned once per account.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  Browsers,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const LEGACY_AUTH_DIR = path.join(DATA_DIR, 'auth'); // where the single account used to live
export const MAX_ACCOUNTS = 10;
const logger = pino({ level: 'silent' });

const authDir = (id) => path.join(ACCOUNTS_DIR, String(id));

// Live state per account id.
const sessions = new Map();

function session(id) {
  id = Number(id);
  let s = sessions.get(id);
  if (!s) {
    s = {
      sock: null,
      generation: 0, // ignores events from sockets we have already replaced
      timer: null,
      status: { state: 'connecting', qr: null, me: null, lastError: null },
    };
    sessions.set(id, s);
  }
  return s;
}

// ---------- accounts ----------

export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id)) || null;
}

// Every account with its live connection state.
// state: connecting | qr | connected. qr is a data: URL while state === 'qr'.
export function listAccounts() {
  return db
    .prepare('SELECT * FROM accounts ORDER BY id')
    .all()
    .map((a) => ({ ...a, ...session(a.id).status }));
}

export function createAccount(label) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  if (count >= MAX_ACCOUNTS) throw new Error(`You can link at most ${MAX_ACCOUNTS} WhatsApp accounts.`);
  const name = String(label ?? '').trim().slice(0, 40) || `Account ${count + 1}`;
  const id = Number(
    db.prepare('INSERT INTO accounts (label, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid
  );
  connect(id).catch((err) => onConnectError(id, err));
  return id;
}

export function renameAccount(id, label) {
  const name = String(label ?? '').trim().slice(0, 40);
  if (!name) throw new Error('The account name cannot be empty.');
  db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(name, Number(id));
}

// Called once at startup.
export function init() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

  // Upgrade from the single-account version: its login becomes the first account.
  if (fs.existsSync(LEGACY_AUTH_DIR)) {
    const hasAccounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n > 0;
    if (!hasAccounts && fs.existsSync(path.join(LEGACY_AUTH_DIR, 'creds.json'))) {
      const id = Number(
        db.prepare('INSERT INTO accounts (label, created_at) VALUES (?, ?)').run('Account 1', Date.now()).lastInsertRowid
      );
      fs.renameSync(LEGACY_AUTH_DIR, authDir(id));
    } else {
      fs.rmSync(LEGACY_AUTH_DIR, { recursive: true, force: true });
    }
  }

  let accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all();
  if (!accounts.length) {
    db.prepare('INSERT INTO accounts (label, created_at) VALUES (?, ?)').run('Account 1', Date.now());
    accounts = db.prepare('SELECT id FROM accounts ORDER BY id').all();
  }

  // Campaigns created before multiple accounts existed belong to the first one.
  db.prepare('UPDATE campaigns SET account_id = ? WHERE account_id IS NULL').run(accounts[0].id);

  for (const a of accounts) connect(a.id).catch((err) => onConnectError(a.id, err));
}

// ---------- connecting ----------

export function isConnected(id) {
  const s = sessions.get(Number(id));
  return !!s && s.status.state === 'connected' && !!s.sock;
}

function scheduleReconnect(id, ms) {
  const s = session(id);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => connect(id).catch((err) => onConnectError(id, err)), ms);
}

function onConnectError(id, err) {
  if (!getAccount(id)) return; // account was removed meanwhile
  session(id).status.lastError = err?.message || String(err);
  scheduleReconnect(id, 5000);
}

async function connect(id) {
  id = Number(id);
  if (!getAccount(id)) return;
  const s = session(id);
  const myGen = ++s.generation;
  s.status.state = 'connecting';
  s.status.qr = null;

  const { state, saveCreds } = await useMultiFileAuthState(authDir(id));
  if (myGen !== s.generation) return;
  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.appropriate('WAPZAP'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  s.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (myGen !== s.generation) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const image = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (myGen !== s.generation) return;
      s.status.state = 'qr';
      s.status.qr = image;
    }

    if (connection === 'open') {
      s.status.state = 'connected';
      s.status.qr = null;
      s.status.lastError = null;
      s.status.me = jidNormalizedUser(sock.user?.id || '').split('@')[0] || null;
      // Remember the number so the account is recognisable while offline.
      db.prepare('UPDATE accounts SET number = ? WHERE id = ?').run(s.status.me, id);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      s.status.state = 'connecting';
      s.status.qr = null;
      s.sock = null;

      if (code === DisconnectReason.loggedOut) {
        // Phone unlinked this device: wipe the saved session and show a fresh QR.
        s.status.me = null;
        fs.rmSync(authDir(id), { recursive: true, force: true });
        scheduleReconnect(id, 500);
      } else {
        if (code !== DisconnectReason.restartRequired) {
          s.status.lastError = lastDisconnect?.error?.message || null;
        }
        scheduleReconnect(id, code === DisconnectReason.restartRequired ? 200 : 3000);
      }
    }
  });
}

// Stops the connection and forgets the saved login.
async function closeAndWipe(id) {
  const s = session(id);
  s.generation++; // stop listening to the old socket
  clearTimeout(s.timer);
  try {
    await s.sock?.logout();
  } catch {
    /* already disconnected */
  }
  try {
    s.sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  s.sock = null;
  s.status.me = null;
  s.status.qr = null;
  fs.rmSync(authDir(id), { recursive: true, force: true });
}

// Unlinks the phone but keeps the account entry, showing a new QR code.
export async function logout(id) {
  id = Number(id);
  await closeAndWipe(id);
  db.prepare('UPDATE accounts SET number = NULL WHERE id = ?').run(id);
  await connect(id);
}

// Unlinks the phone and removes the account entry altogether.
export async function removeAccount(id) {
  id = Number(id);
  await closeAndWipe(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  sessions.delete(id);
}

// ---------- sending ----------

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Sends the text and, if there is one, the attachment.
// media: a row from src/media.js (or null for a plain text message).
async function deliver(s, jid, text, media) {
  if (!media) {
    await withTimeout(s.sendMessage(jid, { text }), 60000, 'Sending');
    return;
  }
  if (!fs.existsSync(media.path)) throw new Error('The attachment file is missing from this computer');

  const file = { url: media.path };
  const caption = text || undefined;
  let content;
  if (media.kind === 'image') {
    content = { image: file, caption, mimetype: media.mime };
  } else if (media.kind === 'video') {
    content = { video: file, caption, mimetype: 'video/mp4' };
  } else if (media.kind === 'voice') {
    content = { audio: file, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: media.duration || 1 };
    if (media.waveform) content.waveform = new Uint8Array(Buffer.from(media.waveform, 'base64'));
  } else {
    content = { document: file, caption, mimetype: media.mime, fileName: media.name };
  }
  await withTimeout(s.sendMessage(jid, content), 300000, 'Sending the attachment');

  // A voice message cannot carry a caption, so the text follows as its own message.
  // The voice message goes first: if the upload fails, nothing has been sent yet.
  if (media.kind === 'voice' && text) {
    await withTimeout(s.sendMessage(jid, { text }), 60000, 'Sending');
  }
}

// number: digits only, international format without "+", e.g. 923001234567
export async function send(accountId, number, text, media = null) {
  if (!isConnected(accountId)) throw new Error('WhatsApp is not connected');
  const sock = session(accountId).sock;

  const lookup = await withTimeout(sock.onWhatsApp(`${number}@s.whatsapp.net`), 30000, 'Number check');
  const hit = lookup?.[0];
  if (!hit?.exists) throw new Error('Number is not on WhatsApp');

  await deliver(sock, hit.jid, text, media);
}

export async function sendToSelf(accountId, text, media = null) {
  if (!isConnected(accountId)) throw new Error('WhatsApp is not connected');
  const sock = session(accountId).sock;
  await deliver(sock, jidNormalizedUser(sock.user.id), text, media);
}
