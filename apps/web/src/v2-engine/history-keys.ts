// The paths of a world's public history export, relative to its `history/` folder, as worldd mirrors them
// (v2/crates/worldd/src/serve.rs `Again::mirror`, v2/docs/archive.md "The objects"; v2/client/src/history/history.mjs
// names the same). The store's own keys are kept under the folder, so V4's event counts, whose store keys begin
// `history/everyone/`, are served at `<world>/history/history/everyone/...`: that doubled `history/` is the origin's
// real layout (checked on soul.game), not a slip. Imported by the page and its history worker alike, so nothing else here
// but the keys and the walk that picks them.

export const DAY_US = 86_400_000_000;
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** The world's T6 header. */
export const headerKey = () => 'header';
/** A world day's bundle index (`[[start µs, key, SHA-256], ...]`); the day's bundles are the keys it names. */
export const dayIndexKey = (day: number) => `bundles/${pad(day, 8)}/index`;
/** V4's public event index of a world day, or of an hour of it the day names as split (#5006 row 14: the edit log). */
export const eventsKey = (day: number, hour?: number) => `history/everyone/events/${pad(day, 8)}${hour === undefined ? '' : `/${pad(hour, 2)}`}`;
/** V4's counts of a world day, a slot each ten minutes (#5006 row 14: the edit log reads only the hours they count edits in). */
export const dayCountsKey = (day: number) => `history/everyone/counts/day/${pad(day, 8)}`;
/** V4's counts of a world year (365 world days), a slot a day. */
export const yearCountsKey = (year: number) => `history/everyone/counts/year/${pad(year, 4)}`;

/** A day's bundle index, `[[start µs, key, SHA-256], ...]`. */
export type DayIndex = [number, string, Uint8Array][];

/** V4's walk, the worker's seek: the last bundle that starts at or before `at`, back over days with no bundle before it
 *  or no index at all to the newest day that has one, and where the bundle after it starts (`later`: on over the days
 *  after, to now's, null when none is written yet). The archiver writes a day's index with its first bundle and the next
 *  day's, empty, ahead of it (v2/docs/archive.md), so the day after a day with a bundle has one from its first minute;
 *  a day after a still day has none until its first bundle, and the walk asks for it and goes on past it. Bounded by the
 *  world's first day (`floor`, its first moment, the page's), else a year back, never before day 0; and by now (`nowUs`,
 *  the world's time as the page has it): no day after now's is asked for. World time is the world's own, from its start
 *  (v2/docs/time.md rule 1), never the wall's: a world made through New world is in its day 0 whatever the date (only an
 *  imported world's clock reads as the wall's), so the wall's day is one its export will not reach for years. */
export async function walk(at: number, nowUs: number, floor: number | undefined, dayIndex: (day: number) => Promise<DayIndex | null>):
  Promise<{ day: number; key: string; sha: Uint8Array; later: () => Promise<number | null> } | null> {
  const now = Math.floor(nowUs / DAY_US);
  const lowest = Math.max(Math.floor(at / DAY_US) - 365, 0, floor === undefined ? 0 : Math.floor(floor / DAY_US));
  for (let day = Math.min(Math.floor(at / DAY_US), now); day >= lowest; day--) {
    const ix = await dayIndex(day);
    let i = ix ? ix.length - 1 : -1;
    while (i >= 0 && ix![i][0] > at) i--;
    if (!ix || i < 0) continue;
    const [, key, sha] = ix[i];
    const later = async () => {
      if (ix[i + 1]) return ix[i + 1][0];
      for (let d = day + 1; d <= now; d++) { const first = (await dayIndex(d))?.[0]; if (first) return first[0]; }
      return null;
    };
    return { day, key, sha, later };
  }
  return null;
}
