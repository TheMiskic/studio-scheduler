/* Shared helpers: configuration, time math, booking hours, recurring rules, validation.
   Loaded by both the public calendar and the admin editor. No dependencies. */

const DATA_PATH = 'data/bookings.json';
const DATA_VERSION = 2;

const DEFAULT_CONFIG = {
  studioName: 'Studio',
  timezone: 'Europe/Belgrade',
  slotMinutes: 30,
  weekStart: 1,
  hours: {
    weekendDays: [0, 6],
    weekday: { open: '16:00', close: '24:00' },
    weekend: { open: '12:00', close: '24:00' }
  },
  contact: { label: '', href: '' },
  repo: { owner: '', name: '', branch: 'main' }
};

async function loadConfig() {
  try {
    const res = await fetch('config.json?v=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return mergeConfig(DEFAULT_CONFIG, await res.json());
  } catch (err) {
    console.warn('config.json could not be loaded, falling back to defaults.', err);
    return mergeConfig(DEFAULT_CONFIG, {});
  }
}

function mergeConfig(base, override) {
  const out = Object.assign({}, base, override);
  out.hours = Object.assign({}, base.hours, override.hours);
  out.hours.weekday = Object.assign({}, base.hours.weekday, (override.hours || {}).weekday);
  out.hours.weekend = Object.assign({}, base.hours.weekend, (override.hours || {}).weekend);
  out.contact = Object.assign({}, base.contact, override.contact);
  out.repo = Object.assign({}, base.repo, override.repo);
  return out;
}

/* Older files carried only one-off bookings. Normalize both shapes into version 2. */
function normalizeData(data) {
  const out = data && typeof data === 'object' ? data : {};
  if (!Array.isArray(out.bookings)) out.bookings = [];
  if (!Array.isArray(out.recurring)) out.recurring = [];
  out.version = DATA_VERSION;
  return out;
}

/* ---------- time ---------- */

/* Minutes since midnight, 0 to 1440. 24:00 is 1440 and needs no special case. */
const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const m = TIME_RE.exec(String(hhmm).trim());
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return total > 1440 ? null : total;
}

function toTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function rangeLabel(start, end) {
  return start + ' – ' + end;
}

/* ---------- dates ----------
   Dates are parsed field by field so they stay local. new Date('2026-09-14')
   parses as UTC and shifts the day for anyone west of Greenwich. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(str) {
  const m = DATE_RE.exec(String(str).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

function formatDate(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function todayString() {
  return formatDate(new Date());
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function monthKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function parseMonthKey(str) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Number(m[1]), month - 1, 1);
}

const LOCALE = 'sr-RS';

const DAY_NAMES = ['Nedelja', 'Ponedeljak', 'Utorak', 'Sreda', 'Četvrtak', 'Petak', 'Subota'];

/* Adverbial form for repeating rules: "Ponedeljkom 18:00 – 19:30". */
const DAY_NAMES_EVERY = ['nedeljom', 'ponedeljkom', 'utorkom', 'sredom', 'četvrtkom', 'petkom', 'subotom'];

/* Nominative for headings such as "Septembar 2026". */
const MONTH_NAMES = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];

/* Genitive for full dates: "14. septembra 2026." */
const MONTH_NAMES_GENITIVE = ['januara', 'februara', 'marta', 'aprila', 'maja', 'juna',
  'jula', 'avgusta', 'septembra', 'oktobra', 'novembra', 'decembra'];

function longDateLabel(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return dateStr;
  return DAY_NAMES[date.getDay()] + ', ' + date.getDate() + '. ' +
    MONTH_NAMES_GENITIVE[date.getMonth()] + ' ' + date.getFullYear() + '.';
}

function shortDateLabel(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return dateStr;
  return date.getDate() + '. ' + (date.getMonth() + 1) + '. ' + date.getFullYear() + '.';
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* Weekday column headers, rotated to the configured first day of the week. */
function weekdayHeaders(config) {
  const short = ['Ned', 'Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub'];
  const out = [];
  for (let i = 0; i < 7; i++) out.push(short[(config.weekStart + i) % 7]);
  return out;
}

/* ---------- booking hours ---------- */

function isWeekendDay(weekday, config) {
  return config.hours.weekendDays.indexOf(weekday) !== -1;
}

function isWeekend(dateStr, config) {
  const date = parseDate(dateStr);
  if (!date) return false;
  return isWeekendDay(date.getDay(), config);
}

/* The bookable window for a weekday index, in minutes since midnight. */
function windowForWeekday(weekday, config) {
  const weekend = isWeekendDay(weekday, config);
  const hours = weekend ? config.hours.weekend : config.hours.weekday;
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  const from = open === null ? 0 : open;
  const to = close === null ? 1440 : close;
  return { open: from, close: to, isWeekend: weekend, label: toTime(from) + ' – ' + toTime(to) };
}

function dayWindow(dateStr, config) {
  const date = parseDate(dateStr);
  return windowForWeekday(date ? date.getDay() : 1, config);
}

/* Every slot boundary inside a window, including the closing time. */
function slotBoundariesForWindow(win, config) {
  const step = Math.max(5, Number(config.slotMinutes) || 30);
  const out = [];
  for (let m = win.open; m <= win.close; m += step) out.push(m);
  if (out.length && out[out.length - 1] !== win.close) out.push(win.close);
  return out;
}

function slotBoundaries(dateStr, config) {
  return slotBoundariesForWindow(dayWindow(dateStr, config), config);
}

/* ---------- identifiers ---------- */

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

function newId() {
  return 'b_' + randomHex(4);
}

function newRuleId() {
  return 'r_' + randomHex(4);
}

/* ---------- one-off bookings ---------- */

function sortBookings(list) {
  return list.slice().sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.start.localeCompare(b.start) ||
    a.id.localeCompare(b.id));
}

