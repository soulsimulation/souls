#!/usr/bin/env node
// A Soul sits on a fountain's rim (core-fountain@2). A world imported with core-fountain@1 (Eden on soul.game) keeps
// that revision's slot rows in its tree (field 13: six stand points on the paving, numbered 1 to 6). The release's
// entries upgrade (`worldd entries stage`) gives the eden:fountain entry its rim seats and its sit form, and a seated
// body is placed, and drawn by the page, at the thing's own slot row of its seat's number. So this sets, once, as the
// creator's own edit (`souls-god.mjs batch`), each fountain's rows to the rows `import-eden`'s exporter gives
// core-fountain@2: the six rim seats as 1 to 6, then @1's six stand points as 7 to 12. It touches only a node of kind
// eden:fountain whose rows are exactly @1's; a second run finds none and sends nothing. `souls-god.mjs undo` takes it
// back.
//
//   SOULS_HOME=<the creator's home> node v2/tools/ops/fountain-rim-seats.mjs [--dry-run]
//
// Needs a daemon paired as the world's creator (`souls-god.mjs pair <world url> --creator <grant>`) in SOULS_HOME.
// Prints one JSON line: {ok, dryRun, fountains, edits}.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreLibrary } from '../../../packages/world-compiler/src/index.ts';
import { slotNumbers } from '../import-eden/export/with.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const GOD = join(ROOT, 'v2/client/src/creator/souls-god.mjs');
const ENTRY = join(ROOT, 'content/kinds/washing/fountain.json');
const F_SLOTS = 13, F_ENTRY = 27, KIND = 'eden:fountain';

const mm = (m) => Math.round(m * 1000);
const mdeg = (rad) => { let d = Math.round((rad * 180_000) / Math.PI) % 360_000; if (d < 0) d += 360_000; return d; };

/** A def revision's slot rows as the exporter writes them for a thing of scale 1: `[n, x, y, z, yaw mdeg, capacity]`,
 *  numbered by `entry` (with.ts `slotNumbers`), in the def's order. */
export function slotRows(ref, entry) {
  const def = coreLibrary().get(ref);
  const slots = def.slots.filter((s) => s.kind !== 'room'), n = slotNumbers(slots, entry);
  return slots.map((s) => [n.get(s.id), mm(s.p[0]), mm(s.p[1]), mm(s.p[2]), mdeg(s.yaw), s.capacity ?? 1]);
}

/** The set operations that bring each fountain of `world` (a `souls-world/1` export) from rows `was` to rows `now`. */
export function rimOps(world, was, now) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return world.nodes
    .filter((n) => (typeof n.fields?.[F_ENTRY] === 'string' ? n.fields[F_ENTRY] : String(n.kind).split('@')[0]) === KIND)
    .filter((n) => same(n.fields?.[F_SLOTS], was))
    .map((n) => ({ op: 'set', node: n.id, field: F_SLOTS, value: now }));
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const entry = JSON.parse(readFileSync(ENTRY, 'utf8'));
  // @1 has no seat, so the exporter numbers its six stand points in the def's order whatever the entry says.
  const was = slotRows('core/fountain@1', entry), now = slotRows('core/fountain@2', entry);
  const tmp = mkdtempSync(join(tmpdir(), 'fountain-rim-'));
  try {
    const god = (...words) => { const out = execFileSync(process.execPath, [GOD, ...words], { encoding: 'utf8', maxBuffer: 1 << 26 }); return JSON.parse(out.trim().split('\n').pop()); };
    const file = join(tmp, 'world.souls.json'), exported = god('export', file);
    if (!exported.ok) throw new Error(`export: ${JSON.stringify(exported).slice(0, 300)}`);
    const ops = rimOps(JSON.parse(readFileSync(file, 'utf8')), was, now);
    if (dry || !ops.length) { console.log(JSON.stringify({ ok: true, dryRun: dry, fountains: ops.map((o) => o.node), edits: 0 })); return; }
    const a = god('batch', JSON.stringify(ops));
    if (!a.ok) { console.log(JSON.stringify({ ok: false, fountains: ops.map((o) => o.node), refused: a })); process.exit(1); }
    console.log(JSON.stringify({ ok: true, dryRun: false, fountains: ops.map((o) => o.node), edits: 1 }));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
