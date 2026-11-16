// #2117 counted playtest: classifies each frozen walk of a #1952-kit run (frozen act as score-frozen.mjs defines it) by a
// logging-only replay of the run's own log on its own tree (replay.mjs + probe.mjs, as #2001's run did). Declared before the runs.
// Usage: node classify-frozen.mjs <runDir> <treeDir> <port>
// For each frozen act: the receipt in the run's database (same Soul, same capability, created nearest the act's send time,
// within 15 s); the walk's last probe sample with its exec present between the receipt's accepted tick and 3,600 ticks later.
// mid-flight: exec phase 'climb' with climbT > 0, or cancelTo set (#1453's class, which #2117 leaves excluded): reported, not scored.
// scored: every other frozen walk (off a flight, or at a flight's foot with climbT 0), and any walk that cannot be classified.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const [runArg, treeArg, port] = process.argv.slice(2), run = resolve(runArg), tree = resolve(treeArg), here = resolve(import.meta.dirname);
const OPEN = new Set(['accepted', 'started', 'queued', 'waiting', 'running', 'held']), WINDOW = 3600;
const r = JSON.parse(readFileSync(`${run}/run.json`, 'utf8'));
const frozen = (r.acts ?? []).filter(a => a.id !== 'walk:eden-tower-house' && OPEN.has(a.phase));
const db = `${run}/data/sim.db`, sql = q => spawnSync('sqlite3', ['-json', `file:${db}?immutable=1`, q], { encoding: 'utf8' }).stdout.trim();
const t0 = Date.parse(r.startedAt), items = [];
for (const a of frozen) {
  const soul = JSON.parse(sql(`select id, entity_id from souls where name = '${a.n}' and retired_at is null`) || '[]')[0];
  const recs = soul ? JSON.parse(sql(`select receipt_id, accepted_tick, created_at from edge_receipts_v1 where soul_id = '${soul.id}' and capability = '${a.id}'`) || '[]') : [];
  const want = t0 + a.t * 1000, rec = recs.map(x => ({ ...x, d: Math.abs(x.created_at - want) })).sort((x, y) => x.d - y.d)[0];
  items.push({ act: `${a.n}@${a.t.toFixed(0)}s ${a.id.split('/').pop()}`, entity: soul?.entity_id ?? null, receipt: rec && rec.d <= 15000 ? rec.receipt_id : null, from: rec && rec.d <= 15000 ? rec.accepted_tick : null });
}
const windows = items.filter(x => x.entity && x.from != null);
let samples = [];
if (windows.length) {
  const until = Math.max(...windows.map(x => x.from + WINDOW)) + 50, log = `${run}/probe.log`;
  process.env.PROBE_WINDOWS = windows.map(x => `${x.entity}:${x.from}:${x.from + WINDOW}`).join(',');
  spawnSync(process.execPath, [`${here}/replay.mjs`, run, tree, port, String(until), log], { stdio: 'inherit', env: process.env });
  if (existsSync(log)) samples = readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('[probe] ')).map(l => JSON.parse(l.slice(8)));
}
for (const x of items) {
  const s = x.entity && x.from != null ? samples.filter(q => q.id === x.entity && q.t >= x.from && q.t <= x.from + WINDOW && q.ex).at(-1) : undefined;
  x.last = s ? { t: s.t, phase: s.ex.phase, climbT: s.ex.climbT, cancelTo: s.ex.cancelTo ?? null, code: s.rec?.code ?? null } : null;
  x.class = !s ? 'unclassified' : (s.ex.phase === 'climb' && (s.ex.climbT > 0 || s.ex.cancelTo != null)) ? 'mid-flight' : s.ex.phase === 'climb' ? 'flight-foot' : 'off-flight';
  x.scored = x.class !== 'mid-flight';
}
console.log(JSON.stringify({ run: run.split('/').pop(), arm: r.arm, commit: String(r.commit).slice(0, 9), frozenWalks: items.length, scoredFrozen: items.filter(x => x.scored).length, items }, null, 1));
