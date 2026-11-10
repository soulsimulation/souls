// Soul Client eval (#1752): REPORT.md from result.json, optionally side by side with another run (`--against`).

const f = (s, unit = '') => (s?.median == null ? 'n/a' : s.min === s.max ? `${s.median}${unit}` : `${s.median}${unit} (${s.min} to ${s.max})`);
const sec = (s) => (s?.median == null ? 'n/a' : f({ median: r(s.median / 1000), min: r(s.min / 1000), max: r(s.max / 1000) }, ' s'));
const r = (x) => Math.round(x * 10) / 10;
const usd = (s) => (s?.median == null ? 'n/a' : `$${s.median.toFixed(3)}`);
const codes = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

/** All episodes' http routes folded again (the per-episode records carry per-route quantiles, so refold from their counts). */
function routeTable(result) {
  const by = new Map();
  for (const e of result.episodes ?? []) for (const x of e.routes ?? []) {
    const k = x.route, a = by.get(k) ?? { route: k, n: 0, over: 0, p50: [], p99: [], max: 0, level: x.level, levelMs: x.levelMs, longPoll: x.longPoll, client: [] };
    a.n += x.n; a.over += x.overLevel ?? 0; if (x.serverMs?.p50 != null) a.p50.push(x.serverMs.p50); if (x.serverMs?.p99 != null) a.p99.push(x.serverMs.p99);
    a.max = Math.max(a.max, x.serverMs?.max ?? 0); if (x.clientMs?.p50 != null) a.client.push(x.clientMs.p50); by.set(k, a);
  }
  const med = (xs) => (xs.length ? [...xs].sort((p, q) => p - q)[Math.floor((xs.length - 1) / 2)] : null);
  return [...by.values()].sort((p, q) => q.n - p.n).map((a) => `| \`${a.route}\` | ${a.n} | ${med(a.client) ?? 'n/a'} | ${med(a.p50) ?? 'n/a'} | ${a.max} | ${a.longPoll ? 'long poll' : `${a.level} ${a.levelMs} ms: ${a.over} over`} |`);
}

const med = (eps) => { const xs = (eps ?? []).map((e) => e.sinceCreateMs).filter(Number.isFinite).sort((p, q) => p - q); return xs.length ? xs[Math.floor((xs.length - 1) / 2)] : null; };

export function renderReport(a, b = null) {
  const L = [];
  const head = (x) => `${x.battery} on ${x.world}; seat ${x.seat.adapter}${x.seat.model ? ` (${x.seat.model})` : ''}; client ${x.episodes?.find((e) => e.client)?.client?.cli ?? '?'} / skill ${x.episodes?.find((e) => e.client)?.client?.skill ?? '?'}; server ${x.serverCommit ?? '?'}; ${x.repeats} repeat(s); ${x.warmSec ? `instructions sent at least ${x.warmSec} s after create` : 'instructions sent as soon as the agent is listening (cold)'}${med(x.episodes) != null ? `, median ${Math.round(med(x.episodes) / 1000)} s after create` : ''}; spent $${(x.spentUsd ?? 0).toFixed(3)}`;
  L.push(`# Soul Client eval`, '', `- **Run:** ${head(a)}`);
  if (b) L.push(`- **Against:** ${head(b)}`);
  const kick = (a.episodes ?? []).reduce((s, e) => s + (e.kickoff?.costUsd ?? 0), 0);
  if (kick) L.push(`- **Kickoff turns** (read the guide, start listening; not in the per-instruction numbers): $${kick.toFixed(3)} in all`);
  if (a.stoppedBy) L.push(`- **Stopped early:** ${a.stoppedBy}`);
  const errs = (a.episodes ?? []).filter((e) => e.error);
  if (errs.length) L.push(`- **Episodes that could not run:** ${errs.map((e) => `${e.item} r${e.repeat}: ${e.error}`).join('; ')}`);
  const t = a.summary.total;
  L.push('', `**Succeeded ${t.succeeded} of ${t.episodes}.** Model turns ${f(t.modelTurns)}, API calls ${f(t.apiCalls)}, world calls ${f(t.worldCalls)}, first motion ${sec(t.firstMotionMs)}, client ${f(t.clientMsPerCall, ' ms')} and server ${f(t.serverMsPerCall, ' ms')} per call, tokens in ${f(t.tokensIn)} and out ${f(t.tokensOut)}. Medians per episode (min to max).`);
  if (b) { const u = b.summary.total; L.push('', `Against: **succeeded ${u.succeeded} of ${u.episodes}.** Model turns ${f(u.modelTurns)}, API calls ${f(u.apiCalls)}, world calls ${f(u.worldCalls)}, first motion ${sec(u.firstMotionMs)}, tokens in ${f(u.tokensIn)}.`); }
  L.push('', '## Per instruction', '', '| item | ok | turns | API calls | world calls | CLI calls | first motion | success at | client ms/call | server ms/call | refusals | tokens in / out | cost |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const other = new Map((b?.summary.items ?? []).map((x) => [x.item, x]));
  for (const x of a.summary.items) {
    L.push(`| ${x.item} | ${x.succeeded}/${x.episodes} | ${f(x.modelTurns)} | ${f(x.apiCalls)} | ${f(x.worldCalls)} | ${f(x.cliCalls)} | ${sec(x.firstMotionMs)} | ${sec(x.successMs)} | ${f(x.clientMsPerCall)} | ${f(x.serverMsPerCall)} | ${codes(x.refusals)} | ${f(x.tokensIn)} / ${f(x.tokensOut)} | ${usd(x.costUsd)} |`);
    const y = other.get(x.item);
    if (y) L.push(`| ↳ against | ${y.succeeded}/${y.episodes} | ${f(y.modelTurns)} | ${f(y.apiCalls)} | ${f(y.worldCalls)} | ${f(y.cliCalls)} | ${sec(y.firstMotionMs)} | ${sec(y.successMs)} | ${f(y.clientMsPerCall)} | ${f(y.serverMsPerCall)} | ${codes(y.refusals)} | ${f(y.tokensIn)} / ${f(y.tokensOut)} | ${usd(y.costUsd)} |`);
  }
  L.push('', '## Episodes', '', '| # | item | repeat | ok | why | ended by | card | CLI commands |', '|---|---|---|---|---|---|---|---|');
  (a.episodes ?? []).forEach((e, i) => L.push(`| ${i + 1} | ${e.item} | ${e.repeat} | ${e.error ? 'error' : e.succeeded ? 'yes' : 'no'} | ${(e.error ?? e.why ?? '').replace(/\|/g, '/')} | ${e.endedBy ?? ''} | ${e.card ? `${e.card.outcome ?? e.card.state}` : ''} | ${codes(e.seat?.cliCalls)} |`));
  L.push('', '## World calls by route (server time from `Server-Timing`)', '', 'Levels from #1750 (p99.9 server-side): bookkeeping 50 ms, reads 100 ms, an act\'s acknowledgment 150 ms. Long polls hold their answer by design and have no level.', '',
    '| route | calls | client p50 ms (median of episodes) | server p50 ms (median of episodes) | server max ms | level |', '|---|---|---|---|---|---|', ...routeTable(a));
  L.push('', 'Success is read from the public Soul view (place, posture, receipts) and the owner card\'s state, never from the agent\'s words. Tokens in count input, cache reads and cache writes.');
  return L.join('\n') + '\n';
}
