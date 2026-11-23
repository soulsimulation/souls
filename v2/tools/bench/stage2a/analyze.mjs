// Stage 2a's analyser (#4154): one rung's folder (rung.sh) → one JSON summary against the bar, or several folders →
// the markdown tables the pull request carries.
//
//   node v2/tools/bench/stage2a/analyze.mjs <rung folder>            prints `rung {json}`
//   node v2/tools/bench/stage2a/analyze.mjs --table <folder> ...      prints the tables
//
// The bar (fixed before the runs): act wait to the first move on the public stream p50 ≤ 100 ms and p95 ≤ 300 ms,
// ≥ 99 % of ticks within the 50 ms budget, 0 stuck Souls. The tick numbers are over the load window only: the
// world's health counters (health.json, sampled every 5 s) at the window's two ends, differenced.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BAR = Object.freeze({ waitP50Ms: 100, waitP95Ms: 300, onTimeShare: 0.99, stuck: 0 });

// #4193: refusals summed by cause (the reason, over every verb). A `claim-taken` the agent's own later act caused is
// not among them: the driver counts it apart (`replacedByOwnAct`).
export function byCause(refusals) {
  const c = {};
  for (const [k, n] of Object.entries(refusals ?? {})) { const why = k.split(' ').slice(1).join(' ') || k; c[why] = (c[why] ?? 0) + n; }
  return Object.fromEntries(Object.entries(c).sort((x, y) => y[1] - x[1]));
}

