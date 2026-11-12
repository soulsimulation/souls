// #1952 counted stair playtest scorer (lane 7). Usage: node score.mjs runs/*/run.json. Judges every run, base and cand, by the
// rule declared on the issue before any run.
// Frozen act: a walk act still open (accepted/started/queued/waiting/running/held) when the kit stops polling it, 180 s after
// it was sent. Frozen Soul: a Soul with at least one frozen act.
import { readFileSync } from 'node:fs';
const OPEN = new Set(['accepted', 'started', 'queued', 'waiting', 'running', 'held']), out = [];
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, 'utf8')), acts = (r.acts ?? []).filter(a => a.id !== 'walk:eden-tower-house');
  const frozenActs = acts.filter(a => OPEN.has(a.phase)), frozenSouls = [...new Set(frozenActs.map(a => a.n))].sort();
  const glitch = r.glitchLines ?? [], ladder = glitch.filter(l => /rung=(contained|halt|recovery|rewind)/.test(l)).length;
  const engineEnds = acts.filter(a => /^engine\./.test(a.code ?? '')).length;
  const teleportRefusals = acts.filter(a => /motion\.teleport/.test(`${a.code ?? ''} ${a.reason ?? ''}`)).length;
  const res = { arm: r.arm, commit: String(r.commit).slice(0, 9), startedAt: r.startedAt, endedAt: r.endedAt, worldRan: !r.halted, acts: acts.length,
    completed: acts.filter(a => a.phase === 'completed').length, routeBlocked: acts.filter(a => a.code === 'route.blocked').length,
    waitBound: acts.filter(a => /wait-bound\/1/.test(a.reason ?? '')).length, frozenSouls, frozenActs: frozenActs.map(a => `${a.n}@${a.t.toFixed(0)}s ${a.phase}`),
    ladder, engineEnds, teleportRefusals, maxTickMs: r.maxTickMs };
  res.pass = res.worldRan && frozenSouls.length === 0 && ladder === 0 && engineEnds === 0 && teleportRefusals === 0;
  out.push(res);
}
console.log(JSON.stringify(out, null, 1));
