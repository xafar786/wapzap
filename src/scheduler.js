// The sending loop. Wakes up every few seconds, decides whether a message is
// allowed to go out right now, and sends at most one.
import { db, getSetting, setSetting } from './db.js';
import * as wa from './whatsapp.js';
import { getMedia } from './media.js';

const TICK_MS = 3000;
let busy = false;
const info = new Map(); // campaign id -> { state, text, nextAt }

export function renderMessage(template, name) {
  return template.replace(/\{\s*name\s*\}/gi, name);
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function inWindow(start, end) {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (start === end) return true;
  if (start < end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end; // window that crosses midnight, e.g. 22:00-02:00
}

export function sentToday(campaignId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM contacts WHERE campaign_id = ? AND status = 'sent' AND sent_at >= ?")
    .get(campaignId, startOfToday()).n;
}

function pendingCount(campaignId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM contacts WHERE campaign_id = ? AND status = 'pending'")
    .get(campaignId).n;
}

// Why can't this campaign send right now? Returns { state: 'ready' } if it can.
function check(c) {
  if (pendingCount(c.id) === 0) {
    db.prepare("UPDATE campaigns SET status = 'completed' WHERE id = ?").run(c.id);
    return { state: 'completed', text: 'All contacts processed.' };
  }
  const account = wa.getAccount(c.account_id);
  if (!account) {
    return { state: 'waiting', text: 'The WhatsApp account for this campaign was removed. Pick another one in the settings below.' };
  }
  if (!wa.isConnected(account.id)) {
    return { state: 'waiting', text: `Waiting for WhatsApp account "${account.label}" to connect.` };
  }
  if (localDate() < c.start_date) {
    return { state: 'waiting', text: `Scheduled to start on ${c.start_date} at ${c.window_start}.` };
  }
  if (!inWindow(c.window_start, c.window_end)) {
    return {
      state: 'waiting',
      text: `Outside the sending window (${c.window_start}-${c.window_end}). Resumes at ${c.window_start}.`,
    };
  }
  const today = sentToday(c.id);
  if (today >= c.daily_limit) {
    return {
      state: 'waiting',
      text: `Daily limit reached (${today}/${c.daily_limit}). Continues tomorrow at ${c.window_start}.`,
    };
  }
  // The delay is kept per account, so accounts do not slow each other down.
  const nextAt = Number(getSetting(`next_send_at:${c.account_id}`, 0));
  if (Date.now() < nextAt) {
    return { state: 'delay', text: 'Waiting before the next message.', nextAt };
  }
  return { state: 'ready', text: 'Sending...' };
}

async function sendNext(c) {
  const contact = db
    .prepare("SELECT * FROM contacts WHERE campaign_id = ? AND status = 'pending' ORDER BY id LIMIT 1")
    .get(c.id);
  if (!contact) return;

  // Mark first, so a crash mid-send can never cause a silent double send.
  db.prepare("UPDATE contacts SET status = 'sending' WHERE id = ?").run(contact.id);

  try {
    await wa.send(c.account_id, contact.number, renderMessage(c.message, contact.name), getMedia(c.media_id));
    db.prepare("UPDATE contacts SET status = 'sent', error = NULL, sent_at = ? WHERE id = ?").run(
      Date.now(),
      contact.id
    );
  } catch (err) {
    if (!wa.isConnected(c.account_id)) {
      // Connection dropped: not this contact's fault, try again once reconnected.
      db.prepare("UPDATE contacts SET status = 'pending' WHERE id = ?").run(contact.id);
      return;
    }
    db.prepare("UPDATE contacts SET status = 'failed', error = ? WHERE id = ?").run(
      String(err?.message || err).slice(0, 300),
      contact.id
    );
  }

  const min = Math.min(c.delay_min, c.delay_max);
  const max = Math.max(c.delay_min, c.delay_max);
  const delaySec = min + Math.random() * (max - min);
  setSetting(`next_send_at:${c.account_id}`, Math.round(Date.now() + delaySec * 1000));
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const running = db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id").all();
    // Each account sends for one campaign at a time; different accounts work in parallel.
    const chosen = new Map(); // account id -> campaign
    for (const c of running) {
      const result = check(c);
      if (result.state === 'ready') {
        if (chosen.has(c.account_id)) result.text = 'Queued behind another campaign on the same WhatsApp account.';
        else chosen.set(c.account_id, c);
      }
      info.set(c.id, result);
    }
    await Promise.all([...chosen.values()].map((c) => sendNext(c)));
  } catch (err) {
    console.error('Scheduler error:', err);
  } finally {
    busy = false;
  }
}

export function schedulerInfo(campaign) {
  if (campaign.status === 'paused') return { state: 'paused', text: 'Paused. Press Resume to continue.' };
  if (campaign.status === 'completed') return { state: 'completed', text: 'All contacts processed.' };
  return info.get(campaign.id) || { state: 'waiting', text: 'Starting...' };
}

export function startScheduler() {
  setInterval(tick, TICK_MS);
  tick();
}
