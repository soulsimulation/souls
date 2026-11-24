// The limits run's judge and table (0.133 P3): each rung folder of limits.sh, read by stage 2a's analyser
// (analyze.mjs), judged against the fixed limits it measures, then one table and the limit that gave way first.
//
//   node v2/tools/bench/stage2a/limits.mjs [--label <text>] <rung folder> ...   the table
//   node v2/tools/bench/stage2a/limits.mjs --check <rung folder> ...            exit 3 naming each limit missed
//
// The limits, fixed before any run (the master view's; read time, start time, action time, join time and frame rate
// are not measured by this run: the first three are the client's and the engine's own measures, the last two are
// read from the old page in a real browser):
// - receipt: send to accepted or refused, p50 at most 100 ms and p95 at most 300 ms;
// - viewer delay: a part's arrival at a viewer after its end in world time, p50 at most 1 s and p95 at most 2 s over
//   the load window, and not growing: the last minute's p50 at most 1.5 times the first minute's and at most 250 ms
//   more. Read from the rung's viewers (viewers.mjs); with none, from the driver's own stream reader;
// - ticks on time: at least 99 in 100 over the load window;
// - stuck Souls: none (the driver's rule, `stuck.rule` in its report);
// - no result: the rung gave no result (a world, gateway or driver ended); a crash, never a number;
// - memory: the world's, gateway's and origin's resident memory together at most MEM_LIMIT_MB, when it is set.
// Reported beside them, not judged: refusals by cause, processor cores and the busiest world thread, send to the
// first visible move, the viewers' first picture and drops.
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.mjs';

export const BARS = Object.freeze({ receiptP50Ms: 100, receiptP95Ms: 300, delayP50Ms: 1000, delayP95Ms: 2000, growRatio: 1.5, growMs: 250, onTimeShare: 0.99, stuck: 0 });

/** The viewer delay a rung is judged by: its viewers' stream latency, else the driver's stream lag. */
export function delayOf(r) {
  const v = r.viewers;
  if (v?.latency?.n) return { from: 'viewers', p50Ms: v.latency.p50Ms, p95Ms: v.latency.p95Ms, firstP50Ms: v.firstMinute?.p50Ms ?? null, lastP50Ms: v.lastMinute?.p50Ms ?? null };
  return { from: 'driver', p50Ms: r.wait?.streamLagP50Ms ?? null, p95Ms: r.wait?.streamLagP95Ms ?? null, firstP50Ms: null, lastP50Ms: null };
}

/** The limits a rung missed, each `<limit> (<value> against <bar>)`; [] when every one held. `memLimitMb` is optional. */
export function judge(r, memLimitMb = 0) {
  if (!r) return ['no result (a world, gateway or driver ended)'];
  const missed = [];
  const a = r.accepted ?? {};
  if (a.p50Ms == null || a.p50Ms > BARS.receiptP50Ms || a.p95Ms > BARS.receiptP95Ms) missed.push(`receipt (p50 ${a.p50Ms ?? '-'} / p95 ${a.p95Ms ?? '-'} ms against ${BARS.receiptP50Ms} / ${BARS.receiptP95Ms})`);
  const d = delayOf(r);
  if (d.p50Ms == null || d.p50Ms > BARS.delayP50Ms || d.p95Ms > BARS.delayP95Ms) missed.push(`viewer delay (p50 ${d.p50Ms ?? '-'} / p95 ${d.p95Ms ?? '-'} ms against ${BARS.delayP50Ms} / ${BARS.delayP95Ms})`);
  if (d.firstP50Ms != null && d.lastP50Ms != null && d.lastP50Ms > Math.max(BARS.growRatio * d.firstP50Ms, d.firstP50Ms + BARS.growMs)) missed.push(`viewer delay grows (p50 ${d.firstP50Ms} ms in the first minute, ${d.lastP50Ms} ms in the last)`);
  const on = r.tick?.onTimeShare;
  if (on == null || on < BARS.onTimeShare) missed.push(`ticks on time (${on == null ? '-' : (100 * on).toFixed(2) + ' %'} against 99 %)`);
  const stuck = r.stuck?.stuck;
  if (stuck == null || stuck > BARS.stuck) missed.push(`stuck Souls (${stuck ?? '-'} against 0)`);
  const mb = (r.cpu?.worldMb ?? 0) + (r.cpu?.gatewayMb ?? 0) + (r.cpu?.originMb ?? 0);
  if (memLimitMb > 0 && mb > memLimitMb) missed.push(`memory (${mb} MB against ${memLimitMb})`);
  return missed;
}

