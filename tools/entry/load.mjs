#!/usr/bin/env node
// Adapter for today's engine (Soul Actions SA-F3d, #2881): an entry's kind, loaded into a world of today's engine as a
// creator-defined thing, so testers can see and inspect it before Engine v2 exists. Thrown away at the cut-over (K3 #2667,
// N1 #2649).
//
//   node tools/entry/load.mjs <family|folder|file> [--world <seat|url>] [--at x,z] [--kind <name>] [--root content/kinds] [--plan]
//
// Run it from the creator's folder: each kind is defined through the creator's own `define` and placed with `place`
// (tools/god-skill/cli.mjs, the god CLI the creator already holds a seat with). `--world` names that seat, or the world's
// URL; with one seat it can be left out. Without `--at` each thing goes to a free spot. `--plan` prints the defs and
// touches no world. Prints one JSON line per kind: its def, where it was placed, what was skipped, and any errors.
//
// What reaches today's world, and how:
// - The def is world-local, named `entry-<namespace>-<name>`: nothing in the core kit changes, no conformance supplement.
// - Its shape is the entry's `looks.shape`, in metres (look.mjs's `defOf`); `geometry.bounds_mm` is its box.
// - State fields keep their names: bool and enum as they are, int and duration as whole numbers (µs for a duration),
//   text as a string. A list, a schedule and a timed (rate) field are not carried: new engine only, named in `skipped`.
// - A thin thing's box is padded to the world's 5 cm floor (a card, a slip of paper, a spoon): this loads into a test
//   world only, so the drawing stays the entry's and only the box grows.
// - A kind whose forms take it into a hand loads as carryable, so today's take_item holds it.
// - Slots keep their names (`_` becomes `-`, the def's name rule): a body slot to sit in is a seat, to lie in a bed, a
//   thing slot a surface; `most` is its capacity.
// - The marker: the param `entry` holds the kind's reference (`<kind>@<hash>`, tools/entry/format.mjs) and the tag
//   `entry` marks it as loaded from an entry.
// Not loaded, and named in the output: forms (running them is SA-F3a), and points, links and children (new engine only:
// a def of today has nothing to carry them).
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashKinds} from './format.mjs';
import {defOf, loadEntries} from './look.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GOD = join(root, 'tools/god-skill/cli.mjs');
const DEF_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const SKIPPED = {forms: 'running forms is SA-F3a', points: 'new engine only', links: 'new engine only', children: 'new engine only'};

/** The world-local def name of a kind. */
export const defName = kind => `entry-${kind.replace(':', '-').replaceAll('_', '-')}`;

/** A state field as a field of today's def, by the same name. */
function fieldOf(f) {
  if (f.type === 'bool') return {type: 'bool', default: f.default};
  if (f.type === 'enum') return {type: 'enum', values: f.values, default: f.default};
  if (f.type === 'int' || f.type === 'duration') return {type: 'int', default: f.default};
  if (f.type === 'text') return {type: 'string', max: 2000};
  return null;
}
/** Field types today's def does not carry: a case whose start needs one is skipped by the run gate. */
export const NEW_ENGINE_ONLY = Object.freeze(['list', 'schedule', 'timed']);
/** The smallest side today's world takes for a def's box (creation-limits defSizeMinM), in metres. */
const SIZE_MIN = 0.05;
/** Whether a form of the entry takes the thing itself into a hand. */
const handheld = entry => Object.values(entry.forms ?? {}).some(f => (f.effects ?? []).some(e => e.change === 'reparent' && e.what === 'this' && e.into === 'actor_hand'));

/** A slot as a slot of today's def. */
function slotOf(name, s) {
  const kind = s.admits === 'thing' ? 'surface' : s.posture === 'lie' ? 'bed' : 'seat';
  const accepts = s.admits === 'thing' ? {...(s.kinds?.length ? {kinds: s.kinds.map(defName)} : {}), ...(s.fits_mm ? {maxSize: s.fits_mm.map(x => x / 1000)} : {})} : {};
  return {id: name.replaceAll('_', '-'), kind, p: s.at_mm.map(x => x / 1000), accepts, capacity: s.most ?? 1};
}

