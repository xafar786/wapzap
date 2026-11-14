/* WAPZAP frontend - plain JavaScript, no build step. */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 7000 : 4000);
}

// Runs an action from a button: disables it while working, shows errors as a toast.
async function run(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

const renderMessage = (template, name) => template.replace(/\{\s*name\s*\}/gi, name);
const prettyNumber = (n) => '+' + n;

// ================= tabs =================
let currentTab = 'connect';
function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'dashboard') loadCampaigns();
  if (name === 'scraper') loadScrapes();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ================= whatsapp accounts =================
let accounts = [];
let serverUp = true;
let lastAccountsKey = '';

const accountName = (a) => (a.number ? `${a.label} (+${a.number})` : a.label);

async function pollAccounts() {
  try {
    accounts = await api('/api/accounts');
    serverUp = true;
  } catch {
    serverUp = false;
  }
  const connected = accounts.filter((a) => a.state === 'connected');
  $('#connPill').classList.toggle('on', serverUp && connected.length > 0);
  $('#connText').textContent = !serverUp
    ? 'App is not running'
    : accounts.length === 1
      ? connected.length
        ? `Connected · +${connected[0].me}`
        : accounts[0].state === 'qr'
          ? 'Waiting for QR scan'
          : 'Connecting…'
      : `${connected.length} of ${accounts.length} accounts connected`;

  fillAccountSelect($('#cAccount'));
  fillAccountSelect($('#eAccount'));

  // Only redraw the cards when something actually changed.
  const key = serverUp + '|' + accounts.map((a) => [a.id, a.label, a.state, a.qr, a.me, a.lastError].join('~')).join('|');
  if (key === lastAccountsKey) return;
  lastAccountsKey = key;

  const list = $('#accountList');
  if (!serverUp) {
    list.innerHTML = `<p class="alert error">Cannot reach the WAPZAP app. Is it still running?</p>`;
    return;
  }
  list.innerHTML = accounts
    .map((a) => {
      let body;
      if (a.state === 'connected') {
        body = `<div class="grow">
            <div class="bigcheck">✓</div>
            <strong>Connected as +${esc(a.me)}</strong>
            <span class="muted small">The login is saved on this computer.</span>
          </div>`;
      } else if (a.state === 'qr') {
        body = `<img class="qr" src="${a.qr}" alt="WhatsApp QR code">
          <ol class="steps muted">
            <li>Open WhatsApp on the phone</li>
            <li><strong>Settings → Linked devices → Link a device</strong></li>
            <li>Scan this code</li>
          </ol>`;
      } else {
        body = `<div class="grow"><div class="spinner"></div><span class="muted">Connecting…</span>
          ${a.lastError ? `<span class="muted small">Last problem: ${esc(a.lastError)}</span>` : ''}</div>`;
      }
      return `<div class="card account" data-id="${a.id}">
        <h2>${esc(a.label)}</h2>
        ${body}
        <div class="row wrap actions">
          <button class="btn ghost small" data-act="rename">Rename</button>
          ${a.state === 'connected' ? '<button class="btn ghost small" data-act="logout">Disconnect</button>' : ''}
          <button class="btn danger small" data-act="remove">Remove</button>
        </div>
      </div>`;
    })
    .join('');
}

// Keeps an account dropdown up to date without disturbing the user's choice.
function fillAccountSelect(sel) {
  const html = accounts
    .map((a) => `<option value="${a.id}">${esc(accountName(a))}${a.state === 'connected' ? '' : ' — not connected'}</option>`)
    .join('');
  if (sel.dataset.html === html || document.activeElement === sel) return;
  const previous = sel.value;
  sel.innerHTML = html;
  sel.dataset.html = html;
  if (accounts.some((a) => String(a.id) === previous)) sel.value = previous;
  else if (sel.id === 'cAccount') {
    // Default to the first connected account.
    const first = accounts.find((a) => a.state === 'connected') || accounts[0];
    if (first) sel.value = first.id;
  }
}

