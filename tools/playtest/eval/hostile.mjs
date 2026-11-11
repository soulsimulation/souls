// Hostile cases with bystanders (#1974): one Soul flooding acts, many Souls reconnecting at once, and a god's wall across
// walking Souls. Each is a driver runCase calls once the case's Souls are set up (episode.mjs); it returns the same Soul
// records a scripted case does ({soul, name, soulId, ok, steps}) and the case's measures, one line each, for the report.
// A failed bar is a finding for a new issue: nothing here retries, softens or fixes what a case finds.
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { sleep } from '../lib/clock.mjs';
import { readJsonl } from '../lib/jsonl.mjs';
import { run } from '../lib/proc.mjs';
import { createGodSeat } from '../arena/god-seat.mjs';
import { liveHash } from '../../../apps/server/src/edge/catalog/live-delta.ts';
import { cli, runtimeDir, refusalOf, stepVerdict, ENDED_PHASES } from './episode.mjs';
import { httpSince, quantile } from './measure.mjs';

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const sec = (ms) => r1(ms / 1000);
const median = (xs) => quantile(xs, 0.5);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
/** The POST /v1/edge/act answers in a Soul's own client trace (soul-trace/1), with the rotated file before it. */
export function actCalls(folder, soulId, from = 0, to = Infinity) {
  const f = join(runtimeDir(folder, soulId), '.eden-report.jsonl');
  return httpSince([...readJsonl(`${f}.1`), ...readJsonl(f)], from, to).filter((r) => r.method === 'POST' && /^\/v1\/edge\/act(?:\?|$)/.test(r.route));
}
const liveOf = async (base) => { const r = await fetch(`${base}/v1/edge/live`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`live: HTTP ${r.status}`); return r.json(); };
const posOf = (pic, soulId) => pic?.souls?.find((x) => x.id === soulId)?.at ?? null;
const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null);
const centroid = (ps) => { const q = ps.filter(Boolean); return q.length ? [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length] : null; };

/** A TCP relay in front of the world. drop(holdMs) cuts every connection through it at once and turns new ones away for
 *  holdMs, as a network that goes away does; the clients behind it reconnect on their own. */
