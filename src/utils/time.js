// All attendance rules are evaluated in the company time zone (settings.timezone),
// independent of the server's own time zone.

export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export const timeToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, matching JavaScript's getDay(). */
export const weekday = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

export function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export const currentMonth = (timeZone) => zonedParts(new Date(), timeZone).date.slice(0, 7);

/** Converts a wall-clock date + HH:MM in `timeZone` to a UTC ISO timestamp. */
export function zonedToUtcIso(isoDate, hhmm, timeZone) {
  const [y, mo, d] = isoDate.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const [py, pmo, pd] = p.date.split('-').map(Number);
    const shown = Date.UTC(py, pmo - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    guess += target - shown;
  }
  return new Date(guess).toISOString();
}