$('#addAccount').addEventListener('click', (e) => {
  const label = prompt('A name for this WhatsApp account (e.g. "Sales phone"):', `Account ${accounts.length + 1}`);
  if (label === null) return;
  run(e.target, async () => {
    await api('/api/accounts', 'POST', { label });
    await pollAccounts();
    toast('Account added. Scan its QR code with the phone you want to link.');
  });
});

$('#accountList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const account = accounts.find((a) => a.id === Number(btn.closest('.account').dataset.id));
  if (!account) return;
  const act = btn.dataset.act;

  if (act === 'rename') {
    const label = prompt('New name for this account:', account.label);
    if (label === null) return;
    run(btn, async () => {
      await api(`/api/accounts/${account.id}`, 'PATCH', { label });
      await pollAccounts();
    });
  } else if (act === 'logout') {
    if (!confirm(`Disconnect "${account.label}"? Its campaigns will wait until you scan a QR code for it again.`)) return;
    run(btn, async () => {
      await api(`/api/accounts/${account.id}/logout`, 'POST');
      await pollAccounts();
      toast('Disconnected.');
    });
  } else if (act === 'remove') {
    if (!confirm(`Remove "${account.label}" from WAPZAP? The phone will be unlinked.`)) return;
    run(btn, async () => {
      await api(`/api/accounts/${account.id}`, 'DELETE');
      await pollAccounts();
      toast('Account removed.');
    });
  }
});

// ================= new campaign =================
let csvText = '';
let csvPreview = null;
const PREVIEW_LIMIT = 500;

$('#cStartDate').value = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

$('#csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#csvName').textContent = file.name;
  $('#csvError').classList.add('hidden');
  csvPreview = null;
  try {
    csvText = await file.text();
    csvPreview = await api('/api/csv/preview', 'POST', { csv: csvText });
  } catch (err) {
    $('#csvError').textContent = err.message;
    $('#csvError').classList.remove('hidden');
  }
  e.target.value = ''; // lets you pick the same file again after fixing it
  renderCsv();
  updateNewForm();
});

function renderCsv() {
  const has = !!csvPreview;
  $('#csvSummary').classList.toggle('hidden', !has);
  $('#csvTableWrap').classList.toggle('hidden', !has);
  $('#csvNote').classList.add('hidden');
  if (!has) return;

  const s = csvPreview.summary;
  $('#csvSummary').innerHTML = `
    <span>${s.total} rows</span>
    <span class="ok">${s.valid} ready to send</span>
    ${s.duplicate ? `<span class="warn">${s.duplicate} duplicate${s.duplicate > 1 ? 's' : ''} (skipped)</span>` : ''}
    ${s.invalid ? `<span class="bad">${s.invalid} invalid (skipped)</span>` : ''}`;

  // Show problem rows first so they are never hidden by the preview limit.
  const order = { invalid: 0, duplicate: 1, valid: 2 };
  const rows = [...csvPreview.rows].sort((a, b) => order[a.status] - order[b.status] || a.row - b.row);
  $('#csvRows').innerHTML = rows
    .slice(0, PREVIEW_LIMIT)
    .map(
      (r) => `<tr class="${r.status === 'invalid' ? 'rowbad' : r.status === 'duplicate' ? 'rowdup' : ''}">
        <td>${r.row}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.rawNumber)}</td>
        <td>${r.display ? esc(r.display) : '—'}</td>
        <td><span class="badge ${r.status}">${r.status}</span> <span class="muted small">${esc(r.reason)}</span></td>
      </tr>`
    )
    .join('');
  if (rows.length > PREVIEW_LIMIT) {
    $('#csvNote').textContent = `Showing the first ${PREVIEW_LIMIT} of ${rows.length} rows (problem rows first). All valid rows will be included.`;
    $('#csvNote').classList.remove('hidden');
  }
}

// ---------- attachment (photo / video / file / voice message) ----------
let media = null;        // { id, kind, name, size, duration } once uploaded
const MAX_UPLOAD_MB = 64;
const KIND_LABEL = { image: 'Photo', video: 'Video', voice: 'Voice message', document: 'File' };

