// WAPZAP - local web app for personalised WhatsApp messages in bulk.
import express from 'express';
import path from 'node:path';
import { db, transaction } from './src/db.js';
import { parseContacts } from './src/csv.js';
import * as wa from './src/whatsapp.js';
import { saveUpload, getMedia, publicMedia, deleteMediaIfUnused, cleanupOrphans, MEDIA_DIR, MAX_UPLOAD_MB } from './src/media.js';
import * as scraper from './src/scraper.js';
import { startScheduler, schedulerInfo, sentToday, renderMessage, localDate } from './src/scheduler.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // only reachable from this computer

const app = express();

// Attachment upload: the raw file is the request body. Registered before the
// JSON parser so that no file type is ever mistaken for an API request.
app.post('/api/media', express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new UserError('No file was received.');
  try {
    const media = await saveUpload(req.body, {
      filename: req.query.name,
      mime: req.headers['content-type'],
      voice: req.query.voice === '1',
    });
    res.json(publicMedia(media));
  } catch (err) {
    throw new UserError(err.message);
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

// ---------- helpers ----------

class UserError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intInRange(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UserError(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

// Validates the schedule fields that are present in `body`.
function readSchedule(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined && body[k] !== null && body[k] !== '';
  const need = (k) => !partial || has(k);

  if (need('dailyLimit')) out.daily_limit = intInRange(body.dailyLimit, 'Daily limit', 1, 10000);
  if (need('delayMin')) out.delay_min = intInRange(body.delayMin, 'Minimum delay', 1, 86400);
  if (need('delayMax')) out.delay_max = intInRange(body.delayMax, 'Maximum delay', 1, 86400);
  if (need('windowStart')) {
    if (!TIME_RE.test(body.windowStart)) throw new UserError('Window start must be a time like 09:00.');
    out.window_start = body.windowStart;
  }
  if (need('windowEnd')) {
    if (!TIME_RE.test(body.windowEnd)) throw new UserError('Window end must be a time like 18:00.');
    out.window_end = body.windowEnd;
  }
  if (need('startDate')) {
    if (!DATE_RE.test(body.startDate) || Number.isNaN(Date.parse(body.startDate))) {
      throw new UserError('Start date is not a valid date.');
    }
    out.start_date = body.startDate;
  }
  if (out.delay_min !== undefined && out.delay_max !== undefined && out.delay_min > out.delay_max) {
    throw new UserError('Minimum delay cannot be larger than maximum delay.');
  }
  return out;
}

// The text may be empty only when there is an attachment to send instead.
function readMessage(body, hasMedia = false) {
  const message = String(body.message ?? '').trim();
  if (!message && !hasMedia) throw new UserError('Write a message or add an attachment.');
  if (message.length > 4000) throw new UserError('The message is too long (max 4000 characters).');
  return message;
}

function readMedia(body) {
  if (!body.mediaId) return null;
  const media = getMedia(body.mediaId);
  if (!media) throw new UserError('The attachment was not found. Please add it again.');
  return media;
}

function readAccount(body) {
  const account = wa.getAccount(body.accountId);
  if (!account) throw new UserError('Choose which WhatsApp account to send from.');
  return account;
}

function campaignDetails(c) {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of db
    .prepare('SELECT status, COUNT(*) AS n FROM contacts WHERE campaign_id = ? GROUP BY status')
    .all(c.id)) {
    counts[row.status] = row.n;
  }
  const total = counts.pending + counts.sending + counts.sent + counts.failed;
  const account = wa.getAccount(c.account_id);
  return {
    ...c,
    account: account ? { id: account.id, label: account.label, number: account.number } : null,
    counts,
    total,
    sentToday: sentToday(c.id),
    scheduler: schedulerInfo(c),
    media: publicMedia(getMedia(c.media_id)),
  };
}

function getCampaign(id) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(Number(id));
  if (!c) throw new UserError('Campaign not found.');
  return c;
}

// ---------- WhatsApp ----------

function getAccountOr404(id) {
  const account = wa.getAccount(id);
  if (!account) throw new UserError('WhatsApp account not found.');
  return account;
}

app.get('/api/accounts', (req, res) => {
  res.json(wa.listAccounts());
});

app.post('/api/accounts', (req, res) => {
  let id;
  try {
    id = wa.createAccount(req.body?.label);
  } catch (err) {
    throw new UserError(err.message);
  }
  res.json(wa.getAccount(id));
});

app.patch('/api/accounts/:id', (req, res) => {
  const account = getAccountOr404(req.params.id);
  try {
    wa.renameAccount(account.id, req.body?.label);
  } catch (err) {
    throw new UserError(err.message);
  }
  res.json(wa.getAccount(account.id));
});

// Unlink the phone but keep the account entry (a new QR code is shown).
app.post('/api/accounts/:id/logout', async (req, res) => {
  const account = getAccountOr404(req.params.id);
  await wa.logout(account.id);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', async (req, res) => {
  const account = getAccountOr404(req.params.id);
  const busy = db
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE account_id = ? AND status != 'completed'")
    .get(account.id).n;
  if (busy) {
    throw new UserError(
      `${busy} unfinished campaign${busy > 1 ? 's use' : ' uses'} this account. Move them to another account or delete them first.`
    );
  }
  await wa.removeAccount(account.id);
  res.json({ ok: true });
});

app.post('/api/test', async (req, res) => {
  const media = readMedia(req.body);
  const message = readMessage(req.body, !!media);
  const name = String(req.body.name || 'Test Name').trim();
  const account = readAccount(req.body);
  if (!wa.isConnected(account.id)) throw new UserError(`WhatsApp account "${account.label}" is not connected.`);
  await wa.sendToSelf(account.id, renderMessage(message, name), media);
  res.json({ ok: true, to: wa.getAccount(account.id).number, label: account.label });
});

// ---------- attachments ----------

app.get('/api/media/:id', (req, res) => {
  const media = getMedia(req.params.id);
  if (!media) throw new UserError('Attachment not found.');
  res.type(media.mime).sendFile(media.file, { root: MEDIA_DIR });
});

app.delete('/api/media/:id', (req, res) => {
  res.json({ deleted: deleteMediaIfUnused(req.params.id) });
});

// ---------- CSV ----------

app.post('/api/csv/preview', (req, res) => {
  try {
    res.json(parseContacts(String(req.body.csv ?? '')));
  } catch (err) {
    throw new UserError(err.message);
  }
});

// ---------- Google Maps scraper ----------

function getScrapeOr404(id) {
  const s = scraper.getScrape(id);
  if (!s) throw new UserError('Search not found.');
  return s;
}

app.get('/api/scrapes', (req, res) => {
  res.json(scraper.listScrapes());
});

app.post('/api/scrapes', (req, res) => {
  const query = String(req.body?.query ?? '').trim();
  if (query.length < 3) throw new UserError('Type what to search for, e.g. "Restaurants in Islamabad".');
  if (query.length > 200) throw new UserError('That search is too long.');
  const max = intInRange(req.body?.maxResults ?? 50, 'Maximum results', 1, scraper.MAX_RESULTS_LIMIT);
  let id;
  try {
    id = scraper.startScrape(query, max);
  } catch (err) {
    throw new UserError(err.message);
  }
  res.json(scraper.getScrape(id));
});

app.get('/api/scrapes/:id', (req, res) => {
  const s = getScrapeOr404(req.params.id);
  res.json({ ...s, places: scraper.getPlaces(s.id) });
});

app.post('/api/scrapes/:id/stop', (req, res) => {
  const s = getScrapeOr404(req.params.id);
  scraper.stopScrape(s.id);
  res.json({ ok: true });
});

app.delete('/api/scrapes/:id', (req, res) => {
  const s = getScrapeOr404(req.params.id);
  scraper.deleteScrape(s.id);
  res.json({ ok: true });
});

app.get('/api/scrapes/:id/csv', (req, res) => {
  const s = getScrapeOr404(req.params.id);
  const csv = scraper.scrapeCsv(s.id, { mobileOnly: req.query.mobileOnly === '1' });
  if (req.query.download === '1') {
    const safe = s.query.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'maps';
    res.attachment(`${safe}.csv`);
  }
  res.type('text/csv').send(csv);
});

// ---------- campaigns ----------

app.get('/api/campaigns', (req, res) => {
  const rows = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  res.json(rows.map(campaignDetails));
});

app.post('/api/campaigns', (req, res) => {
  const body = req.body || {};
  const name = String(body.name ?? '').trim() || `Campaign ${localDate()}`;
  const media = readMedia(body);
  const message = readMessage(body, !!media);
  const s = readSchedule(body);
  const account = readAccount(body);

  let parsed;
  try {
    parsed = parseContacts(String(body.csv ?? ''));
  } catch (err) {
    throw new UserError(err.message);
  }
  const valid = parsed.rows.filter((r) => r.status === 'valid');
  if (!valid.length) throw new UserError('There are no valid contacts in this CSV.');

  const id = transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO campaigns
           (name, message, daily_limit, window_start, window_end, start_date, delay_min, delay_max, status, created_at, media_id, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(name, message, s.daily_limit, s.window_start, s.window_end, s.start_date, s.delay_min, s.delay_max, Date.now(), media?.id ?? null, account.id);
    const campaignId = Number(result.lastInsertRowid);
    const insert = db.prepare('INSERT INTO contacts (campaign_id, name, number) VALUES (?, ?, ?)');
    for (const r of valid) insert.run(campaignId, r.name, r.number);
    return campaignId;
  });

  res.json(campaignDetails(getCampaign(id)));
});

app.get('/api/campaigns/:id', (req, res) => {
  res.json(campaignDetails(getCampaign(req.params.id)));
});

app.patch('/api/campaigns/:id', (req, res) => {
  const c = getCampaign(req.params.id);
  const changes = readSchedule(req.body || {}, { partial: true });
  if (req.body?.message !== undefined) changes.message = readMessage(req.body, !!c.media_id);
  if (req.body?.accountId !== undefined) changes.account_id = readAccount(req.body).id;

  const merged = { ...c, ...changes };
  if (merged.delay_min > merged.delay_max) {
    throw new UserError('Minimum delay cannot be larger than maximum delay.');
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => changes[k]),
      c.id
    );
  }
  res.json(campaignDetails(getCampaign(c.id)));
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  const c = getCampaign(req.params.id);
  db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ? AND status = 'running'").run(c.id);
  res.json(campaignDetails(getCampaign(c.id)));
});

