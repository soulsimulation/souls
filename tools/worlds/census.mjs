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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('census.mjs')) {
  const args = process.argv.slice(2), json = args.includes('--json');
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