const fmtSize = (bytes) => (bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB');
const fmtTime = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

function mediaHtml(m, url) {
  if (!m) return '';
  if (m.kind === 'image') return `<img src="${url}" alt="">`;
  if (m.kind === 'video') return `<video src="${url}" controls preload="metadata"></video>`;
  if (m.kind === 'voice') return `<audio src="${url}" controls preload="metadata"></audio>`;
  return `<div class="doc">📄 ${esc(m.name)}</div>`;
}

function renderAttachment(state = 'idle') {
  // state: idle | recording | busy
  $('#attachButtons').classList.toggle('hidden', state !== 'idle' || !!media);
  $('#recBox').classList.toggle('hidden', state !== 'recording');
  $('#attachBusy').classList.toggle('hidden', state !== 'busy');
  $('#attachChip').classList.toggle('hidden', state !== 'idle' || !media);
  if (media) {
    $('#attachKind').textContent = KIND_LABEL[media.kind];
    $('#attachName').textContent = media.kind === 'voice' && media.duration ? `${media.name} · ${fmtTime(media.duration)}` : media.name;
    $('#attachSize').textContent = fmtSize(media.size);
  }
  $('#attachHint').textContent = !media
    ? 'Optional. One attachment per campaign, sent to every contact.'
    : media.kind === 'voice'
      ? 'The voice message is sent first, then your text as a second message (leave the text empty to send only the voice message).'
      : 'Your text is sent as the caption under the attachment. You can leave the text empty.';
  $('#previewMedia').innerHTML = mediaHtml(media, media ? `/api/media/${media.id}` : '');
  $('.phone .bubble').classList.toggle('hasmedia', !!media);
  updateNewForm();
}

async function uploadMedia(blob, name, isVoice) {
  if (blob.size > MAX_UPLOAD_MB * 1048576) {
    return toast(`That file is ${fmtSize(blob.size)}. The limit is ${MAX_UPLOAD_MB} MB.`, true);
  }
  renderAttachment('busy');
  try {
    const q = new URLSearchParams({ name });
    if (isVoice) q.set('voice', '1');
    const res = await fetch('/api/media?' + q, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    media = data;
  } catch (err) {
    toast(err.message, true);
  }
  renderAttachment();
}

function removeAttachment({ deleteOnServer = true } = {}) {
  if (media && deleteOnServer) api(`/api/media/${media.id}`, 'DELETE').catch(() => {});
  media = null;
  renderAttachment();
}

$('#mediaFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) uploadMedia(file, file.name, false);
});
$('#attachRemove').addEventListener('click', () => removeAttachment());

// ---------- voice recorder ----------
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStarted = 0;
let recKeep = false;

$('#recStart').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('This browser cannot record audio. Attach an audio file instead.', true);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('Microphone access was blocked. Allow the microphone for this page and try again.', true);
  }
  const type = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recChunks = [];
  recKeep = false;
  recorder.ondataavailable = (ev) => ev.data.size && recChunks.push(ev.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop()); // turns the microphone light off
    clearInterval(recTimer);
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    if (recKeep && blob.size) uploadMedia(blob, 'Voice message', true);
    else renderAttachment();
  };
  recorder.start();
  recStarted = Date.now();
  $('#recTime').textContent = '0:00';
  recTimer = setInterval(() => ($('#recTime').textContent = fmtTime((Date.now() - recStarted) / 1000)), 250);
  renderAttachment('recording');
});
$('#recStop').addEventListener('click', () => { recKeep = true; recorder?.stop(); });
$('#recCancel').addEventListener('click', () => { recKeep = false; recorder?.stop(); });

function firstValidName() {
  return csvPreview?.rows.find((r) => r.status === 'valid')?.name || null;
}