/** One rung folder: its analysis (null when it gave none) and its name's parts, `<n>-<arm>-<rate>-r<k>`. */
export function rung(dir) {
  const name = dir.replace(/\/+$/, '').split('/').pop();
  const [n, arm, rate, k] = name.split('-');
  let r = null;
  try { r = analyze(dir); } catch { /* no result: judged as that */ }
  return { dir, name, n: Number(n), arm, rate, repeat: k, r };
}

const top = (o, k) => Object.entries(o ?? {}).slice(0, k).map(([c, n]) => `${c} ${n}`).join('; ') || 'none';

export function table(rows, memLimitMb = 0, label = '') {
  const t = label ? [`**${label}**`, ''] : [];
  t.push('| Agents | arm | rate | repeat | acts/s | receipt p50 / p95 ms | viewer delay p50 / p95 ms (first, last minute p50) | send → first visible move p95 ms | ticks on time | stuck | refusals by cause | cores world / gateway / origin (busiest world thread) | MB world / gateway / origin | viewers (peak, first picture p95 ms, drops) | limits |');
  t.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of rows) {
    const r = x.r, missed = judge(r, memLimitMb);
    if (!r) { t.push(`| ${x.n} | ${x.arm} | ${x.rate} | ${x.repeat} | ${Array(10).fill('-').join(' | ')} | **${missed.join('; ')}** |`); continue; }
    const d = delayOf(r), v = r.viewers, b = r.threads?.world?.[0];
    t.push(`| ${x.n} | ${x.arm} | ${x.rate} | ${x.repeat} | ${r.acts.perS} | ${r.accepted.p50Ms ?? '-'} / ${r.accepted.p95Ms ?? '-'} | ${d.p50Ms ?? '-'} / ${d.p95Ms ?? '-'}${d.from === 'viewers' ? ` (${d.firstP50Ms ?? '-'}, ${d.lastP50Ms ?? '-'})` : ' (driver)'} | ${r.wait.p95Ms ?? '-'} | ${r.tick.onTimeShare == null ? '-' : (100 * r.tick.onTimeShare).toFixed(2) + ' %'} | ${r.stuck?.stuck ?? '-'} | ${top(r.byCause, 3)} | ${r.cpu.world} / ${r.cpu.gateway} / ${r.cpu.origin}${b ? ` (${b[0]} ${b[1]})` : ''} | ${r.cpu.worldMb} / ${r.cpu.gatewayMb} / ${r.cpu.originMb} | ${v ? `${v.peakViewers}, ${v.firstPicture?.p95Ms ?? '-'}, ${v.drops}` : 'none'} | ${missed.length ? `**${missed.join('; ')}**` : 'held'} |`);
  }
  t.push('', gaveWay(rows, memLimitMb));
  return t.join('\n');
}

/** The first rung, in ladder order, that missed a limit, and which; or that every limit held. */
export function gaveWay(rows, memLimitMb = 0) {
  const sorted = [...rows].sort((a, b) => a.n - b.n);
  for (const n of [...new Set(sorted.map((x) => x.n))]) {
    const at = sorted.filter((x) => x.n === n).map((x) => ({ x, missed: judge(x.r, memLimitMb) })).filter((y) => y.missed.length);
    if (at.length) return `**Gave way first:** at ${n} agents: ${at.map(({ x, missed }) => `${x.arm} ${x.rate} ${x.repeat}: ${missed.join('; ')}`).join(' · ')}.`;
  }
  return `**Every limit held** up to ${sorted.at(-1)?.n ?? 0} agents.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), mem = Number(process.env.MEM_LIMIT_MB ?? 0);
  const check = args[0] === '--check';
  const label = args[0] === '--label' ? args[1] : '';
  const rows = args.slice(check ? 1 : label ? 2 : 0).map(rung);
  if (check) {
    const missed = rows.flatMap((x) => judge(x.r, mem).map((m) => `${x.name}: ${m}`));
    for (const m of missed) console.log(`gave way ${m}`);
    process.exit(missed.length ? 3 : 0);
  }
  console.log(table(rows, mem, label));
}