app.post('/api/campaigns/:id/resume', (req, res) => {
  const c = getCampaign(req.params.id);
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ? AND status = 'paused'").run(c.id);
  res.json(campaignDetails(getCampaign(c.id)));
});

app.post('/api/campaigns/:id/retry-failed', (req, res) => {
  const c = getCampaign(req.params.id);
  const result = db
    .prepare("UPDATE contacts SET status = 'pending', error = NULL WHERE campaign_id = ? AND status = 'failed'")
    .run(c.id);
  if (result.changes > 0) {
    db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ? AND status = 'completed'").run(c.id);
  }
  res.json(campaignDetails(getCampaign(c.id)));
});

app.delete('/api/campaigns/:id', (req, res) => {
  const c = getCampaign(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(c.id);
  if (c.media_id) deleteMediaIfUnused(c.media_id);
  res.json({ ok: true });
});

app.get('/api/campaigns/:id/contacts', (req, res) => {
  const c = getCampaign(req.params.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const status = ['pending', 'sent', 'failed'].includes(req.query.status) ? req.query.status : null;

  // "sending" is shown to the user as pending-in-progress.
  const where = status
    ? status === 'pending'
      ? "AND status IN ('pending', 'sending')"
      : 'AND status = ?'
    : '';
  const params = status && status !== 'pending' ? [c.id, status] : [c.id];

  const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE campaign_id = ? ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT id, name, number, status, error, sent_at FROM contacts
       WHERE campaign_id = ? ${where} ORDER BY id LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  res.json({ total, rows });
});

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(400).json({ error: err.message });
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `That file is too large (the limit is ${MAX_UPLOAD_MB} MB).` });
  }
  console.error(err);
  res.status(500).json({ error: err?.message || 'Something went wrong.' });
});

// ---------- start ----------

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  WAPZAP is running.');
  console.log(`  Open this in your browser:  http://localhost:${PORT}`);
  console.log('  Press Ctrl+C here to stop it.');
  console.log('');
});

wa.init();
cleanupOrphans();
startScheduler();
