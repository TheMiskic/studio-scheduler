/* Public calendar. Read-only: fetches the committed schedule and renders it. */

const view = {
  config: null,
  bookings: [],
  updated: null,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selected: null
};

const el = id => document.getElementById(id);

init();

async function init() {
  view.config = await loadConfig();
  applyConfig();
  readHash();
  await loadBookings();

  el('prev-month').addEventListener('click', () => shiftMonth(-1));
  el('next-month').addEventListener('click', () => shiftMonth(1));
  el('this-month').addEventListener('click', () => {
    const now = new Date();
    view.month = new Date(now.getFullYear(), now.getMonth(), 1);
    selectDay(todayString());
  });
  el('export-ics').addEventListener('click', downloadMonthIcs);
  window.addEventListener('hashchange', () => { readHash(); render(); });

  render();
}

function applyConfig() {
  const cfg = view.config;
  document.title = cfg.studioName + ' — Booking calendar';
  el('studio-name').textContent = cfg.studioName;

  const weekday = cfg.hours.weekday;
  const weekend = cfg.hours.weekend;
  el('hours-summary').textContent =
    'Mon–Fri ' + weekday.open + '–' + weekday.close + ' · Sat–Sun ' + weekend.open + '–' + weekend.close;
  el('tz-note').textContent = 'All times ' + cfg.timezone + '. Pick a day to see its bookings.';

  const contact = el('contact-link');
  if (cfg.contact && cfg.contact.href && cfg.contact.label) {
    contact.href = cfg.contact.href;
    contact.textContent = cfg.contact.label;
    contact.hidden = false;
  }

  const head = el('cal-head');
  head.textContent = '';
  for (const name of weekdayHeaders(cfg)) {
    const cell = document.createElement('div');
    cell.className = 'cal-head';
    cell.textContent = name;
    head.appendChild(cell);
  }
}

async function loadBookings() {
  const error = el('load-error');
  try {
    const res = await fetch(DATA_PATH + '?v=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    view.bookings = Array.isArray(data.bookings) ? data.bookings : [];
    view.updated = data.updated || null;
    error.hidden = true;
  } catch (err) {
    view.bookings = [];
    error.textContent = 'The schedule could not be loaded. Reload the page, or try again shortly.';
    error.hidden = false;
    console.error(err);
  }
}

/* ---------- routing ---------- */

function readHash() {
  const raw = location.hash.replace(/^#/, '');
  const asDate = parseDate(raw);
  if (asDate) {
    view.selected = raw;
    view.month = new Date(asDate.getFullYear(), asDate.getMonth(), 1);
    return;
  }
  const asMonth = parseMonthKey(raw);
  if (asMonth) {
    view.month = asMonth;
    view.selected = null;
  }
}

function writeHash() {
  const next = '#' + (view.selected || monthKey(view.month));
  if (location.hash !== next) history.replaceState(null, '', next);
}

function shiftMonth(delta) {
  view.month = new Date(view.month.getFullYear(), view.month.getMonth() + delta, 1);
  view.selected = null;
  writeHash();
  render();
}

function selectDay(dateStr) {
  view.selected = dateStr;
  writeHash();
  render();
}

/* ---------- rendering ---------- */

function render() {
  renderMonth();
  renderDay();
  renderUpdated();
}

function renderMonth() {
  const cfg = view.config;
  const first = view.month;
  el('cal-title').textContent = MONTH_NAMES[first.getMonth()] + ' ' + first.getFullYear();

  const leading = (first.getDay() - cfg.weekStart + 7) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const today = todayString();

  const grid = el('cal-grid');
  grid.textContent = '';

  for (let i = 0; i < cells; i++) {
    const date = addDays(first, i - leading);
    const dateStr = formatDate(date);
    const count = view.bookings.filter(b => b.date === dateStr).length;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    if (date.getMonth() !== first.getMonth()) cell.classList.add('outside');
    if (dateStr === today) cell.classList.add('today');
    if (dateStr === view.selected) cell.classList.add('selected');
    if (isWeekend(dateStr, cfg)) cell.classList.add('weekend');
    cell.setAttribute('aria-label',
      longDateLabel(dateStr) + (count ? ', ' + count + ' booked' : ', free'));

    const num = document.createElement('span');
    num.className = 'cal-num';
    num.textContent = String(date.getDate());
    cell.appendChild(num);

    if (count) {
      const dot = document.createElement('span');
      dot.className = 'cal-dot';
      dot.textContent = String(count);
      cell.appendChild(dot);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'cal-spacer';
      cell.appendChild(spacer);
    }

    cell.addEventListener('click', () => selectDay(dateStr));
    grid.appendChild(cell);
  }
}

function renderDay() {
  const panel = el('day-panel');
  if (!view.selected) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const cfg = view.config;
  const dateStr = view.selected;
  const win = dayWindow(dateStr, cfg);

  el('day-title').textContent = longDateLabel(dateStr);
  el('day-window').textContent =
    (win.isWeekend ? 'Weekend' : 'Weekday') + ' hours: ' + win.label;

  const slots = bookingsForDate(view.bookings, dateStr);
  const list = el('day-slots');
  list.textContent = '';
  el('day-empty').hidden = slots.length > 0;

  for (const b of slots) {
    const li = document.createElement('li');
    li.className = 'slot';

    const time = document.createElement('span');
    time.className = 'slot-time';
    time.textContent = rangeLabel(b.start, b.end);

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = b.name;

    li.append(time, name);
    list.appendChild(li);
  }

  const freeBox = el('day-free');
  freeBox.textContent = '';
  const free = freeRanges(dateStr, view.bookings, cfg);
  if (free.length) {
    const heading = document.createElement('p');
    heading.className = 'hint';
    heading.textContent = 'Free:';
    const chips = document.createElement('div');
    chips.className = 'free-list';
    for (const range of free) {
      const chip = document.createElement('span');
      chip.className = 'free-chip';
      chip.textContent = rangeLabel(range.start, range.end);
      chips.appendChild(chip);
    }
    freeBox.append(heading, chips);
  }
}

function renderUpdated() {
  if (!view.updated) return;
  const when = new Date(view.updated);
  if (isNaN(when)) return;
  el('updated-note').textContent = 'Updated ' + when.toLocaleString();
}

/* ---------- iCalendar export ----------
   Times are written as floating local time, matching how they are stored:
   wall-clock, with no UTC conversion anywhere in the chain. */

function downloadMonthIcs() {
  const month = monthKey(view.month);
  const slots = bookingsForMonth(view.bookings, month);
  if (!slots.length) {
    alert('No bookings in ' + MONTH_NAMES[view.month.getMonth()] + ' to export.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Studio Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsText(view.config.studioName)
  ];

  for (const b of slots) {
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + b.id + '@studio-scheduler',
      'DTSTAMP:' + stamp,
      'DTSTART:' + icsMoment(b.date, b.start),
      'DTEND:' + icsMoment(b.date, b.end),
      'SUMMARY:' + icsText(b.name),
      'LOCATION:' + icsText(view.config.studioName),
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'studio-' + month + '.ics';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* 24:00 is the end of the day, which iCalendar expresses as 00:00 of the next date. */
function icsMoment(dateStr, timeStr) {
  let date = parseDate(dateStr);
  let minutes = toMinutes(timeStr);
  if (minutes === 1440) {
    date = addDays(date, 1);
    minutes = 0;
  }
  return formatDate(date).replace(/-/g, '') + 'T' + toTime(minutes).replace(':', '') + '00';
}

function icsText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