function updateNewForm() {
  const msg = $('#message').value;
  const sample = firstValidName();
  $('#preview').textContent = renderMessage(msg, sample || 'Ali');
  $('#previewFor').textContent = sample ? `(as ${sample} will see it)` : '(example name: Ali)';
  $('#charCount').textContent = `${msg.length} characters`;
  $('#nameWarn').classList.toggle('hidden', !msg.trim() || /\{\s*name\s*\}/i.test(msg));

  const valid = csvPreview?.summary.valid || 0;
  const daily = Number($('#cDaily').value) || 0;
  $('#estimate').textContent =
    valid && daily > 0
      ? `${valid} contacts at up to ${daily} per day ≈ ${Math.ceil(valid / daily)} day(s) to finish.`
      : '';

  const problems = [];
  if (!valid) problems.push('upload a CSV with valid contacts');
  if (!msg.trim() && !media) problems.push('write a message or add an attachment');
  $('#createBtn').disabled = problems.length > 0;
  $('#createHint').textContent = problems.length ? 'First ' + problems.join(' and ') + '.' : '';
}

$('#message').addEventListener('input', updateNewForm);
$('#cDaily').addEventListener('input', updateNewForm);

$('#insertName').addEventListener('click', () => {
  const ta = $('#message');
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + '{name}' + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + 6;
  updateNewForm();
});

async function sendTest(button, message, name, mediaId, accountId) {
  if (!message.trim() && !mediaId) return toast('Write a message or add an attachment first.', true);
  await run(button, async () => {
    const r = await api('/api/test', 'POST', { message, name, mediaId, accountId });
    toast(`Test sent from "${r.label}" to its own number (+${r.to}). Look in the "Message yourself" chat on that phone.`);
  });
}

$('#testNew').addEventListener('click', (e) => sendTest(e.target, $('#message').value, firstValidName() || 'Ali', media?.id, $('#cAccount').value));

$('#createBtn').addEventListener('click', (e) =>
  run(e.target, async () => {
    const valid = csvPreview?.summary.valid || 0;
    if (!confirm(`Create this campaign and start sending to ${valid} contacts on the schedule you set?`)) return;
    const c = await api('/api/campaigns', 'POST', {
      name: $('#cName').value,
      csv: csvText,
      message: $('#message').value,
      mediaId: media?.id,
      accountId: $('#cAccount').value,
      dailyLimit: $('#cDaily').value,
      windowStart: $('#cStart').value,
      windowEnd: $('#cEnd').value,
      startDate: $('#cStartDate').value,
      delayMin: $('#cDelayMin').value,
      delayMax: $('#cDelayMax').value,
    });
    toast('Campaign created.');
    // Reset the form for the next campaign.
    csvText = '';
    csvPreview = null;
    $('#csvName').textContent = '';
    $('#message').value = '';
    $('#cName').value = '';
    renderCsv();
    removeAttachment({ deleteOnServer: false }); // the campaign owns the file now
    selectedId = c.id;
    showTab('dashboard');
  })
);

// ================= google maps scraper =================
let scrapeId = Number(localStorage.getItem('wapzap.scrape')) || null;
let scrape = null;         // selected search, with its places
let scrapeRenderKey = '';

async function loadScrapes() {
  let list;
  try {
    list = await api('/api/scrapes');
  } catch {
    return;
  }
  $('#sEmpty').classList.toggle('hidden', list.length > 0);
  $('#sPanel').classList.toggle('hidden', list.length === 0);
  $('#sStart').disabled = list.some((x) => x.status === 'running');
  if (!list.length) {
    scrape = null;
    return;
  }
  if (!list.some((x) => x.id === scrapeId)) scrapeId = list[0].id;
  localStorage.setItem('wapzap.scrape', scrapeId);

  const sel = $('#sSelect');
  const options = list
    .map((x) => `<option value="${x.id}">${esc(x.query)} (${x.counts.withPhone} numbers)</option>`)
    .join('');
  if (document.activeElement !== sel && sel.dataset.html !== options) {
    sel.innerHTML = options;
    sel.dataset.html = options;
  }
  sel.value = scrapeId;

  try {
    const data = await api(`/api/scrapes/${scrapeId}`);
    if (data.id !== scrapeId) return;
    scrape = data;
  } catch {
    return;
  }
  renderScrape();
}

