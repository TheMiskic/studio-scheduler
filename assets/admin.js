/* Admin editor. Reads and writes data/bookings.json through the GitHub contents API
   using a token supplied by the owner and held in this browser only. */

const TOKEN_KEY = 'studio-scheduler.token';
const REPO_KEY = 'studio-scheduler.repo';

const admin = {
  config: null,
  repo: { owner: '', name: '', branch: 'main' },
  token: '',
  data: null,
  sha: null,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  editingId: null,
  busy: false
};

const el = id => document.getElementById(id);

class ValidationError extends Error {
  constructor(messages) {
    super(messages.join(' '));
    this.messages = messages;
  }
}

init();

async function init() {
  admin.config = await loadConfig();
  el('studio-name').textContent = admin.config.studioName;
  const weekday = admin.config.hours.weekday;
  const weekend = admin.config.hours.weekend;
  el('hours-summary').textContent =
    'Termini pon–pet ' + weekday.open + '–' + weekday.close +
    ' · sub–ned ' + weekend.open + '–' + weekend.close + ' · ' + admin.config.timezone;

  restoreSettings();
  bindEvents();

  el('f-date').value = todayString();
  refreshTimeOptions();
  renderList();

  if (admin.token && admin.repo.owner && admin.repo.name) await refresh();
  else setConnected(false, 'Niste povezani — otvorite Podešavanja i unesite token');
}

/* ---------- settings ---------- */

function restoreSettings() {
  const detected = detectRepo();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(REPO_KEY) || 'null'); } catch (err) { saved = null; }

  admin.repo = {
    owner: (saved && saved.owner) || admin.config.repo.owner || detected.owner || '',
    name: (saved && saved.name) || admin.config.repo.name || detected.name || '',
    branch: (saved && saved.branch) || admin.config.repo.branch || 'main'
  };
  admin.token = localStorage.getItem(TOKEN_KEY) || '';

  el('repo-owner').value = admin.repo.owner;
  el('repo-name').value = admin.repo.name;
  el('repo-branch').value = admin.repo.branch;
  el('token').value = admin.token;
  if (!admin.token) el('conn-panel').classList.remove('collapsed');
}

/* Pages serves either {owner}.github.io/{repo}/ or {owner}.github.io/ for a user site. */
function detectRepo() {
  const host = location.hostname;
  const match = /^([\w-]+)\.github\.io$/i.exec(host);
  if (!match) return { owner: '', name: '' };
  const owner = match[1];
  const segment = location.pathname.split('/').filter(Boolean)[0];
  return { owner, name: segment || owner + '.github.io' };
}

function saveSettings() {
  admin.repo = {
    owner: el('repo-owner').value.trim(),
    name: el('repo-name').value.trim(),
    branch: el('repo-branch').value.trim() || 'main'
  };
  admin.token = el('token').value.trim();
  localStorage.setItem(REPO_KEY, JSON.stringify(admin.repo));
  if (admin.token) localStorage.setItem(TOKEN_KEY, admin.token);
  else localStorage.removeItem(TOKEN_KEY);
}

function clearSettings() {
  localStorage.removeItem(TOKEN_KEY);
  admin.token = '';
  admin.data = null;
  admin.sha = null;
  el('token').value = '';
  setConnected(false, 'Veza prekinuta');
  renderList();
}

/* ---------- events ---------- */

function bindEvents() {
  el('conn-toggle').addEventListener('click', () => el('conn-panel').classList.toggle('collapsed'));
  el('conn-save').addEventListener('click', async () => {
    saveSettings();
    clearMessages();
    if (!admin.token) { setConnected(false, 'Unesite token da biste se povezali'); return; }
    if (!admin.repo.owner || !admin.repo.name) { showError(['Popunite polja Vlasnik i Repozitorijum.']); return; }
    const ok = await refresh();
    if (ok) el('conn-panel').classList.add('collapsed');
  });
  el('conn-clear').addEventListener('click', clearSettings);

  el('f-date').addEventListener('change', refreshTimeOptions);
  el('f-start').addEventListener('change', () => refreshEndOptions());
  el('f-submit').addEventListener('click', submitForm);
  el('f-cancel').addEventListener('click', exitEditMode);

  el('prev-month').addEventListener('click', () => shiftMonth(-1));
  el('next-month').addEventListener('click', () => shiftMonth(1));
  el('this-month').addEventListener('click', () => {
    const now = new Date();
    admin.month = new Date(now.getFullYear(), now.getMonth(), 1);
    renderList();
  });
  el('reload').addEventListener('click', () => { clearMessages(); refresh(); });
}