export function analyze(D) {
  const J = (p) => JSON.parse(fs.readFileSync(`${D}/${p}`, 'utf8'));
  const rep = J('run/report.json');
  const smp = fs.readFileSync(`${D}/samples.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((s) => s.h);
  const [t0, t1] = fs.readFileSync(`${D}/win.txt`, 'utf8').trim().split('\n').map(Number);
  // The clock starts once every agent is signed in; the load window is the schedule's length before the driver ended
  // (its drain of 15 s excluded).
  const secs = Math.max(...fs.readFileSync(`${D}/schedule.txt`, 'utf8').split('\n').filter((l) => /^\d/.test(l)).map((l) => +l.split(' ')[0])) / 1000;
  const endS = t1 - 15, beginS = Math.max(t0, endS - secs);
  const near = (t) => smp.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const w1 = near(beginS + 5), w2 = near(endS);
  const dCount = w2.h.ticks.count - w1.h.ticks.count, dOver = (w2.h.over_budget ?? 0) - (w1.h.over_budget ?? 0);
  const meanWin = (a, b) => (a && b && b.count > a.count ? (b.mean_us * b.count - a.mean_us * a.count) / (b.count - a.count) : null);
  const phases = {};
  for (const k of Object.keys(w2.h.phases ?? {})) phases[k] = { meanUs: Math.round(meanWin(w1.h.phases[k], w2.h.phases[k]) ?? 0), p99Us: w2.h.phases[k].p99_us, maxUs: w2.h.phases[k].max_us };
  const dt = w2.t - w1.t;
  const cores = (k) => +(((w2[k] ?? 0) - (w1[k] ?? 0)) / dt).toFixed(2);
  const mb = (k) => Math.round(Math.max(...smp.map((s) => s[k] || 0)) / 1024);
  const v = rep.visible ?? {};
  const refusals = rep.refusedBy ?? {};
  const out = {
    rung: D.split('/').pop(), agents: rep.agents, describe: rep.describe,
    acts: { intended: rep.intendedActs, achievedShare: rep.achievedShare, perS: +(rep.all.sent / Math.max(1, secs)).toFixed(1), lateP99Ms: rep.all.lateP99Ms, byVerb: rep.byVerb, standIns: rep.standIns, withheld: rep.withheld },
    accepted: { p50Ms: v.acceptedP50Ms, p95Ms: v.acceptedP95Ms, p99Ms: v.acceptedP99Ms },
    wait: { taken: v.taken, seen: v.seen, seenShare: v.seenShare, p50Ms: v.p50Ms, p95Ms: v.p95Ms, p99Ms: v.p99Ms, maxMs: v.maxMs, within100: v.within100Ms, within300: v.within300Ms, streamLagP50Ms: v.streamLagP50Ms, streamLagP95Ms: v.streamLagP95Ms, writerLagP50Ms: v.writerLagP50Ms, writerLagP95Ms: v.writerLagP95Ms, visibleBeforeAnswerShare: v.visibleBeforeAnswerShare, visibleAfterAnswerP50Ms: v.visibleAfterAnswerP50Ms, visibleAfterAnswerP95Ms: v.visibleAfterAnswerP95Ms, byVerb: v.byVerb },
    answer: rep.perMinute.map((m) => ({ p50: m.latencyP50Ms, p95: m.latencyP95Ms, p99: m.latencyP99Ms })),
    tick: { p50Us: w2.h.ticks.p50_us, p99Us: w2.h.ticks.p99_us, maxUs: w2.h.ticks.max_us, meanUs: Math.round(meanWin(w1.h.ticks, w2.h.ticks) ?? 0), count: dCount, over: dOver, onTimeShare: dCount ? +(1 - dOver / dCount).toFixed(4) : null },
    accuracy: rep.accuracy ?? null, sent: rep.all?.sent,
    phases, stuck: rep.stuck, refusals, byCause: byCause(refusals), replacedByOwnAct: rep.replacedByOwnAct ?? null, sameTarget: rep.sameTarget ?? null, errors: rep.perMinute.reduce((e, m) => { for (const [k, x] of Object.entries(m.errors)) e[k] = (e[k] ?? 0) + x; return e; }, {}),
    cpu: { world: cores('wcpu'), gateway: cores('gcpu'), origin: cores('ocpu'), worldMb: mb('wrss'), gatewayMb: mb('grss'), originMb: mb('orss') },
    threads: Object.fromEntries(['wthreads', 'gthreads'].map((k) => [k === 'wthreads' ? 'world' : 'gateway', Object.entries(w2[k] ?? {}).map(([n, c]) => [n, +((c - (w1[k]?.[n] ?? 0)) / dt).toFixed(2)]).filter(([, c]) => c >= 0.05).sort((a, b) => b[1] - a[1]).slice(0, 8)])),
    syncs: (() => {
      if (!fs.existsSync(`${D}/syncs.txt`)) return null;
      const lines = fs.readFileSync(`${D}/syncs.txt`, 'utf8').split('\n').map((l) => l.split(' ')).filter((f) => +f[1] >= beginS && +f[1] <= endS && /^f?(data)?sync|sync_file_range/.test(f[2] ?? ''));
      const byPid = {}; for (const f of lines) byPid[f[0]] = (byPid[f[0]] ?? 0) + 1;
      const span = endS - beginS;
      return { perS: +(lines.length / span).toFixed(1), takenPerS: +((v.taken ?? 0) / span).toFixed(1), threads: Object.keys(byPid).length, busiestThreadPerS: +(Math.max(0, ...Object.values(byPid)) / span).toFixed(1) };
    })(),
    driverCores: rep.driverCores, loadavgBefore: fs.existsSync(`${D}/loadavg.before`) ? fs.readFileSync(`${D}/loadavg.before`, 'utf8').trim() : null,
  };
  out.bar = {
    waitP50: v.p50Ms != null && v.p50Ms <= BAR.waitP50Ms, waitP95: v.p95Ms != null && v.p95Ms <= BAR.waitP95Ms,
    ticksOnTime: out.tick.onTimeShare != null && out.tick.onTimeShare >= BAR.onTimeShare, stuck: (rep.stuck?.stuck ?? 1) <= BAR.stuck,
  };
  out.bar.met = Object.values(out.bar).every(Boolean);
  return out;
}

const yes = (b) => (b ? 'yes' : '**no**');
const ms = (us) => (us == null ? '-' : (us / 1000).toFixed(1));

export function tables(rows, label = '') {
  const t = label ? [`**${label}**`, ''] : [];
  t.push('| Rung (agents, arm, rate, cores) | acts/s | send → accepted p50 / p95 ms | send → first visible move p50 / p95 / p99 ms (seen share) | tick p50 / p99 / max ms | ticks on time | stuck (refused-only) | world / gateway / origin cores | world / gateway MB | bar |');
  t.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    t.push(`| ${r.rung} | ${r.acts.perS} | ${r.accepted.p50Ms ?? '-'} / ${r.accepted.p95Ms ?? '-'} | ${r.wait.p50Ms} / ${r.wait.p95Ms} / ${r.wait.p99Ms} (${r.wait.seenShare}) | ${ms(r.tick.p50Us)} / ${ms(r.tick.p99Us)} / ${ms(r.tick.maxUs)} | ${r.tick.onTimeShare == null ? '-' : (100 * r.tick.onTimeShare).toFixed(2) + ' %'} | ${r.stuck?.stuck ?? '-'} (${r.stuck?.refusedOnly ?? '-'}) | ${r.cpu.world} / ${r.cpu.gateway} / ${r.cpu.origin} | ${r.cpu.worldMb} / ${r.cpu.gatewayMb} | ${yes(r.bar.met)} |`);
  }
  t.push('', '**Where the wait to the first visible move goes** (ms, p50 / p95): the world takes the act (accepted), the stream writer cuts and writes the part (writer lag: the newest part\'s end against the wall when the pointer is read), the reader fetches it (stream lag: a part\'s arrival against its end).', '');
  t.push('| Rung | send → accepted (durable answer) | writer lag | stream lag at the reader | send → first visible move | visible after the answer | visible before the answer (share) | disk syncs/s against acts taken/s |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) t.push(`| ${r.rung} | ${r.accepted.p50Ms ?? '-'} / ${r.accepted.p95Ms ?? '-'} | ${r.wait.writerLagP50Ms ?? '-'} / ${r.wait.writerLagP95Ms ?? '-'} | ${r.wait.streamLagP50Ms} / ${r.wait.streamLagP95Ms} | ${r.wait.p50Ms} / ${r.wait.p95Ms} | ${r.wait.visibleAfterAnswerP50Ms ?? '-'} / ${r.wait.visibleAfterAnswerP95Ms ?? '-'} | ${r.wait.visibleBeforeAnswerShare ?? '-'} | ${r.syncs ? `${r.syncs.perS} / ${r.syncs.takenPerS} (${r.syncs.threads} threads)` : '-'} |`);
  t.push('', '**Send → first visible move by action** (ms, p50 / p95, acts seen; Gene\'s responsiveness measure):', '');
  const verbs = [...new Set(rows.flatMap((r) => Object.keys(r.wait.byVerb ?? {})))].sort();
  t.push(`| Rung | ${verbs.map((x) => x.replace(/^eden:/, '')).join(' | ')} |`, `|---|${verbs.map(() => '---').join('|')}|`);
  for (const r of rows) t.push(`| ${r.rung} | ${verbs.map((x) => { const b = r.wait.byVerb?.[x]; return b ? `${b.p50Ms} / ${b.p95Ms} (${b.seen})` : '-'; }).join(' | ')} |`);
  t.push('', '**Phase profile** (mean µs per tick over the load window; p99 µs in brackets):', '');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.phases)))];
  t.push(`| Rung | ${keys.join(' | ')} |`, `|---|${keys.map(() => '---').join('|')}|`);
  for (const r of rows) t.push(`| ${r.rung} | ${keys.map((k) => (r.phases[k] ? `${r.phases[k].meanUs} (${r.phases[k].p99Us})` : '-')).join(' | ')} |`);
  t.push('', '**Busiest threads** (cores over the load window):', '');
  for (const r of rows) if (r.threads?.world?.length) t.push(`- ${r.rung}: world ${r.threads.world.map(([n, c]) => `${n} ${c}`).join(', ')}; gateway ${r.threads.gateway.map(([n, c]) => `${n} ${c}`).join(', ')}`);
  t.push('', '**Accuracy by position** (Gene\'s measure: each agent\'s last act naming a place, checked by where its body is 15 s after the last act, not by receipt; shares of those checked. A body within 4 m of its place, positions in micrometres composed with each frame\'s turn, or seated in it, is there (#4193)):', '');
  t.push('| Rung | checked | at the place | world said done, body elsewhere | still under way | not taken (refused) | refused acts / sent, all acts |', '|---|---|---|---|---|---|---|');
  for (const r of rows) { const a = r.accuracy; const refused = Object.values(r.refusals).reduce((x, y) => x + y, 0); t.push(`| ${r.rung} | ${a?.checked ?? '-'} | ${a?.atPlaceShare ?? '-'} | ${a?.doneButElsewhereShare ?? '-'} | ${a?.underWayShare ?? '-'} | ${a?.notTakenShare ?? '-'} | ${r.sent ? (refused / r.sent).toFixed(3) : '-'} |`); }
  t.push('', '**Refusals by cause** (all verbs; a `claim-taken` caused by the agent\'s own later act is counted apart, not refused) and **same target** (Souls sent to one place over the run: the most, and places sent more than three):', '');
  t.push('| Rung | refused / sent | by cause | replaced by own act | same target: most Souls (places over three / places) |', '|---|---|---|---|---|');
  for (const r of rows) { const refused = Object.values(r.byCause).reduce((x, y) => x + y, 0); t.push(`| ${r.rung} | ${refused} / ${r.sent ?? '-'} | ${Object.entries(r.byCause).map(([k, n]) => `${k} ${n}`).join('; ') || 'none'} | ${r.replacedByOwnAct ?? '-'} | ${r.sameTarget ? `${r.sameTarget.mostSouls} (${r.sameTarget.placesOverShare} / ${r.sameTarget.places})` : '-'} |`); }
  t.push('', '**Refusals by name** (verb and reason):', '');
  for (const r of rows) t.push(`- ${r.rung}: ${Object.entries(r.refusals).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join('; ') || 'none'}`);
  return t.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--table') {
    const label = args[1] === '--label' ? args[2] : '';
    const rows = args.slice(label ? 3 : 1).map((d) => { try { return analyze(d); } catch (e) { console.error(`${d}: ${e.message}`); return null; } }).filter(Boolean);
    console.log(tables(rows, label));
  } else console.log(`rung ${JSON.stringify(analyze(args[0]))}`);
}