function renderScrape() {
  const s = scrape;
  const running = s.status === 'running';
  const mobileOnly = $('#sMobileOnly').checked;
  const usable = mobileOnly ? s.counts.mobile : s.counts.withPhone;

  $('#sStatus').textContent = running ? 'searching' : s.status;
  $('#sStatus').className = 'badge ' + s.status;
  $('#sStop').classList.toggle('hidden', !running);
  $('#sDelete').classList.toggle('hidden', running);
  $('#sPush').disabled = usable === 0;
  $('#sPush').textContent = `Use ${usable} contact${usable === 1 ? '' : 's'} in a new campaign →`;
  $('#sDownload').href = `/api/scrapes/${s.id}/csv?download=1${mobileOnly ? '&mobileOnly=1' : ''}`;
  $('#sDownload').classList.toggle('hidden', s.counts.withPhone === 0);

  $('#sProgressBox').classList.toggle('hidden', !running);
  $('#sBar').style.width = (s.found ? (s.processed / s.found) * 100 : 3) + '%';
  $('#sStage').textContent = `${s.stage || ''} ${s.found ? `${s.processed} of ${s.found} places checked.` : ''}`;
  $('#sError').classList.toggle('hidden', !s.error);
  $('#sError').textContent = s.error || '';

  $('#sChips').innerHTML = `
    <span>${s.counts.places} places</span>
    <span class="ok">${s.counts.mobile} mobile numbers</span>
    <span class="warn">${s.counts.withPhone - s.counts.mobile} landlines</span>
    <span>${s.places.filter((p) => !p.number).length} without a usable number</span>`;

  // Redraw the table only when its content changed, so scrolling is not interrupted.
  const key = `${s.id}|${s.places.length}|${mobileOnly}`;
  if (key === scrapeRenderKey) return;
  scrapeRenderKey = key;
  $('#sRows').innerHTML =
    s.places
      .map((p, i) => {
        const type = !p.number ? '' : p.mobile ? 'mobile' : 'landline';
        const dim = !p.number || (mobileOnly && !p.mobile);
        return `<tr class="${dim ? 'dim' : ''}">
          <td>${i + 1}</td>
          <td><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">${esc(p.name)}</a></td>
          <td>${esc(p.display || p.phone_raw || '—')}</td>
          <td>${type ? `<span class="badge ${type}">${type}</span>` : ''}</td>
          <td>${esc(p.category || '')}</td>
          <td>${esc(p.rating || '')}</td>
          <td class="small">${esc(p.address || '')}</td>
        </tr>`;
      })
      .join('') || `<tr><td colspan="7" class="muted center">${running ? 'Results will appear here…' : 'Nothing found.'}</td></tr>`;
}

$('#sStart').addEventListener('click', (e) =>
  run(e.target, async () => {
    const s = await api('/api/scrapes', 'POST', { query: $('#sQuery').value, maxResults: $('#sMax').value });
    scrapeId = s.id;
    $('#sQuery').value = '';
    await loadScrapes();
  })
);
$('#sQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#sStart').disabled) $('#sStart').click();
});
$('#sSelect').addEventListener('change', (e) => {
  scrapeId = Number(e.target.value);
  e.target.blur();
  loadScrapes();
});
$('#sMobileOnly').addEventListener('change', () => scrape && renderScrape());
$('#sStop').addEventListener('click', (e) =>
  run(e.target, async () => {
    await api(`/api/scrapes/${scrape.id}/stop`, 'POST');
    toast('Stopping… the places found so far are kept.');
  })
);
$('#sDelete').addEventListener('click', (e) => {
  if (!confirm(`Delete the search "${scrape.query}" and its results? Campaigns already created from it are not affected.`)) return;
  run(e.target, async () => {
    await api(`/api/scrapes/${scrape.id}`, 'DELETE');
    scrapeRenderKey = '';
    await loadScrapes();
  });
});

