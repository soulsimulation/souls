// The soak's summary (Engine v2 O6, #2803): the minute file as a table by hour, the slopes and the bars.
//
//   node v2/tools/soak/collect.mjs <run folder> [--from <hour>] [--json]
//
// Hours count from the run's start (start.txt); hour k is minutes [k*60, k*60+60), printed 1-based as the issue
// says them ("hour 2" is the second). Per hour: the medians of world and gateway anon memory, their peaks, open
// files and threads, the world folder's bytes (and the part that is not its log), the tick's mean and over-budget
// share (exact), its p99 (the median of the minutes' p99 of sampled ticks), the queues' oldest item, and the driver's
// acts achieved and answer p99. Slopes are least squares over every minute from --from (default hour 2) on, per
// hour. The bars compare the first full hour at or after --from with the last full hour.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--from');
const from = Number(args[args.indexOf('--from') + 1] ?? 2) || 2;
const lines = fs.readFileSync(path.join(dir, 'minutes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const t0 = Number(fs.readFileSync(path.join(dir, 'start.txt'), 'utf8'));
const med = (xs) => { const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const isLog = (name) => /log|event/i.test(name);
const MB = 1024 * 1024;
const row = (m) => ({
  h: (m.t - t0) / 3600,
  wAnon: m.world?.anonKb / 1024, gAnon: m.gateway?.anonKb / 1024, wPeak: m.world?.peakKb / 1024, gPeak: m.gateway?.peakKb / 1024,
  wFile: m.world?.fileKb / 1024, cgAnon: m.cgroup?.anon / MB, cgFile: m.cgroup?.file / MB,
  wFds: m.world?.fds, gFds: m.gateway?.fds, wThr: m.world?.threads, gThr: m.gateway?.threads,
  disk: Object.values(m.bytes ?? {}).reduce((a, b) => a + b, 0) / MB,
  diskLess: Object.entries(m.bytes ?? {}).filter(([k]) => !isLog(k)).reduce((a, [, b]) => a + b, 0) / MB,
  bytes: m.bytes ?? {},
  tickMean: m.tick?.meanUs, tickN: m.tick?.n, over: m.tick?.overBudget, tickP99: m.tick?.p99Us,
  queue: m.queues ? Math.max(0, ...Object.values(m.queues)) : null,
});
const rows = lines.map(row);
const hours = new Map();
for (const r of rows) { const k = Math.floor(r.h); if (!hours.has(k)) hours.set(k, []); hours.get(k).push(r); }
const driver = (k) => {
  const d = fs.readdirSync(path.join(dir, 'runs')).find((x) => x.startsWith(`h${String(k).padStart(2, '0')}-`));
  if (!d) return {};
  const arm = d.split('-')[1];
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'runs', d, 'report.json'), 'utf8'));
    const p99 = med(rep.perMinute?.map((m) => m.latencyP99Ms) ?? []);
    const share = rep.achievedShare ?? null;
    return { arm, achieved: share, answerP99: p99 };
  } catch { return { arm }; }
};
const per = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([k, rs]) => {
  const n = rs.reduce((a, r) => a + (r.tickN ?? 0), 0);
  return {
    hour: k + 1, minutes: rs.length, ...driver(k),
    wAnon: med(rs.map((r) => r.wAnon)), gAnon: med(rs.map((r) => r.gAnon)), wPeak: Math.max(...rs.map((r) => r.wPeak || 0)),
    cgAnon: med(rs.map((r) => r.cgAnon)), cgFile: med(rs.map((r) => r.cgFile)),
    wFds: med(rs.map((r) => r.wFds)), gFds: med(rs.map((r) => r.gFds)), wThr: med(rs.map((r) => r.wThr)), gThr: med(rs.map((r) => r.gThr)),
    disk: rs.at(-1).disk, diskLess: rs.at(-1).diskLess, bytes: rs.at(-1).bytes,
    tickMean: n ? rs.reduce((a, r) => a + (r.tickMean ?? 0) * (r.tickN ?? 0), 0) / n : null,
    overShare: n ? rs.reduce((a, r) => a + (r.over ?? 0), 0) / n : null,
    tickP99: med(rs.map((r) => r.tickP99)), queue: Math.max(...rs.map((r) => r.queue ?? 0)),
  };
});
const slope = (key) => {
  const pts = rows.filter((r) => r.h >= from - 1 && r[key] != null && !Number.isNaN(r[key]));
  if (pts.length < 10) return null;
  const mx = pts.reduce((a, p) => a + p.h, 0) / pts.length, my = pts.reduce((a, p) => a + p[key], 0) / pts.length;
  const sxy = pts.reduce((a, p) => a + (p.h - mx) * (p[key] - my), 0), sxx = pts.reduce((a, p) => a + (p.h - mx) ** 2, 0);
  return sxx ? sxy / sxx : null;
};
const f = (x, d = 1) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(d));
const out = [];
out.push(`Soak ${path.basename(dir)}: ${rows.length} minutes, ${f(rows.at(-1)?.h, 2)} h since start.`, '');
out.push('| hour | arm | world anon MB | gateway anon MB | world peak MB | cgroup anon / file MB | open files w / g | threads w / g | world folder MB (less log) | tick mean ms | over budget | tick p99 ms (sampled) | oldest queue ms | acts achieved | answer p99 ms |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of per) {
  out.push(`| ${p.hour}${p.minutes < 55 ? ` (${p.minutes} min)` : ''} | ${p.arm ?? '-'} | ${f(p.wAnon)} | ${f(p.gAnon)} | ${f(p.wPeak)} | ${f(p.cgAnon, 0)} / ${f(p.cgFile, 0)} | ${p.wFds} / ${p.gFds} | ${p.wThr} / ${p.gThr} | ${f(p.disk, 0)} (${f(p.diskLess, 0)}) | ${f(p.tickMean / 1000, 2)} | ${p.overShare == null ? '-' : (100 * p.overShare).toFixed(2) + ' %'} | ${f(p.tickP99 / 1000, 1)} | ${f(p.queue / 1000, 0)} | ${p.achieved == null ? '-' : (100 * p.achieved).toFixed(1) + ' %'} | ${f(p.answerP99, 0)} |`);
}
out.push('', `Slopes per hour, from hour ${from} on (least squares over the minutes): world anon ${f(slope('wAnon'), 2)} MB, gateway anon ${f(slope('gAnon'), 2)} MB, cgroup anon ${f(slope('cgAnon'), 2)} MB, world open files ${f(slope('wFds'), 2)}, world threads ${f(slope('wThr'), 2)}, world folder ${f(slope('disk'), 0)} MB (less log ${f(slope('diskLess'), 0)} MB), tick mean ${f(slope('tickMean') / 1000, 3)} ms.`);
const last = per.at(-1), growth = last ? Object.entries(last.bytes).sort((a, b) => b[1] - a[1]).slice(0, 6) : [];
out.push('', `World folder by entry at the last minute (MB): ${growth.map(([k, v]) => `${k} ${f(v / MB, 0)}`).join(', ')}.`);
const full = per.filter((p) => p.minutes >= 55);
const a = full.find((p) => p.hour >= from), b = full.at(-1);
if (a && b && b.hour > a.hour) {
  const within = (x, y, pct) => (x && y != null ? Math.abs(y - x) / x <= pct / 100 : null);
  const yes = (v) => (v == null ? '-' : v ? 'met' : 'MISSED');
  const sAnon = slope('wAnon');
  out.push('', `Bars, hour ${a.hour} against hour ${b.hour}${b.hour < 24 ? ' (the run is not over: provisional)' : ''}:`, '');
  out.push('| measure | hour ' + a.hour + ' | hour ' + b.hour + ' | bar | |', '|---|---|---|---|---|');
  out.push(`| world anon slope MB/h | | ${f(sAnon, 2)} | < 1 | ${yes(sAnon == null ? null : sAnon < 1)} |`);
  out.push(`| world anon median MB | ${f(a.wAnon)} | ${f(b.wAnon)} | within 5 % | ${yes(within(a.wAnon, b.wAnon, 5))} |`);
  for (const [k, label] of [['wFds', 'world open files'], ['gFds', 'gateway open files'], ['wThr', 'world threads'], ['gThr', 'gateway threads'], ['diskLess', 'world folder less log MB']])
    out.push(`| ${label} | ${f(a[k], 0)} | ${f(b[k], 0)} | within 5 % | ${yes(within(a[k], b[k], 5))} |`);
  out.push(`| tick p99 ms (sampled) | ${f(a.tickP99 / 1000, 1)} | ${f(b.tickP99 / 1000, 1)} | within 10 % | ${yes(within(a.tickP99, b.tickP99, 10))} |`);
}
const restart = fs.existsSync(path.join(dir, 'restart.txt')) ? fs.readFileSync(path.join(dir, 'restart.txt'), 'utf8').trim() : null;
if (restart) out.push('', `Restart after SIGKILL: ${restart}.`);
console.log(args.includes('--json') ? JSON.stringify({ per, rows: rows.length }) : out.join('\n'));