function shiftMonth(delta) {
  admin.month = new Date(admin.month.getFullYear(), admin.month.getMonth() + delta, 1);
  renderList();
}

/* ---------- GitHub API ---------- */

function apiUrl() {
  return 'https://api.github.com/repos/' +
    encodeURIComponent(admin.repo.owner) + '/' +
    encodeURIComponent(admin.repo.name) + '/contents/' + DATA_PATH;
}

function apiHeaders() {
  return {
    'Authorization': 'Bearer ' + admin.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function fetchFile() {
  const res = await fetch(apiUrl() + '?ref=' + encodeURIComponent(admin.repo.branch) + '&t=' + Date.now(), {
    headers: apiHeaders(),
    cache: 'no-store'
  });
  if (!res.ok) throw await apiError(res, 'read');
  const payload = await res.json();
  let data;
  try {
    data = JSON.parse(base64ToText(payload.content));
  } catch (err) {
    throw new Error('data/bookings.json u repozitorijumu nije ispravan JSON. Ispravite ga na GitHub-u, pa osvežite.');
  }
  if (!Array.isArray(data.bookings)) data.bookings = [];
  return { data, sha: payload.sha };
}

async function putFile(text, sha, message) {
  return fetch(apiUrl(), {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
    body: JSON.stringify({
      message,
      content: textToBase64(text),
      sha,
      branch: admin.repo.branch
    })
  });
}

/* Read fresh, apply the change against that copy, write. A conflicting commit in
   between moves the SHA, so the whole cycle is replayed once before giving up. */
async function commitChange(message, apply) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await fetchFile();
    apply(remote.data);
    remote.data.version = 1;
    remote.data.bookings = sortBookings(remote.data.bookings);
    remote.data.updated = new Date().toISOString();

    const body = JSON.stringify(remote.data, null, 2) + '\n';
    const res = await putFile(body, remote.sha, message);
    if (res.ok) {
      admin.data = remote.data;
      const payload = await res.json();
      admin.sha = payload.content ? payload.content.sha : null;
      return;
    }
    if ((res.status === 409 || res.status === 422) && attempt === 0) continue;
    throw await apiError(res, 'write');
  }
  throw new Error('Fajl je u međuvremenu izmenjen u repozitorijumu. Osvežite i pokušajte ponovo.');
}

async function apiError(res, phase) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body && body.message ? body.message : '';
  } catch (err) { /* body was not JSON */ }

  if (res.status === 401) return new Error('Token je odbijen. Možda je istekao ili je pogrešno unet.');
  if (res.status === 403) {
    return new Error('Pristup odbijen. Token mora imati Contents: Read and write za ovaj repozitorijum. ' + detail);
  }
  if (res.status === 404) {
    return new Error('Nije pronađeno: ' + admin.repo.owner + '/' + admin.repo.name + ' na putanji ' + DATA_PATH +
      ', grana ' + admin.repo.branch + '. Proverite podešavanja i da li token ima pristup ovom repozitorijumu.');
  }
  if (res.status === 409 || res.status === 422) {
    return new Error('Fajl je u međuvremenu izmenjen u repozitorijumu. Osvežite i pokušajte ponovo.');
  }
  const action = phase === 'read' ? 'čitanju' : 'upisu';
  return new Error('GitHub je vratio ' + res.status + ' pri ' + action + ' fajla. ' + detail);
}

