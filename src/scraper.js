// Google Maps scraper. Drives the Chrome that is already installed on this
// computer (invisibly) to run a Maps search, then opens each result to read
// its name, phone number, category and address.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { getCountries } from 'libphonenumber-js/max';
import { db } from './db.js';
import { normaliseNumber, DEFAULT_COUNTRY } from './csv.js';

export const MAX_RESULTS_LIMIT = 300;
const DETAIL_TABS = 3; // places read at the same time

const CHROME_PATHS = [
  process.env.WAPZAP_CHROME,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/brave-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

function findChrome() {
  const found = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error('Google Chrome (or Chromium) is needed for the Maps scraper but was not found on this computer.');
  }
  return found;
}

// "Pakistan" -> "PK", so phone numbers are read in the right country's format.
const COUNTRY_BY_NAME = new Map();
{
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (const code of getCountries()) {
    const name = names.of(code);
    if (name) COUNTRY_BY_NAME.set(name.toLowerCase(), code);
  }
  COUNTRY_BY_NAME.set('usa', 'US').set('uk', 'GB').set('uae', 'AE').set('turkey', 'TR');
}

function countryFromAddress(address) {
  const last = String(address || '').split(',').pop().trim().toLowerCase();
  return COUNTRY_BY_NAME.get(last) || DEFAULT_COUNTRY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let current = null; // { id, stop } while a search is running

export function isScraping() {
  return !!current;
}

export function stopScrape(id) {
  if (current && current.id === Number(id)) current.stop = true;
}

function update(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE scrapes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id
  );
}

// Starts a search in the background and returns its id straight away.
export function startScrape(query, maxResults) {
  if (current) throw new Error('A search is already running. Wait for it to finish or stop it first.');
  findChrome(); // fail early with a clear message
  const id = Number(
    db
      .prepare("INSERT INTO scrapes (query, max_results, status, stage, created_at) VALUES (?, ?, 'running', ?, ?)")
      .run(query, maxResults, 'Opening Google Maps…', Date.now()).lastInsertRowid
  );
  const job = { id, stop: false };
  current = job;

  run(job, query, maxResults)
    .then(() => update(id, { status: job.stop ? 'stopped' : 'done', stage: null, finished_at: Date.now() }))
    .catch((err) => {
      console.error('Scraper error:', err);
      update(id, {
        status: 'failed',
        stage: null,
        error: String(err?.message || err).slice(0, 300),
        finished_at: Date.now(),
      });
    })
    .finally(() => {
      current = null;
    });
  return id;
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Pictures, map tiles and fonts are not needed - skipping them makes it much faster.
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  return page;
}

function checkBlocked(page) {
  if (page.url().includes('/sorry/')) {
    throw new Error('Google is asking for a "not a robot" check. Wait a while before searching again.');
  }
}

// The stable part of a place link, used to skip the same place listed twice.
const placeKey = (href) => href.match(/!1s([^!]+)/)?.[1] || href.split('?')[0];