export async function startRelay(target) {
  const u = new URL(target), socks = new Set();
  let closedUntil = 0, cut = 0;
  const srv = createServer((c) => {
    if (Date.now() < closedUntil) { c.destroy(); return; }
    const w = connect(Number(u.port || 80), u.hostname);
    socks.add(c); socks.add(w);
    const end = () => { c.destroy(); w.destroy(); socks.delete(c); socks.delete(w); };
    for (const s of [c, w]) { s.on('error', end); s.on('close', end); }
    c.pipe(w); w.pipe(c);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return {
    base: `${u.protocol}//127.0.0.1:${srv.address().port}${u.pathname.replace(/\/$/, '')}`,
    drop(holdMs) { closedUntil = Date.now() + holdMs; cut = socks.size / 2; for (const s of socks) s.destroy(); socks.clear(); return cut; },
    close: () => new Promise((ok) => { for (const s of socks) s.destroy(); srv.close(() => ok()); }),
  };
}

/** A1: one Soul sends `acts` acts in `withinSec` through its launcher (eden.mjs, through its serve) while the others act
 *  every `everySec`. Every act over the limits gets a 429 and none a 5xx; each bystander's median act verdict during the spam
 *  stays within `ratio` times its own median over the `baselineSec` before (the client trace's time for POST /v1/edge/act). */
async function actSpam({ souls, item, t0 }) {
  const p = { acts: 200, withinSec: 10, baselineSec: 30, everySec: 2, ratio: 1.5, limitPerMin: 60, act: ['act', 'wave:here'], ...item.params };
  const [flood, ...by] = souls;
  let stop = false;
  const bystand = async (s) => { while (!stop) { const b = Date.now(); await cli(s.folders.own, p.act); await sleep(Math.max(0, p.everySec * 1000 - (Date.now() - b))); } };
  const byLoops = by.map(bystand);
  let spamStart, spam;
  try {   // the bystanders stop however the flood ends
  await sleep(p.baselineSec * 1000);
  spamStart = Date.now();
  spam = await Promise.all(Array.from({ length: p.acts }, async (_, i) => {
    await sleep((i * p.withinSec * 1000) / p.acts);
    const b = Date.now(), r = await cli(flood.folders.own, p.act, 180000);
    return { sentAt: b, endedAt: Date.now(), refusal: refusalOf(r), accepted: stepVerdict('accepted', r).ok };
  }));
  await sleep(p.everySec * 1000);
  } finally { stop = true; }
  await Promise.all(byLoops);
  const spamEnd = Math.max(...spam.map((x) => x.endedAt)), sentMs = Math.max(...spam.map((x) => x.sentAt)) - spamStart;
  const at = (t) => sec(t - t0);
  // the flood: what the launcher made of each act, and every answer the world (or the serve) gave to them
  const cliOut = {}; for (const x of spam) { const k = x.accepted ? 'accepted' : x.refusal ?? 'not accepted'; cliOut[k] = (cliOut[k] ?? 0) + 1; }
  const http = actCalls(flood.folders.own, flood.setup.soulId, spamStart - 1000), status = {};
  for (const r of http) status[r.status ?? 'none'] = (status[r.status ?? 'none'] ?? 0) + 1;
  const fivexx = http.filter((r) => r.status >= 500).length, answered = http.filter((r) => r.status && r.status !== 429).length;
  const floodSteps = [
    { at: at(spamStart), cmd: `${p.act.join(' ')} ×${p.acts}`, in: null, exit: null, refusal: null, ok: sentMs <= p.withinSec * 1000, why: `${p.acts} sent in ${sec(sentMs)} s; the launcher: ${JSON.stringify(cliOut)}; all ended ${sec(spamEnd - spamStart)} s after the first` },
    { at: at(spamEnd), cmd: 'HTTP answers to the flood', in: null, exit: null, refusal: http.some((r) => r.status === 429) ? 'rate-limited' : null,
      ok: fivexx === 0 && answered <= p.limitPerMin && http.length > 0,
      why: `${http.length} answers ${JSON.stringify(status)}: ${fivexx} 5xx; ${answered} not 429 (limit ${p.limitPerMin} a minute)` },
  ];
  const results = [{ soul: flood.spec.id, name: flood.spec.name, soulId: flood.setup.soulId, ok: floodSteps.every((x) => x.ok), steps: floodSteps }];
  const measures = [`Flood: ${p.acts} acts sent in ${sec(sentMs)} s; answers ${JSON.stringify(status)}; the launcher's verdicts ${JSON.stringify(cliOut)}.`];
  for (const s of by) {
    const calls = actCalls(s.folders.own, s.setup.soulId, spamStart - p.baselineSec * 1000);
    const before = calls.filter((r) => r.at < spamStart).map((r) => r.durationMs), during = calls.filter((r) => r.at >= spamStart && r.at <= spamEnd).map((r) => r.durationMs);
    const mb = median(before), md = median(during), ratio = mb && md != null ? md / mb : null;
    const bad = calls.filter((r) => r.at >= spamStart && r.at <= spamEnd && (r.status >= 500 || r.status === 429)).length;
    const ok = before.length >= 3 && during.length >= 1 && ratio != null && ratio <= p.ratio;
    const why = `median ${r1(mb)} ms over ${before.length} acts before, ${r1(md)} ms over ${during.length} during (×${ratio == null ? '?' : Math.round(ratio * 100) / 100}, bar ×${p.ratio}); max during ${r1(during.length ? Math.max(...during) : null)} ms; ${bad} answered 429 or 5xx during`;
    results.push({ soul: s.spec.id, name: s.spec.name, soulId: s.setup.soulId, ok, steps: [{ at: at(spamStart), cmd: `${p.act.join(' ')} every ${p.everySec} s`, in: null, exit: null, refusal: null, ok, why }] });
    measures.push(`${s.spec.name}: ${why}.`);
  }
  return { results, measures };
}

/** A2: every Soul's serve reaches the world through one relay; the relay cuts every stream at once and turns reconnects away
 *  for `holdSec`, while each Soul's short rest ends. Within `withinSec` of the relay letting them back, every Soul's copy
 *  (world-live.json) was received again and hashes (liveHash, the check the world sends) as the world's own picture does. */
async function reconnectStorm({ souls, item, base, relay, t0 }) {
  if (!relay) throw new Error('reconnect-storm needs "relay": true');
  const p = { restSec: 4, holdSec: 6, withinSec: 10, ...item.params };
  const at = (t) => sec(t - t0);
  const rested = await Promise.all(souls.map(async (s) => { const b = Date.now(), r = await cli(s.folders.own, ['act', 'rest:here', JSON.stringify({ seconds: p.restSec })]); const v = stepVerdict('accepted', r); return { at: at(b), cmd: `act rest:here {"seconds":${p.restSec}}`, in: null, exit: r.code, refusal: refusalOf(r), ok: v.ok, why: v.why, ms: Date.now() - b }; }));
  await sleep(500);
  const dropAt = Date.now(), cut = relay.drop(p.holdSec * 1000);
  await sleep(p.holdSec * 1000);
  const backAt = Date.now(), copyFile = (s) => join(runtimeDir(s.folders.own, s.setup.soulId), 'world-live.json');
  const firstEqual = new Map();
  let allAt = null, last = null, reads = 0;
  for (;;) {
    let world = null; try { world = liveHash(await liveOf(base)); } catch { /* the world did not answer this read */ }
    const now = Date.now(), copies = souls.map((s) => { const c = parse(readFileSync(copyFile(s), 'utf8')); return c ? { hash: liveHash(c.live ?? {}), fresh: c.receivedAt > backAt } : { hash: null, fresh: false }; });
    reads++; last = { world, copies };
    copies.forEach((c, i) => { if (world && c.fresh && c.hash === world && !firstEqual.has(i)) firstEqual.set(i, now); });
    if (world && copies.every((c) => c.fresh && c.hash === world)) { allAt = now; break; }
    if (now - backAt > p.withinSec * 1000) break;
    await sleep(250);
  }
  const results = souls.map((s, i) => {
    const eq = firstEqual.get(i), c = last.copies[i];
    const step = { at: at(backAt), cmd: 'its copy after the reconnect', in: null, exit: null, refusal: null, ok: allAt != null || (eq != null && eq - backAt <= p.withinSec * 1000),
      why: eq != null ? `received again and equal to the world's ${sec(eq - backAt)} s after the relay reopened` : `${c.fresh ? 'received again' : 'not received since the relay reopened'}; its hash ${c.hash ?? 'unread'}, the world's ${last.world ?? 'unread'}` };
    return { soul: s.spec.id, name: s.spec.name, soulId: s.setup.soulId, ok: rested[i].ok && step.ok, steps: [rested[i], step] };
  });
  const measures = [`Relay cut ${cut} connections at ${at(dropAt)} s and turned reconnects away for ${p.holdSec} s.`,
    allAt != null ? `Every copy (${souls.length}) equal to the world ${sec(allAt - backAt)} s after the relay reopened (${reads} reads).` : `Not every copy was equal within ${p.withinSec} s: ${firstEqual.size} of ${souls.length} were (${reads} reads).`];
  return { results, measures };
}

/** What eden-god.mjs made of one `place`: {placed, code, why}. It says REFUSED and still exits 0 (run r2: overlap.solid), and
 *  on overlap.solid it moves the thing itself (the next candidate, the server's suggestion, a nudge: "blocked (…) → …") and
 *  exits 0. Only a wall placed where it was asked counts: a refused or a moved one is not placed. */
export function wallVerdict(r) {
  const said = String(r.stdout || r.stderr).trim().replace(/\s+/g, ' '), shown = said.slice(0, 200);
  if (r.code !== 0 || /\bREFUSED\b/.test(said)) return { placed: false, code: /REFUSED:\s*([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)/.exec(said)?.[1] ?? `exit.${r.code}`, why: shown };
  if (/blocked \(/.test(said)) return { placed: false, code: /blocked \(([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)/.exec(said)?.[1] ?? 'wall.moved', why: `moved, not where asked: ${shown}` };
  return { placed: true, code: null, why: shown };
}

/** A3: the Souls walk to `to`; once they are moving, a god places a wall (`def`, `lengthM` long, `aheadM` ahead of them, across
 *  their heading) through eden-god.mjs. Within `holdSec` of the wall each walk has ended (its receipt in an end state, with a
 *  reason when it did not complete); each Soul's next walk (to `next`) is accepted and moves it `moveM` within `nextSec`. */
async function godWall({ souls, item, base, dir, serverRoot, t0, log }) {
  const p = { to: 'g-eden-bandstand', next: 'g-place-social-eden-fire-circle', def: 'garden-wall', aheadM: 8, lengthM: 30, heightM: 2, holdSec: 90, nextSec: 30, moveM: 1, ...item.params };
  if (!serverRoot) throw new Error('god-wall needs the server root (for eden-god.mjs)');
  const at = (t) => sec(t - t0);
  const god = createGodSeat({ runDir: dir, god: { adapter: 'scripted-owner' }, worldBase: base, serverRoot, preinstall: true });
  const g = (args) => run('node', ['eden-god.mjs', ...args], { cwd: god.folder, maxWallMs: 120000 });
  for (const a of [['register', base, 'dev:admin'], ['mint']]) { const r = await g(a); if (r.code !== 0) throw new Error(`god ${a[0]} exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`); }
  const ids = souls.map((s) => s.setup.soulId), start = await liveOf(base);
  const walks = await Promise.all(souls.map(async (s) => { const b = Date.now(), r = await cli(s.folders.own, ['act', `walk:${p.to}`]); const v = stepVerdict('accepted', r); return { b, r, v, receipt: parse(r.stdout)?.receipt?.id ?? null }; }));
  // where they are heading: the way their middle moved once it has moved 2 m (at most 15 s)
  const c0 = centroid(ids.map((id) => posOf(start, id)));
  let c1 = c0; for (const until = Date.now() + 15000; Date.now() < until; await sleep(500)) { const pic = await liveOf(base); c1 = centroid(ids.map((id) => posOf(pic, id))); if (dist(c0, c1) >= 2) break; }
  const moved = dist(c0, c1);
  const steps = souls.map((s, i) => [{ at: at(walks[i].b), cmd: `act walk:${p.to}`, in: null, exit: walks[i].r.code, refusal: refusalOf(walks[i].r), ok: walks[i].v.ok && !!walks[i].receipt, why: walks[i].v.why }]);
  const measures = [];
  let wallAt = null, wallStep;
  if (!c0 || !(moved >= 2)) wallStep = { ok: false, why: `the walkers did not move 2 m in 15 s (${r1(moved) ?? '?'} m): no heading to put a wall across` };
  else {
    const d = [(c1[0] - c0[0]) / moved, (c1[1] - c0[1]) / moved], n = [-d[1], d[0]], w = [c1[0] + d[0] * p.aheadM, c1[1] + d[1] * p.aheadM], h = p.lengthM / 2;
    const path = [[r1(w[0] - n[0] * h), r1(w[1] - n[1] * h)], [r1(w[0] + n[0] * h), r1(w[1] + n[1] * h)]];
    const b = Date.now(), r = await g(['place', p.def, '--path', JSON.stringify(path), '--param', `height=${p.heightM}`]), v = wallVerdict(r);
    wallAt = v.placed ? Date.now() : null;
    wallStep = { at: at(b), cmd: `god place ${p.def} --path ${JSON.stringify(path)}`, exit: r.code, refusal: v.code, ok: v.placed, why: `${sec(Date.now() - b)} s: ${v.why}` };
    log(`${item.id}: wall ${wallStep.ok ? 'placed' : 'refused'} across the heading ${p.aheadM} m ahead`);
  }
  measures.push(`Wall: ${wallStep.ok ? `placed ${wallStep.why.split(':')[0]} after the call, across the walkers' heading` : `not placed (${wallStep.why})`}.`);
  // each walk until its receipt ends (or holdSec after the wall), then its next walk and 1 m of motion
  await Promise.all(souls.map(async (s, i) => {
    const f = s.folders.own, from = wallAt ?? Date.now(), rid = walks[i].receipt;
    let ended = null, d = null, tries = 0;
    while (rid) {
      const r = await cli(f, ['receipt', rid]); tries++; d = parse(r.stdout);
      const phase = d?.phase ?? d?.receipt?.phase ?? null;
      if (ENDED_PHASES.includes(phase)) { ended = { phase, reason: d?.reason ?? d?.receipt?.reason ?? null, code: d?.code ?? d?.receipt?.code ?? null, t: Date.now() }; break; }
      if (Date.now() - from > p.holdSec * 1000) break;
      await sleep(1500);
    }
    const held = ended ? Math.max(0, ended.t - from) : null, reasoned = ended && (ended.phase === 'completed' || !!(ended.reason ?? ended.code));
    s.held = { held, ended };
    steps[i].push({ at: at(from), cmd: `receipt ${rid ?? '(none)'}`, in: null, exit: null, refusal: ended?.code ?? null,
      ok: !!wallAt && !!ended && reasoned && held <= p.holdSec * 1000, heldSec: sec(held),
      why: ended ? `${ended.phase}${ended.code ? ` ${ended.code}` : ''}${ended.reason ? `: ${ended.reason}` : ended.code ? '' : ' (no reason)'}; held ${sec(held)} s after the wall` : `not ended ${p.holdSec} s after the wall (${tries} reads; last ${d?.phase ?? d?.receipt?.phase ?? 'unread'})` });
    const before = posOf(await liveOf(base), s.setup.soulId), b = Date.now(), r = await cli(f, ['act', `walk:${p.next}`]), v = stepVerdict('accepted', r);
    let moved1 = null;
    if (v.ok) for (; Date.now() - b <= p.nextSec * 1000; await sleep(500)) { const m = dist(before, posOf(await liveOf(base), s.setup.soulId)); if (m != null && m >= p.moveM) { moved1 = Date.now() - b; break; } }
    steps[i].push({ at: at(b), cmd: `act walk:${p.next}`, in: null, exit: r.code, refusal: refusalOf(r), ok: v.ok && moved1 != null, why: v.ok ? (moved1 != null ? `accepted; moved ${p.moveM} m in ${sec(moved1)} s` : `accepted; did not move ${p.moveM} m in ${p.nextSec} s`) : v.why });
  }));
  const results = [{ soul: 'god', name: 'God', soulId: null, ok: wallStep.ok, steps: [{ in: null, ...wallStep }] },
    ...souls.map((s, i) => ({ soul: s.spec.id, name: s.spec.name, soulId: s.setup.soulId, ok: steps[i].every((x) => x.ok), steps: steps[i] }))];
  measures.push(`Held after the wall: ${souls.map((s) => `${s.spec.name} ${s.held.held == null ? `over ${p.holdSec} s` : `${sec(s.held.held)} s (${s.held.ended.phase}${s.held.ended.code ? ` ${s.held.ended.code}` : ''})`}`).join('; ')}.`);
  return { results, measures };
}

export const DRIVES = { 'act-spam': actSpam, 'reconnect-storm': reconnectStorm, 'god-wall': godWall };