// Push the scraped contacts into the "New campaign" form, through the same
// checks (validation, duplicates) as an uploaded CSV file.
$('#sPush').addEventListener('click', (e) =>
  run(e.target, async () => {
    const mobileOnly = $('#sMobileOnly').checked;
    const res = await fetch(`/api/scrapes/${scrape.id}/csv${mobileOnly ? '?mobileOnly=1' : ''}`);
    if (!res.ok) throw new Error('Could not load the contacts.');
    const text = await res.text();
    const preview = await api('/api/csv/preview', 'POST', { csv: text });
    csvText = text;
    csvPreview = preview;
    $('#csvError').classList.add('hidden');
    $('#csvName').textContent = `From Maps Scraper: “${scrape.query}”`;
    if (!$('#cName').value.trim()) $('#cName').value = scrape.query;
    renderCsv();
    updateNewForm();
    showTab('new');
    toast(`${preview.summary.valid} contacts loaded. Now write your message.`);
  })
);

$('#goScraper').addEventListener('click', (e) => {
  e.preventDefault();
  showTab('scraper');
});

// ================= dashboard =================
let selectedId = Number(localStorage.getItem('wapzap.campaign')) || null;
let campaign = null;
let filter = '';
let page = 0;
let settingsLoadedFor = null;
const PAGE_SIZE = 100;

