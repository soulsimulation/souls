// #2556: uneven load shapes for every scaling bench. `schedule(shape, n, seconds, seed)` is pure and seeded: from a shape
// of shapes.json (or a shape object), a count of joined Souls and a window it gives, per agent, when it is present and
// the acts due ({at, kind, place, pick}), and the schedule's own summary, which every report prints so a reader sees
// what was offered. The schedule is open loop: an act is due at its time whether or not the last one was answered, so a
// bench reports achieved against intended. No I/O beyond reading the data files once, no clock, no Math.random.
import { readFileSync } from 'node:fs';
import { CADENCE, firstMs } from '../meetup/client-soul.mjs';
import { rng } from '../meetup/workload.mjs';

export const SHAPES = Object.freeze(JSON.parse(readFileSync(new URL('./shapes.json', import.meta.url), 'utf8')));
const v = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const ms = (s) => Math.round(s * 1000) / 1000;
const between = (r, [a, b]) => a + r() * (b - a);
/** The standard normal's inverse CDF (Abramowitz and Stegun 26.2.23, error under 5e-4), for 0 < p < 1. */
function probit(p) {
  const q = p < 0.5 ? p : 1 - p, t = Math.sqrt(-2 * Math.log(q)), z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return p < 0.5 ? -z : z;
}
function shuffled(r, xs) { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function weighted(r, mix) { const e = Object.entries(mix); let x = r() * e.reduce((s, [, w]) => s + w, 0); for (const [k, w] of e) if ((x -= w) < 0) return k; return e.at(-1)[0]; }
/** `count` times over [t0, t0 + spread), one at a random point of each equal slot, in a seeded order: at most `perSec`
 *  in any one second (slots of at least 1 / (perSec - 1) s; a crowd too large for that is spread over longer). */
function spreadTimes(r, count, t0, spread, perSec) {
  const w = Math.max(spread / Math.max(1, count), 1 / Math.max(1, perSec - 1));
  return shuffled(r, Array.from({ length: count }, (_, k) => t0 + w * (k + r())));
}

/** Who is present when: per agent a list of stays [arrive, leave). Presence picks exactly round(share x n) agents. */
function stays(S, n, T, seed, name) {
  const r = rng(`${seed}|${name}|presence`), order = shuffled(r, Array.from({ length: n }, (_, i) => i));
  const present = order.slice(0, Math.round(v(S.presence) * n)), out = Array.from({ length: n }, () => []);
  out.groups = [present.slice(), order.slice(present.length)];
  const A = S.arrivals;
  if (!A) { for (const i of present) out[i].push([0, T]); return out; }
  const atStart = Math.round(v(A.startShare) * present.length), late = present.slice(atStart);
  for (const i of present.slice(0, atStart)) out[i].push([0, T]);
  spreadTimes(r, late.length, 0, v(A.rampSec), v(A.maxPerSec)).forEach((t, k) => out[late[k]].push([ms(Math.max(t, 0.001)), T]));
  for (let w = v(A.waveEverySec); w < T; w += v(A.waveEverySec)) {
    const here = shuffled(r, present.filter((i) => out[i].some(([a, b]) => a <= w && w < b)));
    const away = shuffled(r, Array.from({ length: n }, (_, i) => i).filter((i) => !out[i].some(([a, b]) => a <= w && w < b)));
    const k = Math.min(Math.round(v(A.waveShare) * here.length), away.length), half = v(A.waveSpreadSec);
    spreadTimes(r, k, w, half, v(A.maxPerSec)).forEach((t, j) => { const s = out[here[j]].find(([a, b]) => a <= w && w < b); s[1] = ms(Math.min(t, T)); });
    spreadTimes(r, k, w, half, v(A.maxPerSec)).forEach((t, j) => { if (t < T) out[away[j]].push([ms(t), T]); });
    for (const i of away.slice(0, k)) if (!present.includes(i)) present.push(i);
  }
  return out;
}

/** One agent's own act times inside its stays (seconds), before crowd moments. */
function ownTimes(S, stayList, T, r, opts, z) {
  const times = [], rate = S.rate, tm = S.time;
  if (rate.kind === 'equal') {
    // today's paced loop (tools/playtest/eval/load.mjs pacedLoop, #2437): first at U(0, actSec), then actSec x U(0.5, 1.5)
    const actSec = opts.actSec ?? v(rate.actSec), [g0, g1] = v(tm.gapShare);
    for (const [a, b] of stayList) for (let t = a + r() * actSec; t < b; t += actSec * (g0 + r() * (g1 - g0))) times.push(t);
    return times;
  }
  // heavy-tailed rate, fixed per agent: log-normal around the median, capped at one act per minSec
  const perSec = Math.min(1 / v(rate.minSec), Math.exp(Math.log(1 / v(rate.medianSec)) + v(rate.sigma) * z));
  const [n0, n1] = v(tm.runActs), [p0, p1] = v(tm.pauseShare), cycle = ((n0 + n1) / 2) / perSec;
  // an agent faster than a run's own gaps allow (one act per 3 s on average) closes its gaps up to its rate, so the cap
  // is the only limit on the busiest agents and the heavy tail is kept
  const g = v(tm.runGapSec), squeeze = Math.min(1, 1 / perSec / ((g[0] + g[1]) / 2)), runGap = [g[0] * squeeze, g[1] * squeeze];
  for (const [a, b] of stayList) {
    // at the window's start an agent is part way through its cycle; an arrival acts after the live agents' first-act time
    let t = a === 0 ? r() * cycle : a + firstMs(CADENCE.real, r()) / 1000;
    while (t < b) {
      const run = n0 + Math.floor(r() * (n1 - n0 + 1)); let inRun = 0;
      for (let k = 0; k < run && t < b; k++) { times.push(t); if (k < run - 1) { const d = between(r, runGap); t += d; inRun += d; } }
      t += Math.max(runGap[0], (run / perSec - inRun) * (p0 + r() * (p1 - p0)));
    }
  }
  return times;
}

const actAt = (S, r, at, extra = {}) => {
  const kind = weighted(r, v(S.mix)), gathered = kind === 'walk' && r() < v(S.place.gatheredShare);
  return { at: ms(at), kind, place: kind === 'walk' ? (gathered ? 'gathered' : 'spread') : null, pick: Math.floor(r() * 2 ** 31), ...extra };
};

/** The schedule. `shape` is a name in shapes.json (`uniform`, `everyday`, `event`) or a shape object; `seed` a number or
 *  string; `opts.actSec` sets the uniform pace (a bench's --act-sec). → {shape, n, seconds, seed, agents, crowds,
 *  summary}. Each agent: {i, arrive, leave (first arrival, last leave; null when never present), stays: [[arrive,
 *  leave)], acts: [{at, kind, place, pick, crowd?}]} sorted by `at`. `place` is 'spread' (a target around the map),
 *  'gathered' (within place.radiusM of the bench's one named place) or null (not a walk); `pick` chooses among the
 *  ids the bench has for that kind. */
export function schedule(shape, n, seconds, seed, opts = {}) {
  const name = typeof shape === 'string' ? shape : (shape.name ?? 'custom'), S = typeof shape === 'string' ? SHAPES.agents[shape] : shape;
  if (!S) throw new Error(`unknown shape ${shape}; known: ${Object.keys(SHAPES.agents).join(', ')}`);
  const T = seconds, presence = stays(S, n, T, seed, name);
  // each agent's place in the rate distribution, stratified: the agents present from the start, and the rest, each
  // take one quantile slice of the log-normal in a seeded order, so every schedule carries the shape's whole tail (a
  // few very busy agents) and two seeds differ in who is busy and when, not in how skewed the load is
  const z = new Array(n).fill(0), rz = rng(`${seed}|${name}|rates`);
  for (const g of presence.groups) shuffled(rz, g.map((_, k) => k)).forEach((k, j) => { z[g[j]] = probit((k + rz()) / g.length); });
  const agents = presence.map((st, i) => {
    const r = rng(`${seed}|${name}|agent|${i}`);
    return { i, arrive: st.length ? Math.min(...st.map((s) => s[0])) : null, leave: st.length ? Math.max(...st.map((s) => s[1])) : null, stays: st,
      acts: ownTimes(S, st, T, r, opts, z[i]).map((t) => actAt(S, r, t)) };
  });
  const crowds = [];
  if (S.crowds) {
    const r = rng(`${seed}|${name}|crowds`), C = S.crowds;
    for (let t = between(r, v(C.gapSec)); t < T; t += between(r, v(C.gapSec))) {
      const here = agents.filter((a) => a.stays.some(([x, y]) => x <= t && t < y)), who = shuffled(r, here).slice(0, Math.round(v(C.share) * here.length));
      crowds.push({ at: ms(t), n: who.length });
      for (const a of who) { const at = t + r() * v(C.withinSec); if (a.stays.some(([x, y]) => x <= at && at < y)) a.acts.push(actAt(S, r, at, { crowd: crowds.length - 1 })); }
    }
    for (const a of agents) a.acts.sort((x, y) => x.at - y.at);
  }
  return { shape: name, n, seconds: T, seed, agents, crowds, summary: summarize(agents, T) };
}

/** What a schedule offers: intended acts a second over time (`perS`, one count per second), the mean, the largest
 *  number due in any one second and when, the share of acts made by the busiest tenth of the agents that are ever
 *  present, the arrivals after the start (first, last, most in any one second, how many in each minute) and the acts
 *  by kind. */
export function summarize(agents, T) {
  const at = agents.flatMap((a) => a.acts.map((x) => x.at)).sort((x, y) => x - y), perS = Array.from({ length: Math.ceil(T) }, () => 0);
  for (const t of at) perS[Math.min(perS.length - 1, Math.floor(t))]++;
  let burst = 0, burstAt = null; for (let i = 0, j = 0; i < at.length; i++) { while (at[j] <= at[i] - 1) j++; if (i - j + 1 > burst) { burst = i - j + 1; burstAt = at[j]; } }
  const ever = agents.filter((a) => a.stays.length), counts = ever.map((a) => a.acts.length).sort((x, y) => y - x), top = Math.max(1, Math.ceil(ever.length / 10));
  const arrivals = agents.flatMap((a) => a.stays.map((s) => s[0])).filter((t) => t > 0).sort((x, y) => x - y);
  let arrPerS = 0; for (let i = 0, j = 0; i < arrivals.length; i++) { while (arrivals[j] <= arrivals[i] - 1) j++; arrPerS = Math.max(arrPerS, i - j + 1); }
  const kinds = {}; for (const a of agents) for (const x of a.acts) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  const mean = at.length / T;
  return { acts: at.length, meanPerS: +mean.toFixed(3), maxBurst1s: burst, maxBurstAtS: burstAt, burstToMean: mean ? +(burst / mean).toFixed(2) : null,
    topTenthShare: at.length ? +(counts.slice(0, top).reduce((s, c) => s + c, 0) / at.length).toFixed(3) : null,
    present: { ever: ever.length, atStart: agents.filter((a) => a.stays.some((s) => s[0] === 0)).length },
    arrivals: { n: arrivals.length, firstS: arrivals[0] ?? null, lastS: arrivals.at(-1) ?? null, maxPerS: arrPerS, perMinute: Array.from({ length: Math.ceil(T / 60) }, (_, m) => arrivals.filter((t) => Math.floor(t / 60) === m).length) }, kinds, perS };
}

/** One line for a report: what the schedule offered. */
export const describe = (s, name = '') => `${name ? `${name}: ` : ''}${s.acts} acts intended, ${s.meanPerS}/s mean, largest one-second burst ${s.maxBurst1s} (${s.burstToMean ?? '-'}x mean) at ${s.maxBurstAtS ?? '-'} s; busiest tenth ${s.topTenthShare == null ? '-' : Math.round(100 * s.topTenthShare) + ' %'} of acts; ${s.present.ever} agents present (${s.present.atStart} from the start, ${s.arrivals.n} arrivals after it, at most ${s.arrivals.maxPerS} a second)`;
