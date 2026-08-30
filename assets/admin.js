/* Admin editor. Reads and writes data/bookings.json through the GitHub contents API
   using a token supplied by the owner and held in this browser only.

   Two kinds of entry live in that file: one-off bookings with a date, and weekly
   rules that repeat on a weekday until cancelled. Rules are stored once and expanded
   for display, so a permanent slot stays one line in the file no matter how long it runs. */

const TOKEN_KEY = 'studio-scheduler.token';
const REPO_KEY = 'studio-scheduler.repo';

/* Commit messages stay in English: they are repository metadata, not interface text. */
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const admin = {
  config: null,
  repo: { owner: '', name: '', branch: 'main' },
  token: '',
  data: null,
  sha: null,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  editing: null,
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
  renderAll();

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
  renderAll();
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

  el('f-repeat').addEventListener('change', applyRepeatMode);
  el('f-date').addEventListener('change', () => { refreshTimeOptions(); applyRepeatMode(); });
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
  return { data: normalizeData(data), sha: payload.sha };
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
    remote.data.version = DATA_VERSION;
    remote.data.bookings = sortBookings(remote.data.bookings);
    remote.data.recurring = sortRules(remote.data.recurring);
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
    renderAll();
    return true;
  } catch (err) {
    setConnected(false, 'Povezivanje nije uspelo');
    showError([err.message]);
    renderAll();
    return false;
  } finally {
    setBusy(false);
  }
}

function currentData() {
  return admin.data || normalizeData(null);
}

/* ---------- form ---------- */

function isWeeklyMode() {
  return el('f-repeat').value === 'weekly';
}

function applyRepeatMode() {
  const weekly = isWeeklyMode();
  el('f-until-field').hidden = !weekly;
  el('f-date-label').textContent = weekly ? 'Prvi termin' : 'Datum';

  const hint = el('f-window');
  const dateStr = el('f-date').value;
  if (!parseDate(dateStr)) { hint.textContent = ''; return; }

  const win = dayWindow(dateStr, admin.config);
  const base = (win.isWeekend ? 'Vikend' : 'Radni dan') + ': termini ' + win.label + '.';
  hint.textContent = weekly
    ? base + ' Ponavlja se ' + DAY_NAMES_EVERY[parseDate(dateStr).getDay()] + '.'
    : base;
}

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
  const boundaries = slotBoundaries(dateStr, admin.config);
  fillOptions(startSelect, boundaries.slice(0, -1));
  if (boundaries.map(toTime).indexOf(previous) !== -1 && previous !== toTime(win.close)) {
    startSelect.value = previous;
  }
  refreshEndOptions();
  applyRepeatMode();
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

function editingRule() {
  return admin.editing && admin.editing.kind === 'rule' ? admin.editing : null;
}

function readBookingForm() {
  return {
    id: admin.editing && admin.editing.kind === 'booking' ? admin.editing.id : newId(),
    date: el('f-date').value,
    start: el('f-start').value,
    end: el('f-end').value,
    name: el('f-name').value.trim()
  };
}