async function loadCampaigns() {
  let list;
  try {
    list = await api('/api/campaigns');
  } catch {
    return;
  }
  $('#dashEmpty').classList.toggle('hidden', list.length > 0);
  $('#dash').classList.toggle('hidden', list.length === 0);
  if (!list.length) {
    campaign = null;
    return;
  }
  if (!list.some((c) => c.id === selectedId)) selectedId = list[0].id;
  localStorage.setItem('wapzap.campaign', selectedId);

  const sel = $('#campaignSelect');
  const options = list.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.counts.sent}/${c.total})</option>`).join('');
  if (document.activeElement !== sel && sel.dataset.html !== options) {
    sel.innerHTML = options;
    sel.dataset.html = options;
  }
  sel.value = selectedId;

  campaign = list.find((c) => c.id === selectedId);
  renderCampaign();
  await loadContacts();
}

function renderCampaign() {
  const c = campaign;
  const done = c.counts.sent + c.counts.failed;
  const pending = c.counts.pending + c.counts.sending;

  $('#cStatus').textContent = c.status;
  $('#cStatus').className = 'badge ' + c.status;
  $('#cFrom').textContent = c.account ? `from ${accountName(c.account)}` : 'account removed';
  $('#bar').style.width = (c.total ? (done / c.total) * 100 : 0) + '%';
  $('#progressText').textContent = `${done} of ${c.total} processed`;

  let sched = c.scheduler.text;
  if (c.scheduler.state === 'delay' && c.scheduler.nextAt) {
    const secs = Math.max(0, Math.ceil((c.scheduler.nextAt - Date.now()) / 1000));
    sched = `Next message in about ${secs}s`;
  }
  $('#schedText').textContent = sched;

  $('#sTotal').textContent = c.total;
  $('#sPending').textContent = pending;
  $('#sSent').textContent = c.counts.sent;
  $('#sFailed').textContent = c.counts.failed;
  $('#sToday').textContent = `${c.sentToday}/${c.daily_limit}`;

  $('#pauseBtn').classList.toggle('hidden', c.status !== 'running');
  $('#resumeBtn').classList.toggle('hidden', c.status !== 'paused');
  $('#retryBtn').classList.toggle('hidden', c.counts.failed === 0);

  // Fill the settings form once per campaign so typing is never overwritten by a refresh.
  if (settingsLoadedFor !== c.id) {
    settingsLoadedFor = c.id;
    $('#eStartDate').value = c.start_date;
    $('#eDaily').value = c.daily_limit;
    $('#eStart').value = c.window_start;
    $('#eEnd').value = c.window_end;
    $('#eDelayMin').value = c.delay_min;
    $('#eDelayMax').value = c.delay_max;
    $('#eMessage').value = c.message;
    fillAccountSelect($('#eAccount'));
    if (c.account) $('#eAccount').value = c.account.id;
    $('#eMedia').innerHTML = c.media
      ? `Attachment: <strong>${KIND_LABEL[c.media.kind]}</strong> ·
         <a href="/api/media/${c.media.id}" target="_blank">${esc(c.media.name)}</a> (${fmtSize(c.media.size)})`
      : 'No attachment.';
  }
}

async function loadContacts() {
  if (!campaign) return;
  const id = campaign.id;
  const q = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  if (filter) q.set('status', filter);
  let data;
  try {
    data = await api(`/api/campaigns/${id}/contacts?${q}`);
  } catch {
    return;
  }
  if (id !== selectedId) return; // user switched campaign while loading

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  if (page >= pages) {
    page = pages - 1;
    return loadContacts();
  }
  $('#contactRows').innerHTML =
    data.rows
      .map((r) => {
        const detail =
          r.status === 'sent'
            ? new Date(r.sent_at).toLocaleString()
            : r.status === 'failed'
              ? esc(r.error || '')
              : '';
        return `<tr>
          <td>${r.id}</td>
          <td>${esc(r.name)}</td>
          <td>${esc(prettyNumber(r.number))}</td>
          <td><span class="badge ${r.status}">${r.status}</span></td>
          <td class="muted small">${detail}</td>
        </tr>`;
      })
      .join('') || `<tr><td colspan="5" class="muted center">Nothing here.</td></tr>`;
  $('#pageInfo').textContent = `Page ${page + 1} of ${pages} · ${data.total} contact${data.total === 1 ? '' : 's'}`;
  $('#prevPage').disabled = page === 0;
  $('#nextPage').disabled = page >= pages - 1;
}

$('#campaignSelect').addEventListener('change', (e) => {
  selectedId = Number(e.target.value);
  page = 0;
  e.target.blur();
  loadCampaigns();
});

$$('.filters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    page = 0;
    $$('.filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    loadContacts();
  })
);
$('#prevPage').addEventListener('click', () => { page = Math.max(0, page - 1); loadContacts(); });
$('#nextPage').addEventListener('click', () => { page += 1; loadContacts(); });

const campaignAction = (path, method = 'POST') => (e) =>
  run(e.target, async () => {
    await api(`/api/campaigns/${campaign.id}${path}`, method);
    await loadCampaigns();
  });

$('#pauseBtn').addEventListener('click', campaignAction('/pause'));
$('#resumeBtn').addEventListener('click', campaignAction('/resume'));
$('#retryBtn').addEventListener('click', (e) => {
  if (!confirm(`Try the ${campaign.counts.failed} failed contact(s) again? Check first that they did not already receive the message.`)) return;
  campaignAction('/retry-failed')(e);
});
$('#deleteBtn').addEventListener('click', (e) => {
  if (!confirm(`Delete "${campaign.name}" and its contact list? This cannot be undone.`)) return;
  settingsLoadedFor = null;
  campaignAction('', 'DELETE')(e);
});
$('#testDash').addEventListener('click', (e) => sendTest(e.target, campaign.message, 'Ali', campaign.media?.id, campaign.account_id));

$('#saveSettings').addEventListener('click', (e) =>
  run(e.target, async () => {
    await api(`/api/campaigns/${campaign.id}`, 'PATCH', {
      startDate: $('#eStartDate').value,
      dailyLimit: $('#eDaily').value,
      windowStart: $('#eStart').value,
      windowEnd: $('#eEnd').value,
      delayMin: $('#eDelayMin').value,
      delayMax: $('#eDelayMax').value,
      message: $('#eMessage').value,
      accountId: $('#eAccount').value || undefined,
    });
    settingsLoadedFor = null;
    toast('Settings saved.');
    await loadCampaigns();
  })
);

// ================= start =================
renderAttachment();
pollAccounts().then(() => {
  if (accounts.some((a) => a.state === 'connected')) showTab('dashboard');
});
setInterval(pollAccounts, 2000);
setInterval(() => {
  if (document.hidden) return;
  if (currentTab === 'dashboard') loadCampaigns();
  // The scraper page only needs refreshing while a search is running.
  if (currentTab === 'scraper' && (!scrape || scrape.status === 'running')) loadScrapes();
}, 2000);
