// Setup shared by clip kits (timed-run.yml `clip`; 0.135 P6 on the new engine): the kit's Souls, each paired to the
// clip's world as tools/playtest/arena/new-engine/seat.mjs pairs one (approved by its owner, a test person), named, and
// joined, so the page has them before the take. They act only through the new client's thin command (`souls.mjs`).
// Runs when the recorder imports a kit's steps, before the page opens.
// CLIP_V2 is the new engine's addresses (old-page.mjs's world: page, directory, gateway), CLIP_CHECKOUT the ref's
// checkout, CLIP_WORK a per-run scratch folder. A god agent (`god`) has no form on the new engine's clip world yet: it is
// listed in the log and left out.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { CLIP_V2, CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const seats = new Map();

/** cast({ souls: [{ name, owner }], god }) → the Souls by name, each `{ cli(...words), body, soul }`. */
export async function cast({ souls = [], god = null }) {
  if (!CLIP_V2 || !CLIP_WORK) throw Error('cast: CLIP_V2 and CLIP_WORK are set by timed-run.mjs `clip`');
  const world = JSON.parse(CLIP_V2);
  const { pairSeat } = await import(pathToFileURL(join(CLIP_CHECKOUT, 'tools/playtest/arena/new-engine/seat.mjs')).href);
  for (const s of souls) {
    const seat = await pairSeat({ world, dir: CLIP_WORK, label: `soul-${s.name.toLowerCase()}`, owner: s.owner, name: s.name });
    const { body } = await seat.join();
    console.error(`kit: ${s.name} (${s.owner}) paired and joined, body ${body}`);
    seats.set(s.name, seat);
  }
  if (god) console.error(`kit: a god agent for dev:${god} has no form on the new engine's clip world yet; left out`);
  return Object.fromEntries(seats);
}

/** The Soul named `name` in the cast. */
export const soul = (name) => { const s = seats.get(name); if (!s) throw Error(`cast: no Soul ${name}`); return s; };

/** What `name`'s own copy finds for `words` (not a body), or null: the thing named exactly that first (Eden's things keep
 *  their old ids as names: `street-bench-1`), else the first found. `"<words> in <thing>"` keeps to what is inside that
 *  thing (`Top room in eden-tower-house`, `Bedroom in canal-west-home-3`): rooms carry their building's room names
 *  (`Bedroom`, `Landing`), shared by every house of a kind, so they are searched near that thing, not world-wide, where
 *  the first 50 found may all be other houses'. */
export async function find(name, words) {
  const [what, within] = words.split(/ in (?=\S+$)/);
  const s = soul(name), notBody = (x) => !x.kind?.startsWith('souls:body');
  const host = within ? ((await s.cli('find', within, '--limit', '50')).found ?? []).find((x) => notBody(x) && x.name === within) : null;
  const r = host
    ? ((await s.cli('query', JSON.stringify([{ find: what, near: host.id, within: 40, limit: 50 }]))).answers?.[0] ?? {})
    : await s.cli('find', ...what.split(/\s+/), '--limit', '50');
  const rows = (r.found ?? []).filter((x) => notBody(x) && (!within || String(x.in ?? '').split(', ').includes(within)));
  return rows.find((x) => x.name === what) ?? rows[0] ?? null;
}

/** `name` walks to what its copy finds for `words` and waits for the receipt; logged. → the answer */
export async function walk(name, words) {
  const there = await find(name, words);
  if (!there) { console.error(`kit: ${name}: nothing found for "${words}"`); return { ok: false }; }
  const r = await soul(name).cli('act', there.id, '--wait');
  console.error(`kit: ${name} walk to ${words} (${there.id}): ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}

/** `name` acts `verb` on what its copy finds for `words` (a door's `close`, an easel's `paint`), waiting; logged. */
export async function actOn(name, verb, words) {
  const there = await find(name, words);
  if (!there) { console.error(`kit: ${name}: nothing found for "${words}"`); return { ok: false }; }
  const r = await soul(name).cli('act', `${verb}:${there.id}`, '--wait');
  console.error(`kit: ${name} ${verb} ${words} (${there.id}): ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}
