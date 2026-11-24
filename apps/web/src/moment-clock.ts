// Gene (24 Nov): the world page has one clock, the moment you are watching. On a moved world a take tick is world time,
// TICK_US µs a tick since the Unix epoch, so the moment's clock is the real time it happened: Back 1 min moves it back
// exactly one minute. The time panel and the "● Recorded · <clock>" pill both read it from here.

/** The moment's time of day, to the second ("4:31:07 PM"), in `zone` (a real-time world's own time zone) or the viewer's. */
export function momentClock(ms: number, zone?: string | null, locale?: string): string {
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit', ...(zone ? { timeZone: zone } : {}) }); }
  catch { return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
}

/** The moment's day ("Tue, Nov 24"), in the same zone as its clock. */
export function momentDay(ms: number, zone?: string | null, locale?: string): string {
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(zone ? { timeZone: zone } : {}) }); }
  catch { return new Date(ms).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }); }
}

/** How long before `now` the moment is, in words ("3 min ago", "2 h 5 min ago"); '' within ten seconds of now. */
export function momentAgo(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (!Number.isFinite(s) || s < 10) return '';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 2) return `${d} days ago`;
  return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
}
