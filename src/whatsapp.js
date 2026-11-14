// WhatsApp connection (Baileys). The login session is saved in data/auth so
// the QR code only has to be scanned once.
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
import { DATA_DIR } from './db.js';

const AUTH_DIR = path.join(DATA_DIR, 'auth');
const logger = pino({ level: 'silent' });

let sock = null;
let generation = 0; // ignores events from sockets we have already replaced
let reconnectTimer = null;

const status = {
  state: 'connecting', // connecting | qr | connected
  qr: null,            // data: URL of the QR image while state === 'qr'
  me: null,            // own number once connected
  lastError: null,
};

export function getStatus() {
  return { ...status };
}

export function isConnected() {
  return status.state === 'connected' && !!sock;
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch(onConnectError), ms);
}

function onConnectError(err) {
  status.lastError = err?.message || String(err);
  scheduleReconnect(5000);
}

export async function connect() {
  const myGen = ++generation;
  status.state = 'connecting';
  status.qr = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const s = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.appropriate('WAPZAP'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (update) => {
    if (myGen !== generation) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status.state = 'qr';
      status.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    }

    if (connection === 'open') {
      status.state = 'connected';
      status.qr = null;
      status.lastError = null;
      status.me = jidNormalizedUser(s.user?.id || '').split('@')[0] || null;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      status.state = 'connecting';
      status.qr = null;
      sock = null;

      if (code === DisconnectReason.loggedOut) {
        // Phone unlinked this device: wipe the saved session and show a fresh QR.
        status.me = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        scheduleReconnect(500);
      } else {
        if (code !== DisconnectReason.restartRequired) {
          status.lastError = lastDisconnect?.error?.message || null;
        }
        scheduleReconnect(code === DisconnectReason.restartRequired ? 200 : 3000);
      }
    }
  });
}

export async function logout() {
  generation++; // stop listening to the old socket
  clearTimeout(reconnectTimer);
  try {
    await sock?.logout();
  } catch {
    /* already disconnected */
  }
  try {
    sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  sock = null;
  status.me = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  await connect();
}

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
export async function send(number, text, media = null) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  const s = sock;

  const lookup = await withTimeout(s.onWhatsApp(`${number}@s.whatsapp.net`), 30000, 'Number check');
  const hit = lookup?.[0];
  if (!hit?.exists) throw new Error('Number is not on WhatsApp');

  await deliver(s, hit.jid, text, media);
}

export async function sendToSelf(text, media = null) {
  if (!isConnected()) throw new Error('WhatsApp is not connected');
  await deliver(sock, jidNormalizedUser(sock.user.id), text, media);
}
