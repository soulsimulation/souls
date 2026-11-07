#!/usr/bin/env node
// Real spend of one Soul Run from its seat transcripts (#1098): node tools/playtest/runs/spend.mjs <runDir>. Prints dollars.
// Per seat: the last session total the CLI reported, plus every assistant message after that line at claude-sonnet-5-5's
// prices (a turn killed at its timeout reports nothing itself). Then the larger of that and the ledger's per-turn sum.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
const P = { i: 2 / 1e6, cc: 4 / 1e6, cr: 0.10 / 1e6, o: 10 / 1e6 };
const walk = (d) => { let out = []; if (!existsSync(d)) return out; for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) out = out.concat(walk(p)); else if (e === 'transcript.jsonl') out.push(p); } return out; };
const lines = (f) => readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
let total = 0;
for (const f of walk(process.argv[2])) {
  let last = 0, after = new Map();
  for (const r of lines(f)) {
    if (r.type === 'result' && r.total_cost_usd != null) { last = Math.max(last, Number(r.total_cost_usd)); after = new Map(); }
    else if (r.type === 'assistant') after.set(r.message?.id, r.message?.usage ?? {});
  }
  const tail = [...after.values()].reduce((s, u) => s + (u.input_tokens ?? 0) * P.i + (u.cache_creation_input_tokens ?? 0) * P.cc + (u.cache_read_input_tokens ?? 0) * P.cr + (u.output_tokens ?? 0) * P.o, 0);
  const cost = join(dirname(f), 'cost.jsonl'), led = existsSync(cost) ? lines(cost).reduce((s, r) => s + Number(r.costUsd ?? 0), 0) : 0;
  total += Math.max(last + tail, led);
}
console.log(total.toFixed(4));
