// God mode audit #5006 row 20: a building placed live on a new-engine world brings its rooms, floors, doorways, doors
// and stairs, as a template's buildings have them. Each building kind's entry keeps them as its `building` section,
// written here once from today's generator (packages/generators, through the exporter), at the def's default params.
//
//   node v2/tools/import-eden/export/buildings.ts [--check]      (from the repository root)
//
// For each entry under content/kinds whose kind is a core building def (`eden:<name>` for `core/<name>@<n>`, the
// newest revision, the one the templates place), it replays one template that places every such building at its
// defaults on its own spot, with a door thing (`core/door@2`) in each doorway that takes one, as today's door fit
// (`apps/server/src/god/door-fit.ts`, every doorway) puts them, each a child of its building. The exporter
// (`export.ts`) writes the facts; each building's own (its solids, slots, floors, rooms, openings and stairs, in its
// frame) and its doors (pose in the building's frame, solids, params, open) become its entry's `building`, in the
// exporter's own format and units (mm, millidegrees), which `worldd` maps to nodes and links as `import-eden` maps a
// template's. `--check` writes nothing and exits 1 when an entry's section differs.
//
// The section sits beside the kind's meaning (section 24, like `looks`), so no kind's hash changes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildingDoorFits } from '../../../../packages/generators/src/index.ts';
import { coreLibrary } from '../../../../packages/world-compiler/src/index.ts';

const CHECK = process.argv.includes('--check');
const OUT = '.local/import-eden/buildings';
/** The narrowest doorway a core/door@2 fits (door-fit.ts NARROWEST): a narrower one stays bare. */
const NARROWEST = 0.96;
/** Apart enough that no building's bake reaches another's (the largest core building is about 40 m). */
const SPACING = 120;

type Def = { ref: string; name: string; make: { kind: string; gen?: string; args?: Record<string, unknown> }; params?: Record<string, { default?: unknown }> };
/** A def's params at their defaults, as the model bakes a thing placed with none. */
const defaults = (d: Def) => Object.fromEntries(Object.entries(d.params ?? {}).filter(([, p]) => p?.default !== undefined).map(([k, p]) => [k, p.default]));
const lib = coreLibrary();
const newest = new Map<string, Def>();
for (const d of lib.all() as Def[]) {
  if (d.make?.kind !== 'gen' || d.make.gen !== 'building/1') continue;
  const [name, rev] = d.ref.split('@');
  const had = newest.get(name!);
  if (!had || Number(had.ref.split('@')[1]) < Number(rev)) newest.set(name!, d);
}

// Every entry file under content/kinds, by kind.
const files = new Map<string, string>();
const walk = (dir: string) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.json')) {
      const e = JSON.parse(readFileSync(p, 'utf8'));
      if (e?.format === 'souls-entry/1' && typeof e.kind === 'string') files.set(e.kind, p);
    }
  }
};
walk('content/kinds');

// The buildings with an entry: `eden:<name>` for `core/<name>`.
const targets = [...newest.values()]
  .map((d) => ({ d, kind: `eden:${d.ref.replace(/^core[-/]/, '').replace(/@.*/, '').replace(/-/g, '_')}` }))
  .filter(({ kind }) => files.has(kind))
  .sort((a, b) => (a.kind < b.kind ? -1 : 1));

