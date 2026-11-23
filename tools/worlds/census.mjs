#!/usr/bin/env node
// A census of a world template: what is placed, and how much of it a body can use. Reads a template file only
// (worlds/templates/<name>.json, or a path); never production, never a running service.
//
//   node tools/worlds/census.mjs [--json] <template>...
//
// Counts, over every `place` op in the template's batches (a def is resolved from the template's own `define` ops, else
// the core kit):
//   placed   things placed          kinds    distinct defs placed
//   action   placed things whose def offers at least one action (a door's open and close count)
//   doors    placed things of the core door def (any version)
//   slot     placed things whose def has at least one slot (a seat, bed, shelf or surface a body can use or fill)
//   usable   placed things with an action or a slot; usable share = usable / placed
import { isMain } from '../lib/is-main.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { CORE_KIT } from '../../packages/world-compiler/src/core-kit.ts';

const root = new URL('../../', import.meta.url);

/** Census of one parsed template. */
export function census(tpl) {
  const defs = new Map();
  for (const d of CORE_KIT) defs.set(`core/${String(d.name).replace(/^core-/, '')}@${d.version ?? 1}`, d);
  const ops = (tpl.batches ?? []).flatMap((b) => b.ops ?? []);
  for (const o of ops) if (o.op === 'define' && o.def) defs.set(`${o.def.name}@${o.def.version ?? 1}`, o.def);
  const r = { placed: 0, action: 0, doors: 0, slot: 0, usable: 0, unresolved: 0 };
  const kinds = new Set(), kindsAct = new Set(), kindsUsable = new Set();
  for (const o of ops) {
    if (o.op !== 'place') continue;
    r.placed++;
    kinds.add(o.def);
    if (/^core\/door@\d+$/.test(o.def)) r.doors++;
    const d = defs.get(o.def);
    if (!d) { r.unresolved++; continue; }
    const act = (d.actions?.length ?? 0) > 0, slot = (d.slots?.length ?? 0) > 0;
    if (act) { r.action++; kindsAct.add(o.def); }
    if (slot) r.slot++;
    if (act || slot) { r.usable++; kindsUsable.add(o.def); }
  }
  return { ...r, kinds: kinds.size, kindsWithAction: kindsAct.size, kindsUsable: kindsUsable.size,
    usableShare: r.placed ? Math.round((r.usable / r.placed) * 10000) / 10000 : 0 };
}

/** Placed things per def ref in a parsed template. */
export function placedByDef(tpl) {
  const n = {};
  for (const b of tpl.batches ?? []) for (const o of b.ops ?? []) if (o.op === 'place') n[o.def] = (n[o.def] ?? 0) + 1;
  return n;
}

/**
 * Checks a world's entry map (content/worlds/<world>/map.json) against its template and counts it: every placed def has
 * one row naming an entry or waiting, with the template's own count. Shares are in tenths of a percent (integers).
 */
export function mapCensus(map, tpl) {
  const placed = placedByDef(tpl), problems = [], seen = new Set();
  const r = { placed: 0, kinds: Object.keys(placed).length, rows: 0, own: 0, base: 0, waiting: 0, kindsOwn: 0, kindsBase: 0, kindsWaiting: 0 };
  for (const row of map.rows ?? []) {
    r.rows++;
    if (seen.has(row.def)) problems.push(`${row.def}: two rows`);
    seen.add(row.def);
    if (placed[row.def] === undefined) { problems.push(`${row.def}: not placed in the template`); continue; }
    if (row.placed !== placed[row.def]) problems.push(`${row.def}: row says ${row.placed}, template places ${placed[row.def]}`);
    const n = placed[row.def];
    if (row.entry && (row.forms === 'own' || row.forms === 'base') && !row.waiting) { r[row.forms] += n; r[row.forms === 'own' ? 'kindsOwn' : 'kindsBase']++; }
    else if (row.waiting && !row.entry) { r.waiting += n; r.kindsWaiting++; }
    else problems.push(`${row.def}: names neither one entry with forms own or base, nor waiting`);
  }
  for (const d of Object.keys(placed)) if (!seen.has(d)) problems.push(`${d}: no row (${placed[d]} placed)`);
  for (const n of Object.values(placed)) r.placed += n;
  const tenths = (x) => (r.placed ? Math.round((x * 1000) / r.placed) : 0);
  const waiting = (map.rows ?? []).filter((x) => x.waiting && !x.entry).sort((a, b) => b.placed - a.placed)
    .map((x) => ({ def: x.def, placed: x.placed, task: x.waiting }));
  return { ...r, ownTenths: tenths(r.own), entryTenths: tenths(r.own + r.base), waitingList: waiting, problems };
}

const pct = (t) => `${Math.trunc(t / 10)}.${t % 10}%`;

if (isMain(import.meta.url) || process.argv[1]?.endsWith('census.mjs')) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const mi = args.indexOf('--map');
  if (mi >= 0) {
    // node tools/worlds/census.mjs --map content/worlds/eden/map.json [--json]
    const map = JSON.parse(readFileSync(args[mi + 1], 'utf8'));
    const c = mapCensus(map, JSON.parse(readFileSync(new URL(map.template, root), 'utf8')));
    if (json) console.log(JSON.stringify(c, null, 2));
    else {
      console.log(`${map.world}: ${c.placed} placed in ${c.kinds} kinds, ${c.rows} rows`);
      console.log(`  entry with forms of its own: ${c.own} placed (${c.kindsOwn} kinds) = ${pct(c.ownTenths)}`);
      console.log(`  entry with a card and the base forms only: ${c.base} placed (${c.kindsBase} kinds)`);
      console.log(`  mapped to an entry: ${c.own + c.base} = ${pct(c.entryTenths)}; waiting: ${c.waiting} placed (${c.kindsWaiting} kinds)`);
      for (const w of c.waitingList) console.log(`  waiting ${String(w.placed).padStart(4)} ${w.def} (${w.task})`);
      for (const p of c.problems) console.log(`  PROBLEM ${p}`);
    }
    process.exit(c.problems.length ? 1 : 0);
  }
  const names = args.filter((a) => !a.startsWith('--'));
  if (!names.length) { console.error('usage: node tools/worlds/census.mjs [--json] <template>...'); process.exit(2); }
  const out = {};
  for (const n of names) {
    const f = existsSync(n) ? n : new URL(`worlds/templates/${n.replace(/\.json$/, '')}.json`, root).pathname;
    if (!existsSync(f)) { console.error(`no template ${n}`); process.exit(2); }
    out[basename(f, '.json')] = census(JSON.parse(readFileSync(f, 'utf8')));
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else for (const [n, c] of Object.entries(out))
    console.log(`${n}: ${c.placed} placed, ${c.kinds} kinds (${c.kindsWithAction} with an action), ${c.action} with an action, ${c.doors} doors, ${c.slot} with a slot, ${c.usable} usable = ${(c.usableShare * 100).toFixed(1)}%${c.unresolved ? `, ${c.unresolved} unresolved` : ''}`);
}
