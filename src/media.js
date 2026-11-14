// Attachments: photos, videos, voice messages and documents.
// Uploaded files are stored in data/media and converted (with ffmpeg) into
// formats WhatsApp plays reliably on every phone.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const MAX_UPLOAD_MB = 64;

function runTool(tool, args, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'] });
    const out = [];
    let err = '';
    if (collect) child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('error', (e) =>
      reject(
        e.code === 'ENOENT'
          ? new Error('ffmpeg is not installed. Install it with: sudo apt install ffmpeg')
          : e
      )
    );
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const lastLine = err.trim().split('\n').pop() || `exit code ${code}`;
      reject(new Error(`Could not convert this file (${lastLine})`));
    });
  });
}

const ffmpeg = (args, opts) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);

async function audioDuration(file) {
  const out = await runTool(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { collect: true }
  );
  return Math.max(1, Math.round(Number(out.toString().trim()) || 1));
}

// 64 loudness bars (0-100), which WhatsApp draws inside the voice message bubble.
async function audioWaveform(file) {
  const pcm = await ffmpeg(['-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { collect: true });
  const samples = Math.floor(pcm.length / 2);
  const bars = 64;
  const block = Math.max(1, Math.floor(samples / bars));
  const levels = [];
  for (let i = 0; i < bars; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i * block; j < (i + 1) * block && j < samples; j++, n++) {
      sum += Math.abs(pcm.readInt16LE(j * 2));
    }
    levels.push(n ? sum / n : 0);
  }
  const peak = Math.max(...levels, 1);
  return Buffer.from(levels.map((l) => Math.floor((l / peak) * 100))).toString('base64');
}

const EXT_KIND = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', '3gp': 'video', m4v: 'video',
  mp3: 'voice', ogg: 'voice', opus: 'voice', m4a: 'voice', wav: 'voice', aac: 'voice', flac: 'voice',
};

function detectKind(mime, ext, forceVoice) {
  if (forceVoice) return 'voice';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return EXT_KIND[ext] || 'document';
}

// Saves an uploaded file and returns its media row.
export async function saveUpload(buffer, { filename, mime, voice = false }) {
  if (!buffer?.length) throw new Error('The file is empty.');

  const name = path.basename(String(filename || 'file')).slice(0, 150) || 'file';
  const ext = path.extname(name).slice(1).toLowerCase();
  mime = String(mime || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const kind = detectKind(mime, ext, voice);

  const id = randomUUID();
  const original = path.join(MEDIA_DIR, `${id}.upload`);
  await fs.promises.writeFile(original, buffer);

  let file;
  let duration = null;
  let waveform = null;
  try {
    if (kind === 'voice') {
      // WhatsApp voice messages must be Opus audio in an Ogg file.
      file = `${id}.ogg`;
      await ffmpeg(['-i', original, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000',
        '-f', 'ogg', path.join(MEDIA_DIR, file)]);
      mime = 'audio/ogg; codecs=opus';
      duration = await audioDuration(path.join(MEDIA_DIR, file));
      waveform = await audioWaveform(path.join(MEDIA_DIR, file)).catch(() => null);
    } else if (kind === 'video' && !(mime === 'video/mp4' || ext === 'mp4')) {
      // Anything that is not MP4 is converted so it plays on every phone.
      file = `${id}.mp4`;
      await ffmpeg(['-i', original, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        path.join(MEDIA_DIR, file)]);
      mime = 'video/mp4';
    } else if (kind === 'image' && !['image/jpeg', 'image/png'].includes(mime) && !['jpg', 'jpeg', 'png'].includes(ext)) {
      file = `${id}.jpg`;
      await ffmpeg(['-i', original, '-frames:v', '1', '-q:v', '3', path.join(MEDIA_DIR, file)]);
      mime = 'image/jpeg';
    } else {
      file = `${id}${ext ? '.' + ext.replace(/[^a-z0-9]/g, '') : ''}`;
      await fs.promises.rename(original, path.join(MEDIA_DIR, file));
      if (kind === 'video') mime = 'video/mp4';
      if (kind === 'image' && !mime.startsWith('image/')) mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    }
  } catch (err) {
    if (file) fs.rmSync(path.join(MEDIA_DIR, file), { force: true });
    throw err;
  } finally {
    fs.rmSync(original, { force: true });
  }

  const size = fs.statSync(path.join(MEDIA_DIR, file)).size;
  db.prepare(
    `INSERT INTO media (id, kind, mime, name, file, size, duration, waveform, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, kind, mime, name, file, size, duration, waveform, Date.now());
  return getMedia(id);
}

export function getMedia(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(String(id));
  return row ? { ...row, path: path.join(MEDIA_DIR, row.file) } : null;
}

// What the browser is allowed to know about an attachment.
export function publicMedia(m) {
  return m ? { id: m.id, kind: m.kind, mime: m.mime, name: m.name, size: m.size, duration: m.duration } : null;
}

function isUsed(id) {
  return !!db.prepare('SELECT 1 FROM campaigns WHERE media_id = ? LIMIT 1').get(id);
}

// Deletes an attachment unless a campaign still needs it. Returns true if deleted.
export function deleteMediaIfUnused(id) {
  const m = getMedia(id);
  if (!m || isUsed(m.id)) return false;
  fs.rmSync(m.path, { force: true });
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  return true;
}

// Uploads that were never attached to a campaign are removed after a day.
export function cleanupOrphans() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = db
    .prepare('SELECT id FROM media WHERE created_at < ? AND id NOT IN (SELECT media_id FROM campaigns WHERE media_id IS NOT NULL)')
    .all(cutoff);
  for (const r of rows) deleteMediaIfUnused(r.id);
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (f.endsWith('.upload')) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
  }
}