async function run(job, query, maxResults) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US', '--disable-gpu', '--mute-audio'],
  });

  try {
    const page = await newPage(browser);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Cookie consent page (shown in some countries).
    if (page.url().includes('consent.google')) {
      await page
        .evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find((b) => /reject all|accept all/i.test(b.innerText));
          btn?.click();
        })
        .catch(() => {});
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    checkBlocked(page);

    // Either a list of results appears, or Google jumps straight to a single place.
    await page
      .waitForSelector('div[role="feed"], h1.DUwDvf', { timeout: 45000 })
      .catch(() => {
        checkBlocked(page);
        throw new Error('Google Maps did not show any results for this search.');
      });

    const links = new Map(); // key -> { href, name }
    const hasFeed = await page.$('div[role="feed"]');

    if (!hasFeed) {
      links.set('single', { href: page.url(), name: '' });
    } else {
      update(job.id, { stage: 'Collecting the list of places…' });
      let idleRounds = 0;
      while (!job.stop && links.size < maxResults && idleRounds < 8) {
        const before = links.size;
        const batch = await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          const items = [...feed.querySelectorAll('a.hfpxzc')].map((a) => ({
            href: a.href,
            name: a.getAttribute('aria-label') || '',
          }));
          feed.scrollTo(0, feed.scrollHeight);
          return { items, end: /reached the end of the list/i.test(feed.innerText) };
        });
        for (const item of batch.items) {
          if (links.size >= maxResults) break;
          const key = placeKey(item.href);
          if (!links.has(key)) links.set(key, item);
        }
        update(job.id, { found: links.size });
        if (batch.end) break;
        idleRounds = links.size === before ? idleRounds + 1 : 0;
        await sleep(1200);
      }
    }
    await page.close().catch(() => {});

    const queue = [...links.values()];
    update(job.id, { found: queue.length, stage: 'Reading phone numbers…' });

    const insert = db.prepare(
      `INSERT INTO places (scrape_id, name, phone_raw, number, display, mobile, category, address, rating, website, maps_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let processed = 0;

    const worker = async () => {
      const tab = await newPage(browser);
      while (!job.stop && queue.length) {
        const item = queue.shift();
        let info = null;
        for (let attempt = 0; attempt < 2 && !info && !job.stop; attempt++) {
          try {
            info = await readPlace(tab, item.href);
          } catch (err) {
            if (String(err?.message).includes('not a robot')) throw err;
          }
        }
        const name = info?.name || item.name;
        if (name) {
          const address = info?.address || null;
          const parsed = info?.phone ? normaliseNumber(info.phone, countryFromAddress(address)) : null;
          insert.run(
            job.id, name, info?.phone || null, parsed?.number || null, parsed?.display || null,
            parsed?.mobile ? 1 : 0, info?.category || null, address, info?.rating || null,
            info?.website || null, item.href
          );
        }
        update(job.id, { processed: ++processed });
        await sleep(300 + Math.random() * 500); // be gentle with Google
      }
      await tab.close().catch(() => {});
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_TABS, queue.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function readPlace(tab, href) {
  await tab.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  checkBlocked(tab);
  await tab.waitForSelector('h1.DUwDvf', { timeout: 20000 });
  // The contact details load a moment after the title.
  await tab
    .waitForSelector('[data-item-id="address"], [data-item-id^="phone:tel:"], [data-item-id="authority"]', { timeout: 7000 })
    .catch(() => {});
  await sleep(250);

  return tab.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
    const label = (sel, prefix) =>
      (document.querySelector(sel)?.getAttribute('aria-label') || '').replace(prefix, '').trim();
    return {
      name: text('h1.DUwDvf'),
      phone: (document.querySelector('[data-item-id^="phone:tel:"]')?.getAttribute('data-item-id') || '').replace('phone:tel:', ''),
      address: label('[data-item-id="address"]', /^Address:\s*/i),
      category: text('button.DkEaL'),
      rating: text('div.F7nice span[aria-hidden="true"]'),
      website: document.querySelector('a[data-item-id="authority"]')?.href || '',
    };
  });
}

// ---------- reading results ----------

export function scrapeSummary(s) {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS places,
              COUNT(DISTINCT number) AS withPhone,
              COUNT(DISTINCT CASE WHEN mobile = 1 THEN number END) AS mobile
       FROM places WHERE scrape_id = ?`
    )
    .get(s.id);
  return { ...s, counts: c };
}

export function listScrapes() {
  return db.prepare('SELECT * FROM scrapes ORDER BY id DESC').all().map(scrapeSummary);
}

export function getScrape(id) {
  const s = db.prepare('SELECT * FROM scrapes WHERE id = ?').get(Number(id));
  return s ? scrapeSummary(s) : null;
}

export function getPlaces(id) {
  return db
    .prepare(
      `SELECT name, phone_raw, number, display, mobile, category, address, rating, website, maps_url
       FROM places WHERE scrape_id = ? ORDER BY id`
    )
    .all(Number(id));
}

export function deleteScrape(id) {
  stopScrape(id);
  db.prepare('DELETE FROM scrapes WHERE id = ?').run(Number(id));
}

// CSV of the usable contacts (one row per phone number), in the same
// "name,number" shape the campaign upload expects.
export function scrapeCsv(id, { mobileOnly = false } = {}) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const seen = new Set();
  const lines = ['name,number,category,address,rating,website'];
  for (const p of getPlaces(id)) {
    if (!p.number || seen.has(p.number) || (mobileOnly && !p.mobile)) continue;
    seen.add(p.number);
    lines.push([p.name, '+' + p.number, p.category, p.address, p.rating, p.website].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}
