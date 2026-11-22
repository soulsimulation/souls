// A place's opening hours as people write them (0.131 parity, #3699), and the rows the world publishes (E7, field 81:
// `replica::schedule`). A weekly row is `[2, weekdays, from, to]`: a mask of ISO weekdays (bit 0 Monday to bit 6
// Sunday) and µs after local midnight, `to` after `from` and at most a day later, so 22:00-02:00 runs past midnight.
// Today's form is kept: `07:00-15:00`, every day, or `09:00-13:00@sat,sun` / `@mon-fri`.

export const F_HOURS = 81;
export const HOURS_MOST = 64;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MIN_US = 60_000_000;
const DAY_US = 24 * 60 * MIN_US;
const SPAN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:@(.+))?$/;

const bad = (detail) => Object.assign(new Error(detail), { code: 'hours.malformed' });

function maskOf(text) {
  let mask = 0;
  for (const part of text.toLowerCase().split(',')) {
    const [a, b = a] = part.split('-').map((d) => DAYS.indexOf(d.trim().slice(0, 3)));
    if (a < 0 || b < 0) throw bad(`${part}: days are mon tue wed thu fri sat sun, as sat,sun or mon-fri`);
    for (let d = a; ; d = (d + 1) % 7) { mask |= 1 << d; if (d === b) break; }
  }
  return mask;
}

/** The rows one `--open` each makes: `HH:MM-HH:MM[@days]`. */
export function hoursRows(spans) {
  if (spans.length > HOURS_MOST) throw bad(`at most ${HOURS_MOST} spans`);
  return spans.map((s) => {
    const m = SPAN.exec(String(s).trim());
    if (!m) throw bad(`${s}: a span is HH:MM-HH:MM, with @sat,sun or @mon-fri for some days only`);
    const [h1, m1, h2, m2] = m.slice(1, 5).map(Number);
    if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || (h2 === 24 && m2 > 0)) throw bad(`${s}: not a time of day`);
    const from = (h1 * 60 + m1) * MIN_US;
    let to = (h2 * 60 + m2) * MIN_US;
    if (to <= from) to += DAY_US; // past midnight
    return [2, m[5] ? maskOf(m[5]) : 127, from, to];
  });
}

const hhmm = (us) => { const m = Math.round(us / MIN_US) % (24 * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const daysOf = (mask) => (mask === 127 ? '' : `@${DAYS.filter((_, d) => mask & (1 << d)).join(',')}`);

/** The rows as written, or null when the field is not hours. One-off rows are given in world µs. */
export function hoursText(rows) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const r of rows) {
    const n = Array.isArray(r) ? r.map(Number) : [];
    if (n[0] === 2 && n.length === 4) out.push(`${hhmm(n[2])}-${hhmm(n[3])}${daysOf(n[1])}`);
    else if (n[0] === 1 && n.length === 3) out.push(`world ${n[1]}us-${n[2]}us`);
    else return null;
  }
  return out;
}