/* Round-trip through TextEncoder/TextDecoder so non-ASCII names survive base64. */
function base64ToText(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ---------- data flow ---------- */

async function refresh() {
  if (!admin.token || !admin.repo.owner || !admin.repo.name) return false;
  setBusy(true);
  try {
    const remote = await fetchFile();
    admin.data = remote.data;
    admin.sha = remote.sha;
    setConnected(true, admin.repo.owner + '/' + admin.repo.name + ' · ' + admin.repo.branch);
    renderList();
    return true;
  } catch (err) {
    setConnected(false, 'Povezivanje nije uspelo');
    showError([err.message]);
    renderList();
    return false;
  } finally {
    setBusy(false);
  }
}

function currentBookings() {
  return admin.data && Array.isArray(admin.data.bookings) ? admin.data.bookings : [];
}

/* ---------- form ---------- */

function refreshTimeOptions() {
  const dateStr = el('f-date').value;
  const startSelect = el('f-start');
  const previous = startSelect.value;

  if (!parseDate(dateStr)) {
    startSelect.textContent = '';
    el('f-end').textContent = '';
    el('f-window').textContent = '';
    return;
  }

  const win = dayWindow(dateStr, admin.config);
  el('f-window').textContent =
    (win.isWeekend ? 'Vikend' : 'Radni dan') + ': termini ' + win.label + '.';

  const boundaries = slotBoundaries(dateStr, admin.config);
  fillOptions(startSelect, boundaries.slice(0, -1));
  if (boundaries.map(toTime).indexOf(previous) !== -1 && previous !== toTime(win.close)) {
    startSelect.value = previous;
  }
  refreshEndOptions();
}

function refreshEndOptions() {
  const dateStr = el('f-date').value;
  const endSelect = el('f-end');
  const previous = endSelect.value;
  if (!parseDate(dateStr)) return;

  const start = toMinutes(el('f-start').value);
  const boundaries = slotBoundaries(dateStr, admin.config).filter(m => start === null || m > start);
  fillOptions(endSelect, boundaries);
  if (boundaries.map(toTime).indexOf(previous) !== -1) endSelect.value = previous;
}

function fillOptions(select, minutesList) {
  select.textContent = '';
  for (const minutes of minutesList) {
    const option = document.createElement('option');
    option.value = toTime(minutes);
    option.textContent = toTime(minutes);
    select.appendChild(option);
  }
}

function readForm() {
  return {
    id: admin.editingId || newId(),
    date: el('f-date').value,
    start: el('f-start').value,
    end: el('f-end').value,
    name: el('f-name').value.trim()
  };
}

async function submitForm() {
  clearMessages();
  if (admin.busy) return;

  if (!admin.token) {
    showError(['Povežite se tokenom pre čuvanja. Otvorite Podešavanja iznad.']);
    el('conn-panel').classList.remove('collapsed');
    return;
  }
  if (!admin.data) {
    showError(['Raspored još nije učitan. Pritisnite Osveži.']);
    return;
  }

  const booking = readForm();
  const check = validateBooking(booking, currentBookings(), admin.config);
  if (check.errors.length) { showError(check.errors); return; }

  const editing = Boolean(admin.editingId);
  const label = booking.date + ' ' + booking.start + '-' + booking.end + ' (' + booking.name + ')';
  const message = (editing ? 'Edit booking: ' : 'Add booking: ') + label;

  setBusy(true);
  try {
    await commitChange(message, data => {
      const others = data.bookings.filter(b => b.id !== booking.id);
      const recheck = validateBooking(booking, others, admin.config);
      if (recheck.errors.length) throw new ValidationError(recheck.errors);
      data.bookings = others.concat([booking]);
    });
    exitEditMode();
    el('f-name').value = '';
    renderList();
    showOk((editing ? 'Sačuvano: ' : 'Dodato: ') + label + '. Javni kalendar se ažurira za oko minut.');
    if (check.warnings.length) showWarn(check.warnings);
  } catch (err) {
    showError(err instanceof ValidationError ? err.messages : [err.message]);
  } finally {
    setBusy(false);
  }
}

function enterEditMode(booking) {
  admin.editingId = booking.id;
  el('form-title').textContent = 'Izmena termina';
  el('f-submit').textContent = 'Sačuvaj izmene';
  el('f-cancel').hidden = false;
  el('f-date').value = booking.date;
  refreshTimeOptions();
  el('f-start').value = booking.start;
  refreshEndOptions();
  el('f-end').value = booking.end;
  el('f-name').value = booking.name;
  el('f-name').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitEditMode() {
  admin.editingId = null;
  el('form-title').textContent = 'Novi termin';
  el('f-submit').textContent = 'Dodaj termin';
  el('f-cancel').hidden = true;
}

async function deleteBooking(booking) {
  const label = booking.date + ' ' + booking.start + '-' + booking.end + ' (' + booking.name + ')';
  if (!confirm('Obrisati ovaj termin?\n\n' + label)) return;

  clearMessages();
  setBusy(true);
  try {
    await commitChange('Delete booking: ' + label, data => {
      data.bookings = data.bookings.filter(b => b.id !== booking.id);
    });
    if (admin.editingId === booking.id) exitEditMode();
    renderList();
    showOk('Obrisano: ' + label + '. Javni kalendar se ažurira za oko minut.');
  } catch (err) {
    showError([err.message]);
  } finally {
    setBusy(false);
  }
}

/* ---------- rendering ---------- */

function renderList() {
  const month = monthKey(admin.month);
  el('list-title').textContent = MONTH_NAMES[admin.month.getMonth()] + ' ' + admin.month.getFullYear();

  const box = el('list');
  box.textContent = '';

  if (!admin.data) {
    el('list-empty').hidden = false;
    el('list-empty').textContent = admin.token
      ? 'Nije učitano. Pritisnite Osveži.'
      : 'Povežite se tokenom da biste videli i menjali termine.';
    return;
  }

  const slots = bookingsForMonth(currentBookings(), month);
  el('list-empty').hidden = slots.length > 0;
  el('list-empty').textContent = 'Nema termina u ovom mesecu.';

  let group = null;
  let currentDate = null;
  for (const booking of slots) {
    if (booking.date !== currentDate) {
      currentDate = booking.date;
      group = document.createElement('div');
      group.className = 'date-group';
      const heading = document.createElement('h3');
      heading.textContent = longDateLabel(booking.date);
      const list = document.createElement('ul');
      list.className = 'slot-list';
      group.append(heading, list);
      box.appendChild(group);
    }

    const li = document.createElement('li');
    li.className = 'slot';

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = rangeLabel(booking.start, booking.end);

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = booking.name;

    const actions = document.createElement('span');
    actions.className = 'slot-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'small';
    edit.textContent = 'Izmeni';
    edit.addEventListener('click', () => enterEditMode(booking));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'small danger';
    remove.textContent = 'Obriši';
    remove.addEventListener('click', () => deleteBooking(booking));

    actions.append(edit, remove);
    li.append(time, name, actions);
    group.lastChild.appendChild(li);
  }

  if (admin.data.updated) {
    const when = new Date(admin.data.updated);
    if (!isNaN(when)) el('updated-note').textContent = 'Fajl ažuriran ' + when.toLocaleString(LOCALE);
  }
}

function setConnected(ok, text) {
  el('conn-dot').className = 'status-dot ' + (ok ? 'on' : 'off');
  el('conn-status').textContent = text;
}

function setBusy(busy) {
  admin.busy = busy;
  for (const id of ['f-submit', 'reload', 'conn-save']) el(id).disabled = busy;
  el('f-submit').textContent = busy
    ? 'Čuvanje…'
    : (admin.editingId ? 'Sačuvaj izmene' : 'Dodaj termin');
}

function clearMessages() {
  for (const id of ['msg-error', 'msg-warn', 'msg-ok']) {
    const node = el(id);
    node.hidden = true;
    node.textContent = '';
  }
}

function showList(id, messages) {
  const node = el(id);
  node.textContent = '';
  if (messages.length === 1) {
    node.textContent = messages[0];
  } else {
    const ul = document.createElement('ul');
    for (const text of messages) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    }
    node.appendChild(ul);
  }
  node.hidden = false;
}

function showError(messages) { showList('msg-error', messages); }
function showWarn(messages) { showList('msg-warn', messages); }
function showOk(message) { showList('msg-ok', [message]); }
