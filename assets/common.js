/* Shared helpers: configuration, time math, booking hours, validation.
   Loaded by both the public calendar and the admin editor. No dependencies. */

const DATA_PATH = 'data/bookings.json';

const DEFAULT_CONFIG = {
  studioName: 'Studio',
  timezone: 'Europe/Belgrade',
  slotMinutes: 30,
  weekStart: 1,
  hours: {
    weekendDays: [0, 6],
    weekday: { open: '16:00', close: '24:00' },
    weekend: { open: '00:00', close: '24:00' }
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

/* Weekday column headers, rotated to the configured first day of the week. */
function weekdayHeaders(config) {
  const short = ['Ned', 'Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub'];
  const out = [];
  for (let i = 0; i < 7; i++) out.push(short[(config.weekStart + i) % 7]);
  return out;
}

/* ---------- booking hours ---------- */

function isWeekend(dateStr, config) {
  const date = parseDate(dateStr);
  if (!date) return false;
  return config.hours.weekendDays.indexOf(date.getDay()) !== -1;
}

/* The bookable window for a date, in minutes since midnight. */
function dayWindow(dateStr, config) {
  const weekend = isWeekend(dateStr, config);
  const hours = weekend ? config.hours.weekend : config.hours.weekday;
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  return {
    open: open === null ? 0 : open,
    close: close === null ? 1440 : close,
    isWeekend: weekend,
    label: (open === null ? '00:00' : toTime(open)) + ' – ' + (close === null ? '24:00' : toTime(close))
  };
}

/* Every slot boundary inside a date's window, including the closing time. */
function slotBoundaries(dateStr, config) {
  const win = dayWindow(dateStr, config);
  const step = Math.max(5, Number(config.slotMinutes) || 30);
  const out = [];
  for (let m = win.open; m <= win.close; m += step) out.push(m);
  if (out.length && out[out.length - 1] !== win.close) out.push(win.close);
  return out;
}

/* ---------- bookings ---------- */

function newId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return 'b_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function sortBookings(list) {
  return list.slice().sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.start.localeCompare(b.start) ||
    a.id.localeCompare(b.id));
}

function bookingsForDate(list, dateStr) {
  return sortBookings(list.filter(b => b.date === dateStr));
}

function bookingsForMonth(list, monthStr) {
  return sortBookings(list.filter(b => b.date.slice(0, 7) === monthStr));
}

/* Half-open intervals: a slot ending at 19:30 and one starting at 19:30 do not conflict. */
function overlaps(a, b) {
  if (a.date !== b.date) return false;
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

function findConflict(booking, list) {
  return list.find(other => other.id !== booking.id && overlaps(booking, other)) || null;
}

/* Unbooked stretches inside a date's window, for display on the public page. */
function freeRanges(dateStr, list, config) {
  const win = dayWindow(dateStr, config);
  const taken = bookingsForDate(list, dateStr);
  const out = [];
  let cursor = win.open;
  for (const b of taken) {
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (start > cursor) out.push({ start: toTime(cursor), end: toTime(start) });
    cursor = Math.max(cursor, end);
  }
  if (cursor < win.close) out.push({ start: toTime(cursor), end: toTime(win.close) });
  return out;
}

/* ---------- validation ---------- */

function validateBooking(booking, list, config) {
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
  const win = dayWindow(booking.date, config);
  if ((start - win.open) % step !== 0 || (end - win.open) % step !== 0) {
    errors.push('Vremena moraju biti u koracima od ' + step + ' minuta.');
  }
  if (start >= end) {
    errors.push('Kraj mora biti posle početka.');
  }
  if (start < win.open || end > win.close) {
    const dayType = win.isWeekend ? 'Vikendom' : 'Radnim danima';
    errors.push(dayType + ' termini su mogući ' + win.label + '. Izaberite vreme u tom opsegu.');
  }

  const name = String(booking.name || '').trim();
  if (!name) errors.push('Unesite ime za termin.');
  else if (name.length > 60) errors.push('Ime sme imati najviše 60 karaktera.');

  const conflict = findConflict(booking, list);
  if (conflict) {
    errors.push('Preklapa se sa postojećim terminom: ' +
      rangeLabel(conflict.start, conflict.end) + ' (' + conflict.name + ').');
  }

  if (booking.date < todayString()) {
    warnings.push('Ovaj datum je u prošlosti.');
  }

  return { errors, warnings };
}