/** The def a kind is loaded as, and what of the entry it leaves out. */
export function loadDef(entry, ref) {
  const def = defOf(entry);
  if (!def) throw new Error('looks.shape.shapes is missing: there is nothing to draw');
  const name = defName(entry.kind);
  if (!DEF_NAME.test(name)) throw new Error(`${name}: too long for a def name (48 characters at most)`);
  Object.assign(def, {
    name, tags: [...new Set([...def.tags, 'entry'])].slice(0, 32),
    params: {entry: {type: 'string', default: ref, max: 200, doc: 'The entry this thing was loaded from (tools/entry/load.mjs).'}},
    state: Object.fromEntries(Object.entries(entry.state ?? {}).map(([k, f]) => [k, fieldOf(f)]).filter(([, f]) => f)),
    slots: Object.entries(entry.slots ?? {}).map(([k, s]) => slotOf(k, s)),
    size: {...def.size, box: def.size.box.map(v => Math.max(v, SIZE_MIN))},
    ...(handheld(entry) ? {components: {carryable: {mass: 0.5}}} : {}),
  });
  const skipped = Object.keys(SKIPPED).filter(k => Object.keys(entry[k] ?? {}).length).map(k => ({what: k, why: SKIPPED[k]}));
  for (const [k, f] of Object.entries(entry.state ?? {})) if (NEW_ENGINE_ONLY.includes(f.type)) skipped.push({what: `state.${k}`, why: `a ${f.type} field: new engine only`});
  return {def, skipped};
}

/** The god CLI's seat selector for `--world`: a seat word, or the URL of a seat (or of this folder's god). */
async function selector(world) {
  if (!world) return [];
  if (!/^https?:\/\//.test(world)) return [`@${world.replace(/^@/, '')}`];
  const url = world.replace(/[?#].*$/, '').replace(/\/$/, '');
  const {findHome, keyOf, openHome} = await import('../world-launcher/soul/home.mjs');
  const found = findHome({cwd: process.cwd(), env: process.env, homedir: homedir()});
  if (found.kind === 'home') {
    const key = keyOf(openHome(found.root).config().worlds, url);
    if (key) return [`@${key}`];
  }
  const here = (() => { try { return JSON.parse(readFileSync('.eden-god.json', 'utf8')).world; } catch { return null; } })();
  if (here === url) return [];
  throw new Error(`no god seat for ${url} here: register it first (node eden-god.mjs register ${url})`);
}

const god = (sel, args) => {
  const r = spawnSync(process.execPath, [GOD, ...sel, ...args], {cwd: process.cwd(), encoding: 'utf8', env: process.env});
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0 || /REFUSED/.test(out)) throw new Error(out || `god CLI exited ${r.status}`);
  return out;
};

export async function load(target, {world, at, kind, root: rootDir = 'content/kinds', plan = false} = {}) {
  // A kind's hash covers the kinds it refers to, so every entry under the root is hashed with the ones loaded.
  const rows = loadEntries(target, rootDir), ok = r => r.entry && !r.errors.length;
  const byKind = new Map([...loadEntries(resolve(root, rootDir), rootDir), ...rows].filter(ok).map(r => [r.entry.kind, r.entry]));
  const refs = hashKinds([...byKind.values()]);
  const sel = plan ? [] : await selector(world);
  const dir = plan ? null : mkdtempSync(join(tmpdir(), 'entry-load-'));
  const results = [];
  for (const {file, entry, errors} of rows) {
    if (!entry || errors.length) { results.push({file: relative(root, file), errors: errors.map(e => `${e.path}: ${e.reason}`)}); continue; }
    if (kind && entry.kind.split(':')[1] !== kind && entry.kind !== kind) continue;
    const result = {kind: entry.kind, file: relative(root, file)};
    results.push(result);
    try {
      if (entry.owner !== 'thing') throw new Error(`owner ${entry.owner}: only a thing is loaded as a def`);
      const {def, skipped} = loadDef(entry, refs.get(entry.kind).ref);
      Object.assign(result, {def: `${def.name}@${def.version}`, ref: refs.get(entry.kind).ref, skipped});
      if (plan) { result.plan = def; continue; }
      const defFile = join(dir, `${def.name}.json`);
      writeFileSync(defFile, JSON.stringify(def));
      result.defined = god(sel, ['define', defFile]).split('\n')[0];
      result.placed = god(sel, ['place', result.def, ...(at ? ['--at', at] : ['--free']), '--name', def.name]).split('\n')[0];
    } catch (e) { result.errors = [String(e.message ?? e)]; }
  }
  if (dir) rmSync(dir, {recursive: true, force: true});
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2), flag = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const target = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--plan'));
  if (!target) { console.error('usage: node tools/entry/load.mjs <family|folder|file> [--world <seat|url>] [--at x,z] [--kind <name>] [--root content/kinds] [--plan]'); process.exit(2); }
  const results = await load(target, {world: flag('world'), at: flag('at'), kind: flag('kind'), root: flag('root'), plan: argv.includes('--plan')});
  for (const r of results) console.log(JSON.stringify(r));
  process.exitCode = results.length && results.every(r => !r.errors?.length) ? 0 : 1;
}