function sortRules(list) {
  return list.slice().sort((a, b) =>
    a.weekday - b.weekday ||
    a.start.localeCompare(b.start) ||
    a.id.localeCompare(b.id));
}

function bookingsForDate(list, dateStr) {
  return sortBookings(list.filter(b => b.date === dateStr));
}

/* ---------- recurring rules ----------
   A rule repeats on one weekday from `from` onwards. `until` null means it never
   ends; `skip` holds dates where that week's occurrence was cancelled. */

function ruleAppliesOn(rule, dateStr) {
  const date = parseDate(dateStr);
  if (!date || date.getDay() !== rule.weekday) return false;
  if (rule.from && dateStr < rule.from) return false;
  if (rule.until && dateStr > rule.until) return false;
  if (Array.isArray(rule.skip) && rule.skip.indexOf(dateStr) !== -1) return false;
  return true;
}

/* One rule occurrence, shaped like a booking so the same rendering and overlap
   code works for both. `ruleId` marks it as generated rather than stored. */
function occurrenceOf(rule, dateStr) {
  return {
    id: rule.id + '@' + dateStr,
    ruleId: rule.id,
    date: dateStr,
    start: rule.start,
    end: rule.end,
    name: rule.name,
    recurring: true
  };
}

/* Everything happening on one date: stored bookings plus expanded rules. */
function occurrencesForDate(data, dateStr) {
  const out = (data.bookings || []).filter(b => b.date === dateStr);
  for (const rule of (data.recurring || [])) {
    if (ruleAppliesOn(rule, dateStr)) out.push(occurrenceOf(rule, dateStr));
  }
  return sortBookings(out);
}

function occurrencesForMonth(data, monthStr) {
  const first = parseMonthKey(monthStr);
  if (!first) return [];
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  let out = [];
  for (let d = 1; d <= days; d++) {
    out = out.concat(occurrencesForDate(data, formatDate(new Date(first.getFullYear(), first.getMonth(), d))));
  }
  return out;
}

/* Do two open-ended date ranges intersect? A null end means "no end". */
function rangesOverlap(aFrom, aUntil, bFrom, bUntil) {
  if (aUntil && bFrom && bFrom > aUntil) return false;
  if (bUntil && aFrom && aFrom > bUntil) return false;
  return true;
}

/* Dates on which a rule would fire inside a range, ignoring skips. */
function ruleDatesBetween(rule, fromStr, untilStr, limit) {
  const out = [];
  const start = parseDate(fromStr);
  const end = parseDate(untilStr);
  if (!start || !end) return out;
  let cursor = start;
  while (cursor.getDay() !== rule.weekday) cursor = addDays(cursor, 1);
  while (cursor <= end && out.length < (limit || 500)) {
    out.push(formatDate(cursor));
    cursor = addDays(cursor, 7);
  }
  return out;
}

/* ---------- overlap ---------- */