function readRuleForm() {
  const editing = editingRule();
  const date = parseDate(el('f-date').value);
  return {
    id: editing ? editing.id : newRuleId(),
    weekday: date ? date.getDay() : -1,
    start: el('f-start').value,
    end: el('f-end').value,
    name: el('f-name').value.trim(),
    from: el('f-date').value,
    until: el('f-until').value || null,
    skip: editing ? (editing.skip || []) : []
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

  if (isWeeklyMode()) await submitRule();
  else await submitBooking();
}

async function submitBooking() {
  const booking = readBookingForm();
  const check = validateBooking(booking, occurrencesForDate(currentData(), booking.date), admin.config);
  if (check.errors.length) { showError(check.errors); return; }

  const editing = Boolean(admin.editing);
  const label = booking.date + ' ' + booking.start + '-' + booking.end + ' (' + booking.name + ')';
  const message = (editing ? 'Edit booking: ' : 'Add booking: ') + label;

  setBusy(true);
  try {
    await commitChange(message, data => {
      const others = data.bookings.filter(b => b.id !== booking.id);
      const recheck = validateBooking(booking,
        occurrencesForDate({ bookings: others, recurring: data.recurring }, booking.date), admin.config);
      if (recheck.errors.length) throw new ValidationError(recheck.errors);
      data.bookings = others.concat([booking]);
    });
    finishSubmit(editing ? 'Sačuvano: ' : 'Dodato: ', label, check.warnings);
  } catch (err) {
    showError(err instanceof ValidationError ? err.messages : [err.message]);
  } finally {
    setBusy(false);
  }
}

async function submitRule() {
  const rule = readRuleForm();
  const check = validateRule(rule, currentData(), admin.config);
  if (check.errors.length) { showError(check.errors); return; }

  const editing = Boolean(editingRule());
  const label = EN_DAYS[rule.weekday] + ' ' + rule.start + '-' + rule.end + ' (' + rule.name + ')' +
    ' from ' + rule.from + (rule.until ? ' until ' + rule.until : '');
  const message = (editing ? 'Edit weekly schedule: ' : 'Add weekly schedule: ') + label;

  setBusy(true);
  try {
    await commitChange(message, data => {
      const others = data.recurring.filter(r => r.id !== rule.id);
      const recheck = validateRule(rule, { bookings: data.bookings, recurring: others }, admin.config);
      if (recheck.errors.length) throw new ValidationError(recheck.errors);
      data.recurring = others.concat([rule]);
    });
    finishSubmit(editing ? 'Sačuvan stalni termin: ' : 'Dodat stalni termin: ', ruleLabel(rule), check.warnings);
  } catch (err) {
    showError(err instanceof ValidationError ? err.messages : [err.message]);
  } finally {
    setBusy(false);
  }
}

function finishSubmit(prefix, label, warnings) {
  exitEditMode();
  el('f-name').value = '';
  renderAll();
  showOk(prefix + label + ' · Javni kalendar se ažurira za oko minut.');
  if (warnings && warnings.length) showWarn(warnings);
}

/* ---------- edit modes ---------- */

function enterBookingEdit(booking) {
  admin.editing = { kind: 'booking', id: booking.id };
  el('form-title').textContent = 'Izmena termina';
  el('f-submit').textContent = 'Sačuvaj izmene';
  el('f-cancel').hidden = false;
  el('f-repeat').value = 'once';
  el('f-repeat').disabled = true;
  el('f-date').value = booking.date;
  refreshTimeOptions();
  el('f-start').value = booking.start;
  refreshEndOptions();
  el('f-end').value = booking.end;
  el('f-name').value = booking.name;
  focusForm();
}

function enterRuleEdit(rule) {
  admin.editing = { kind: 'rule', id: rule.id, skip: rule.skip || [] };
  el('form-title').textContent = 'Izmena stalnog termina';
  el('f-submit').textContent = 'Sačuvaj izmene';
  el('f-cancel').hidden = false;
  el('f-repeat').value = 'weekly';
  el('f-repeat').disabled = true;
  el('f-date').value = rule.from;
  refreshTimeOptions();
  el('f-start').value = rule.start;
  refreshEndOptions();
  el('f-end').value = rule.end;
  el('f-until').value = rule.until || '';
  el('f-name').value = rule.name;
  focusForm();
}

function focusForm() {
  el('f-name').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitEditMode() {
  admin.editing = null;
  el('form-title').textContent = 'Novi termin';
  el('f-submit').textContent = 'Dodaj termin';
  el('f-cancel').hidden = true;
  el('f-repeat').disabled = false;
  el('f-repeat').value = 'once';
  el('f-until').value = '';
  applyRepeatMode();
}

/* ---------- deletions ---------- */

async function deleteBooking(booking) {
  const label = booking.date + ' ' + booking.start + '-' + booking.end + ' (' + booking.name + ')';
  if (!confirm('Obrisati ovaj termin?\n\n' + label)) return;

  clearMessages();
  setBusy(true);
  try {
    await commitChange('Delete booking: ' + label, data => {
      data.bookings = data.bookings.filter(b => b.id !== booking.id);
    });
    if (admin.editing && admin.editing.id === booking.id) exitEditMode();
    renderAll();
    showOk('Obrisano: ' + label + '. Javni kalendar se ažurira za oko minut.');
  } catch (err) {
    showError([err.message]);
  } finally {
    setBusy(false);
  }
}

async function deleteRule(rule) {
  if (!confirm('Obrisati stalni termin i sva njegova buduća ponavljanja?\n\n' + ruleLabel(rule))) return;

  const label = EN_DAYS[rule.weekday] + ' ' + rule.start + '-' + rule.end + ' (' + rule.name + ')';
  clearMessages();
  setBusy(true);
  try {
    await commitChange('Delete weekly schedule: ' + label, data => {
      data.recurring = data.recurring.filter(r => r.id !== rule.id);
    });
    if (admin.editing && admin.editing.id === rule.id) exitEditMode();
    renderAll();
    showOk('Obrisan stalni termin: ' + ruleLabel(rule) + ' · Javni kalendar se ažurira za oko minut.');
  } catch (err) {
    showError([err.message]);
  } finally {
    setBusy(false);
  }
}

/* Cancel one week of a rule without touching the rest of it. */
async function cancelOccurrence(occurrence) {
  const label = occurrence.date + ' ' + occurrence.start + '-' + occurrence.end + ' (' + occurrence.name + ')';
  if (!confirm('Otkazati samo ovaj termin?\n\n' + longDateLabel(occurrence.date) + '\n' +
      rangeLabel(occurrence.start, occurrence.end) + ' · ' + occurrence.name +
      '\n\nStalni termin ostaje, izostaje samo ovaj datum.')) return;

  clearMessages();
  setBusy(true);
  try {
    await commitChange('Cancel occurrence: ' + label, data => {
      const rule = data.recurring.find(r => r.id === occurrence.ruleId);
      if (!rule) throw new ValidationError(['Stalni termin više ne postoji. Osvežite stranicu.']);
      if (!Array.isArray(rule.skip)) rule.skip = [];
      if (rule.skip.indexOf(occurrence.date) === -1) rule.skip.push(occurrence.date);
      rule.skip.sort();
    });
    renderAll();
    showOk('Otkazan termin ' + shortDateLabel(occurrence.date) + ' · Javni kalendar se ažurira za oko minut.');
  } catch (err) {
    showError(err instanceof ValidationError ? err.messages : [err.message]);
  } finally {
    setBusy(false);
  }
}

async function restoreSkipped(rule) {
  const count = (rule.skip || []).length;
  if (!confirm('Vratiti ' + count + ' otkazanih termina za ovo pravilo?\n\n' + ruleLabel(rule))) return;

  const label = EN_DAYS[rule.weekday] + ' ' + rule.start + '-' + rule.end + ' (' + rule.name + ')';
  clearMessages();
  setBusy(true);
  try {
    await commitChange('Restore cancelled occurrences: ' + label, data => {
      const target = data.recurring.find(r => r.id === rule.id);
      if (target) target.skip = [];
    });
    renderAll();
    showOk('Vraćeni otkazani termini. Javni kalendar se ažurira za oko minut.');
  } catch (err) {
    showError([err.message]);
  } finally {
    setBusy(false);
  }
}

/* ---------- rendering ---------- */

function renderAll() {
  renderRules();
  renderList();
}

function smallButton(text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small' + (className ? ' ' + className : '');
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function renderRules() {
  const list = el('rules-list');
  list.textContent = '';

  if (!admin.data) {
    el('rules-empty').hidden = false;
    el('rules-empty').textContent = admin.token
      ? 'Nije učitano. Pritisnite Osveži.'
      : 'Povežite se tokenom da biste videli stalne termine.';
    return;
  }

  const rules = sortRules(currentData().recurring);
  el('rules-empty').hidden = rules.length > 0;
  el('rules-empty').textContent = 'Nema stalnih termina.';

  for (const rule of rules) {
    const li = document.createElement('li');
    li.className = 'slot';

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = capitalize(DAY_NAMES_EVERY[rule.weekday]) + ' ' + rangeLabel(rule.start, rule.end);

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = rule.name;

    const range = document.createElement('span');
    range.className = 'slot-note';
    range.textContent = rule.until
      ? shortDateLabel(rule.from) + ' – ' + shortDateLabel(rule.until)
      : 'od ' + shortDateLabel(rule.from);

    const actions = document.createElement('span');
    actions.className = 'slot-actions';
    const skipped = (rule.skip || []).length;
    if (skipped) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'otkazano: ' + skipped;
      actions.appendChild(tag);
      actions.appendChild(smallButton('Vrati otkazane', '', () => restoreSkipped(rule)));
    }
    actions.appendChild(smallButton('Izmeni', '', () => enterRuleEdit(rule)));
    actions.appendChild(smallButton('Obriši', 'danger', () => deleteRule(rule)));

    li.append(time, name, range, actions);
    list.appendChild(li);
  }
}

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

  const slots = occurrencesForMonth(currentData(), month);
  el('list-empty').hidden = slots.length > 0;
  el('list-empty').textContent = 'Nema termina u ovom mesecu.';

  let group = null;
  let currentDate = null;
  for (const entry of slots) {
    if (entry.date !== currentDate) {
      currentDate = entry.date;
      group = document.createElement('div');
      group.className = 'date-group';
      const heading = document.createElement('h3');
      heading.textContent = longDateLabel(entry.date);
      const inner = document.createElement('ul');
      inner.className = 'slot-list';
      group.append(heading, inner);
      box.appendChild(group);
    }

    const li = document.createElement('li');
    li.className = 'slot';

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = rangeLabel(entry.start, entry.end);

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = entry.name;

    const actions = document.createElement('span');
    actions.className = 'slot-actions';

    if (entry.recurring) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'stalni';
      actions.appendChild(tag);
      actions.appendChild(smallButton('Otkaži ovaj', '', () => cancelOccurrence(entry)));
      actions.appendChild(smallButton('Izmeni pravilo', '', () => {
        const rule = currentData().recurring.find(r => r.id === entry.ruleId);
        if (rule) enterRuleEdit(rule);
      }));
    } else {
      actions.appendChild(smallButton('Izmeni', '', () => enterBookingEdit(entry)));
      actions.appendChild(smallButton('Obriši', 'danger', () => deleteBooking(entry)));
    }

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
    : (admin.editing ? 'Sačuvaj izmene' : 'Dodaj termin');
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
