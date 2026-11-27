// The paths of a world's public history export, relative to its `history/` folder, as worldd mirrors them
// (v2/crates/worldd/src/serve.rs `Again::mirror`, v2/docs/archive.md "The objects"; v2/client/src/history/history.mjs
// names the same). The store's own keys are kept under the folder, so V4's event counts, whose store keys begin
// `history/everyone/`, are served at `<world>/history/history/everyone/...`: that doubled `history/` is the origin's
// real layout (checked on soul.game), not a slip. Imported by the page and its history worker alike, so nothing else here.

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

/** The world day of now (world time is wall time): no index is asked of a day after it, since none is written yet. */
export const today = () => Math.floor((Date.now() * 1000) / DAY_US);