/* Half-open intervals: a slot ending at 19:30 and one starting at 19:30 do not conflict. */
function overlaps(a, b) {
  if (a.date !== b.date) return false;
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

function findConflict(booking, list) {
  return list.find(other => other.id !== booking.id && overlaps(booking, other)) || null;
}

/* Unbooked stretches inside a date's window, for display on the public page. */
function freeRanges(dateStr, occurrences, config) {
  const win = dayWindow(dateStr, config);
  const out = [];
  let cursor = win.open;
  for (const b of sortBookings(occurrences)) {
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (start > cursor) out.push({ start: toTime(cursor), end: toTime(start) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < win.close) out.push({ start: toTime(cursor), end: toTime(win.close) });
  return out;
}

/* ---------- validation ---------- */

function checkTimes(start, end, win, step, errors) {
  if ((start - win.open) % step !== 0 || (end - win.open) % step !== 0) {
    errors.push('Vremena moraju biti u koracima od ' + step + ' minuta.');
  }
  if (start >= end) {
    errors.push('Kraj mora biti posle početka.');
  }
  if (start < win.open || end > win.close) {
    errors.push((win.isWeekend ? 'Vikendom' : 'Radnim danima') + ' termini su mogući ' +
      win.label + '. Izaberite vreme u tom opsegu.');
  }
}

function checkName(name, errors) {
  const trimmed = String(name || '').trim();
  if (!trimmed) errors.push('Unesite ime za termin.');
  else if (trimmed.length > 60) errors.push('Ime sme imati najviše 60 karaktera.');
}

/* A single dated booking, checked against everything happening that day. */
function validateBooking(booking, occurrences, config) {
  const errors = [];
  const warnings = [];

  const date = parseDate(booking.date);
  if (!date) {
    errors.push('Izaberite ispravan datum.');
    return { errors, warnings };
  }

  const start = toMinutes(booking.start);
  const end = toMinutes(booking.end);
  if (start === null || end === null) {
    errors.push('Početak i kraj moraju biti u obliku HH:MM.');
    return { errors, warnings };
  }

  const step = Math.max(5, Number(config.slotMinutes) || 30);
  checkTimes(start, end, dayWindow(booking.date, config), step, errors);
  checkName(booking.name, errors);

  const conflict = findConflict(booking, occurrences);
  if (conflict) {
    errors.push('Preklapa se sa ' + (conflict.recurring ? 'stalnim' : 'postojećim') + ' terminom: ' +
      rangeLabel(conflict.start, conflict.end) + ' (' + conflict.name + ').');
  }

  if (booking.date < todayString()) {
    warnings.push('Ovaj datum je u prošlosti.');
  }

  return { errors, warnings };
}

/* A weekly rule, checked against other rules and against every dated booking it
   would collide with. Rules with no end date are compared over a two-year horizon,
   which is far past the point where a conflict would already have shown up. */
function validateRule(rule, data, config) {
  const errors = [];
  const warnings = [];

  if (!(rule.weekday >= 0 && rule.weekday <= 6)) {
    errors.push('Izaberite dan u nedelji.');
    return { errors, warnings };
  }
  if (!parseDate(rule.from)) {
    errors.push('Izaberite datum prvog termina.');
    return { errors, warnings };
  }
  if (parseDate(rule.from).getDay() !== rule.weekday) {
    errors.push('Datum prvog termina mora pasti na ' + DAY_NAMES[rule.weekday].toLowerCase() + '.');
  }
  if (rule.until) {
    if (!parseDate(rule.until)) errors.push('Datum kraja ponavljanja nije ispravan.');
    else if (rule.until < rule.from) errors.push('Kraj ponavljanja mora biti posle prvog termina.');
  }

  const start = toMinutes(rule.start);
  const end = toMinutes(rule.end);
  if (start === null || end === null) {
    errors.push('Početak i kraj moraju biti u obliku HH:MM.');
    return { errors, warnings };
  }

  const step = Math.max(5, Number(config.slotMinutes) || 30);
  checkTimes(start, end, windowForWeekday(rule.weekday, config), step, errors);
  checkName(rule.name, errors);

  for (const other of (data.recurring || [])) {
    if (other.id === rule.id) continue;
    if (other.weekday !== rule.weekday) continue;
    if (!rangesOverlap(rule.from, rule.until, other.from, other.until)) continue;
    if (!timesOverlap(rule.start, rule.end, other.start, other.end)) continue;
    errors.push('Preklapa se sa stalnim terminom ' + DAY_NAMES_EVERY[other.weekday] + ' ' +
      rangeLabel(other.start, other.end) + ' (' + other.name + ').');
    break;
  }

  const horizon = rule.until || formatDate(addDays(new Date(), 730));
  const dates = ruleDatesBetween(rule, rule.from, horizon);
  const skip = Array.isArray(rule.skip) ? rule.skip : [];
  for (const dateStr of dates) {
    if (skip.indexOf(dateStr) !== -1) continue;
    const clash = (data.bookings || []).find(b =>
      b.date === dateStr && timesOverlap(rule.start, rule.end, b.start, b.end));
    if (clash) {
      errors.push('Preklapa se sa pojedinačnim terminom ' + shortDateLabel(dateStr) + ' ' +
        rangeLabel(clash.start, clash.end) + ' (' + clash.name + ').');
      break;
    }
  }

  return { errors, warnings };
}

function ruleLabel(rule) {
  let text = capitalize(DAY_NAMES_EVERY[rule.weekday]) + ' ' + rangeLabel(rule.start, rule.end) +
    ' · ' + rule.name;
  if (rule.until) text += ' · ' + shortDateLabel(rule.from) + ' – ' + shortDateLabel(rule.until);
  else text += ' · od ' + shortDateLabel(rule.from);
  return text;
}
