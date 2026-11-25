#!/usr/bin/env node
// #4784: a world imported before import-eden seeded captured state (Eden on soul.game) holds no state field its things
// were never set in since: a floor lamp's `level` is its entry's default (0, off), though today's page drew it on. This
// brings such a world to the look it was captured with, once, through the creator's own edit path: it reads the
// template's captured state (the exporter's `state`, as import-eden now seeds it), reads the world as the creator's
// daemon has it (`souls-god.mjs export`), and sets, as creator edits (`souls-god.mjs batch`, at most 256 operations an
// edit), each entry state field of a thing that
//
//   - the world's node does not hold (never set since the import: nothing a Soul or a creator changed is touched), and
//   - the capture says something of (the same name; `on`/`lit` either way; a lamp's `level` from `on`), and
//   - differs from the entry's default (the value the node already reads as).
//
// Non-destructive and idempotent: a second run finds every such field held and sends nothing. Each edit is the
// creator's own, so `souls-god.mjs undo` takes one back.
//
//   SOULS_HOME=<the creator's home> node v2/tools/ops/seed-captured-state.mjs --template worlds/templates/eden-2026.json [--dry-run]
//
// --dry-run prints the counts by kind and sends nothing. Needs a daemon paired as the world's creator (`souls-god.mjs
// pair <world url> --creator <grant>`) in SOULS_HOME. Prints one JSON line: {ok, dryRun, things, fields, byKind, edits}.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const GOD = join(ROOT, 'v2/client/src/creator/souls-god.mjs');
const EXPORT = join(ROOT, 'v2/tools/import-eden/export/export.ts');
const KINDS = join(ROOT, 'content/kinds');
/** The most operations one edit carries (replica `edit::OPS_MOST`). */
export const OPS_MOST = 256;
const F_ORIGIN = 1, F_ENTRY = 27;
const POWER = ['on', 'lit', 'playing', 'running'];

/** Each content kind's state fields a capture seeds, as import-eden's `entry_states` reads them: bool and int fields
 *  numbered 28 up, `{name: {n, type, max, dflt}}` by kind. */
export function entryStates(dir = KINDS) {
  const out = {};
  for (const family of readdirSync(dir)) for (const f of readdirSync(join(dir, family))) {
    if (!f.endsWith('.json')) continue;
    const e = JSON.parse(readFileSync(join(dir, family, f), 'utf8'));
    if (typeof e.kind !== 'string') continue;
    for (const [name, d] of Object.entries(e.state ?? {})) {
      if (!Number.isInteger(d?.n) || d.n < 28 || (d.type !== 'bool' && d.type !== 'int')) continue;
      const dflt = typeof d.default === 'boolean' ? Number(d.default) : Number.isInteger(d.default) ? d.default : 0;
      (out[e.kind] ??= {})[name] = { n: d.n, type: d.type, max: Number.isInteger(d.max) ? d.max : undefined, dflt };
    }
  }
  return out;
}

/** A captured value as the entry field of that meaning, as import-eden's `captured` gives it; undefined when the
 *  capture says nothing of it. */
export function capturedValue(state, name, { type, max }) {
  const power = () => POWER.map((k) => state[k]).find((v) => typeof v === 'boolean');
  if (type === 'bool') {
    const v = typeof state[name] === 'boolean' ? state[name] : POWER.includes(name) ? power() : undefined;
    return v === undefined ? undefined : Number(v);
  }
  if (Number.isInteger(state[name])) return state[name];
  if (name === 'level') { const on = power(); return on === undefined ? undefined : on ? (max ?? 1) : 0; }
  return undefined;
}

const plain = (k) => String(k).split('@')[0];
const hexText = (v) => (v && typeof v === 'object' && typeof v.hex === 'string' ? Buffer.from(v.hex, 'hex').toString('utf8') : typeof v === 'string' ? v : null);

/** The set operations that bring `world` (a `souls-world/1` export) to `captured` (old id -> state), by kind. */
export function seedOps(world, captured, states) {
  const ops = [], byKind = {};
  for (const node of world.nodes) {
    const origin = hexText(node.fields?.[F_ORIGIN]);
    const state = origin ? captured.get(origin) : undefined;
    if (!state) continue;
    const entry = typeof node.fields?.[F_ENTRY] === 'string' ? node.fields[F_ENTRY] : node.kind;
    const defs = states[plain(entry)];
    if (!defs) continue;
    for (const [name, d] of Object.entries(defs)) {
      if (node.fields?.[d.n] !== undefined) continue; // set since the import: the world's word stands
      const v = capturedValue(state, name, d);
      if (v === undefined || v === d.dflt) continue;
      ops.push({ op: 'set', node: node.id, field: d.n, value: v });
      const k = `${plain(entry)}.${name}=${v}`;
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
  }
  return { ops, byKind };
}

function main() {
  const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const template = opt('template'), dry = argv.includes('--dry-run');
  if (!template) { console.error('seed-captured-state: --template <worlds/templates/...json> [--dry-run]'); process.exit(2); }
  const tmp = mkdtempSync(join(tmpdir(), 'seed-captured-'));
  try {
    const factsFile = join(tmp, 'facts.json'), worldFile = join(tmp, 'world.souls.json');
    execFileSync(process.execPath, [EXPORT, '--template', resolve(template), '--out', factsFile], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    const facts = JSON.parse(readFileSync(factsFile, 'utf8'));
    const captured = new Map(facts.things.filter((t) => t.state).map((t) => [t.id, t.state]));
    const god = (...words) => { const out = execFileSync(process.execPath, [GOD, ...words], { encoding: 'utf8', maxBuffer: 1 << 26 }); return JSON.parse(out.trim().split('\n').pop()); };
    const exported = god('export', worldFile);
    if (!exported.ok) throw new Error(`export: ${JSON.stringify(exported).slice(0, 300)}`);
    const { ops, byKind } = seedOps(JSON.parse(readFileSync(worldFile, 'utf8')), captured, entryStates());
    const things = new Set(ops.map((o) => o.node)).size;
    if (dry || !ops.length) { console.log(JSON.stringify({ ok: true, dryRun: dry, things, fields: ops.length, byKind, edits: 0 })); return; }
    let edits = 0;
    for (let i = 0; i < ops.length; i += OPS_MOST) {
      const a = god('batch', JSON.stringify(ops.slice(i, i + OPS_MOST)));
      if (!a.ok) { console.log(JSON.stringify({ ok: false, things, fields: ops.length, byKind, edits, sentOps: i, refused: a })); process.exit(1); }
      edits++;
    }
    console.log(JSON.stringify({ ok: true, dryRun: false, things, fields: ops.length, byKind, edits }));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