// One template: each building on its own spot, its doors its children, as door fit places them.
const ops: unknown[] = [];
targets.forEach(({ d }, k) => {
  const tmp = `$b${k}`;
  ops.push({ op: 'place', tmp, def: d.ref.replace(/^core-/, 'core/'), name: `b${k}`, p: [((k % 8) - 4) * SPACING, (Math.floor(k / 8) - 4) * SPACING] });
  for (const f of buildingDoorFits(defaults(d), d.make.args ?? {}, { p: [0, 0], r: 0 })) {
    if (f.width < NARROWEST) continue;
    ops.push({ op: 'place', def: 'core/door@2', in: { parent: tmp }, name: `b${k}-door-${f.opening}`, p: [f.p[0], f.y ?? 0, f.p[1]], r: f.r, params: { sx: f.sx, sy: f.sy }, state: { open: true } });
  }
});
mkdirSync(OUT, { recursive: true });
const template = { schema: 'genesis/1', name: 'buildings', description: 'each core building at its defaults', constants: { extent: 1000, ground: 'land' }, batches: [{ note: 'buildings', ops }] };
writeFileSync(join(OUT, 'template.json'), JSON.stringify(template));
execFileSync(process.execPath, ['v2/tools/import-eden/export/export.ts', '--template', join(OUT, 'template.json'), '--out', join(OUT, 'facts.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
const facts = JSON.parse(readFileSync(join(OUT, 'facts.json'), 'utf8'));

type Thing = Record<string, unknown> & { id: string; name?: string; parent: string | null; pose: number[] };
const things = facts.things as Thing[];
const byName = new Map(things.map((t) => [t.name, t]));
let differ = 0;
for (const [k, { d, kind }] of targets.entries()) {
  const b = byName.get(`b${k}`);
  if (!b) throw new Error(`${d.ref}: not in the facts`);
  if (!b.rooms && !b.floors && !b.stairs) { console.log(JSON.stringify({ kind, def: d.ref, skipped: 'no rooms, floors or stairs at its defaults' })); continue; }
  const doors = (facts.doors as { door: string; thing?: string; opening?: string }[])
    .filter((p) => p.thing === b.id && p.opening)
    .map((p) => {
      const t = things.find((x) => x.id === p.door)!;
      if (t.parent !== b.id) throw new Error(`${d.ref}: door ${p.opening} is not the building's child`);
      return { opening: p.opening, def: t.def, pose: t.pose, ...(t.solids ? { solids: t.solids } : {}), ...(t.params ? { params: t.params } : {}), open: (t.door as { open?: boolean } | undefined)?.open !== false };
    })
    .sort((a, c) => (a.opening! < c.opening! ? -1 : 1));
  const path = files.get(kind)!;
  const old = readFileSync(path, 'utf8');
  // A room's name is words, so it is named by reference: a key of the entry's text table (`room_<id>`).
  const names: [string, string][] = [];
  const rooms = (b.rooms as { id: string; name: string }[] | undefined)?.map((r) => {
    const key = `room_${r.id.replace(/[^a-z0-9]+/g, '_')}`;
    names.push([key, r.name]);
    return { ...r, name: key };
  });
  const section = { def: d.ref, ...pick({ ...b, rooms }, ['solids', 'slots', 'floors', 'rooms', 'openings', 'stairs']), doors };
  const written = spliced(old, section, names);
  const want = { ...JSON.parse(old), building: section };
  want.text = { ...Object.fromEntries(names), ...Object.fromEntries(Object.entries(want.text ?? {}).filter(([k]) => !k.startsWith('room_'))) };
  if (JSON.stringify(sorted(JSON.parse(written))) !== JSON.stringify(sorted(want))) throw new Error(`${path}: the splice did not give the entry`);
  if (written !== old) {
    differ++;
    if (!CHECK) writeFileSync(path, written);
  }
  console.log(JSON.stringify({ kind, def: d.ref, rooms: rooms?.length ?? 0, openings: (b.openings as unknown[] | undefined)?.length ?? 0, stairs: (b.stairs as unknown[] | undefined)?.length ?? 0, doors: doors.length, changed: written !== old }));
}
if (CHECK && differ) { console.error(`${differ} entries differ from today's generator`); process.exit(1); }

function pick(o: Record<string, unknown>, keys: string[]) { return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])); }

/** The entry file `text` with its `building` section (before its text table) and its rooms' names (first in the
 *  text table) put in, a section or names written before taken out, and every other byte left as it is. The section is
 *  two-space JSON, a value that fits in about 120 characters on one line, so a building's walls and rooms read as rows. */
function spliced(text: string, section: unknown, names: [string, string][]): string {
  let t = text.replace(/\n  "building": [\s\S]*?,\n(?=  "[a-z_]+": )/, '\n');
  t = t.replace(/\n    "room_[^"]*": "[^"\n]*",?(?=\n)/g, '');
  const at = t.indexOf('\n  "text": {\n');
  if (at < 0) throw new Error('no top-level text table');
  const rows = names.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('');
  const open = '\n  "text": {\n'.length;
  return `${t.slice(0, at)}\n  "building": ${rowsOf(section, '  ')},${t.slice(at, at + open)}${rows}${t.slice(at + open)}`;
}
/** Keys in order, for comparing two values as JSON. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  return v;
}
function line(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(line).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${line(x)}`).join(', ')}}`;
  return JSON.stringify(v);
}
function rowsOf(v: unknown, pad: string): string {
  const one = line(v);
  if (one.length + pad.length <= 120 || v === null || typeof v !== 'object') return one;
  const inner = pad + '  ';
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + rowsOf(x, inner)).join(',\n')}\n${pad}]`;
  return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${rowsOf(x, inner)}`).join(',\n')}\n${pad}}`;
}
