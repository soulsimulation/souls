// The driver's loads (Engine v2 I10, #2693): what 1,000 scripted agents intend, from the shared load shapes
// (tools/bench/capacity/profiles/shapes.mjs, #2556), imported and never copied. Each load is one schedule, or two
// merged, and prints its `describe` line.
//
//   node v2/tools/driver/loads.mjs <target|target-even|stretch|ladder-<n>-<even|uneven>> [--agents 1000] [--seconds 600] [--seed 1] --out <file>
//
// The file is the driver's input (v2/tools/driver/README.md): the describe line, then one act a line, in time order,
// `<due ms> <agent> <kind> <verb>`, with `-` for a kind no v2 intent carries yet.
import { isMain } from '../../../tools/lib/is-main.mjs';
import { writeFileSync } from 'node:fs';
import { SHAPES, describe, schedule, summarize } from '../../../tools/bench/capacity/profiles/shapes.mjs';

/** Each shape kind's v2 intent (its verb, v2/docs/intents.md rule 4). A kind missing here is sent as nothing,
 *  counted and reported by the driver. */
export const VERBS = Object.freeze({
  walk: 'eden:walk', sit: 'eden:sit', 'sit-ground': 'eden:sit-ground', read: 'eden:read', eat: 'eden:eat',
  'play-music': 'eden:play-music', gesture: 'eden:wave', say: 'eden:say',
  // #4154's mix: the body's one-thing forms and take (then put, `hands:set-down`); the driver picks the real form.
  go_to: 'eden:go_to', look_at: 'eden:look_at', touch: 'eden:touch', lean_on: 'eden:lean_on', wait_by: 'eden:wait_by',
  point: 'eden:point', take: 'eden:take',
});

/** The real Soul Actions mix (stage 2a, #4154), shares in percent: say most (people talk most), then walks and the
 *  body's forms on Eden's things, take and put, sits, gestures. Each act's kind is drawn from it by a hash of the
 *  seed, the agent and the act, so the same name and seed give the same schedule. */
export const MIX = Object.freeze({
  say: 22, walk: 14, gesture: 10, take: 10, go_to: 8, sit: 8, look_at: 7, point: 6, touch: 6, lean_on: 5, wait_by: 4,
});

/** The mix's rate arms: every agent acting every 4 s (125 acts a second at 500), a burst at 2.7 times that, and
 *  Gene's stated rate, about 1,000 acts a minute at 500 agents (each every 29.4 s, about 17 a second). */
export const RATES = Object.freeze({ every4: 4, burst: 1.5, gene17: 29.4 });

/** FNV-1a of a text, as a share of 1. */
const share = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return (h >>> 0) / 2 ** 32; };
const MIX_KINDS = Object.entries(MIX), MIX_TOTAL = MIX_KINDS.reduce((s, [, w]) => s + w, 0);
const mixKind = (u) => { let x = u * MIX_TOTAL; for (const [k, w] of MIX_KINDS) { if ((x -= w) < 0) return k; } return MIX_KINDS.at(-1)[0]; };

/** A schedule with its acts' kinds redrawn from MIX. */
function mixed(sched, seed) {
  const agents = sched.agents.map((a) => ({ ...a, acts: a.acts.map((x, j) => ({ ...x, kind: mixKind(share(`${seed}|mix|${a.i}|${j}`)) })) }));
  return { ...sched, agents, summary: summarize(agents, sched.seconds) };
}

/** A mix load (#4154): `mix-<n>-<even|uneven>-<every4|burst>`. Even is `uniform` at the arm's pace; uneven is the
 *  shared `event` shape with every agent present, its time scaled so it intends as many acts a second as the even
 *  arm (so the two differ in how the load falls, not how much: skewed rates, crowds and bursts kept). */
function mixLoad(n, arm, rate) {
  const pace = RATES[rate];
  return (_, s, seed) => {
    if (arm === 'even') return mixed(schedule('uniform', n, s, seed, { actSec: pace }), seed);
    const ev = { ...SHAPES.agents.event, name: 'event-all', presence: { value: 1, source: '#4154: every agent present' } };
    // The event shape's rate is not linear in its length (its crowds and runs), so the scale is found in a few steps.
    const squeeze = (k) => {
      const long = schedule(ev, n, Math.ceil(s * k), seed);
      const agents = long.agents.map((a) => ({ ...a, stays: [[0, s]], acts: a.acts.filter((x) => x.at / k < s).map((x) => ({ ...x, at: x.at / k })) }));
      return { ...long, shape: `event-all x${k.toFixed(2)}`, seconds: s, agents, acts: agents.reduce((t, a) => t + a.acts.length, 0) };
    };
    let k = n / pace / Math.max(1e-9, schedule(ev, n, s, seed).summary.meanPerS), sq = squeeze(k);
    for (let i = 0; i < 4 && Math.abs(sq.acts / s - n / pace) > 0.02 * (n / pace); i++) sq = squeeze((k *= (n / pace) / (sq.acts / s)));
    return mixed(sq, seed);
  };
}

/** `target`: a copy of `event` with every agent present, every walk to the gathered place and a median agent acting
 *  every 18 s, about 5,000 acts a minute at 1,000 agents. Its name is part of the seed. */
export const TARGET = Object.freeze({
  ...SHAPES.agents.event, name: 'target',
  presence: { value: 1, source: '#2693: 1,000 means 1,000 present' },
  place: { ...SHAPES.agents.event.place, gatheredShare: { value: 1, source: '#2693: everyone at the one place' } },
  rate: { ...SHAPES.agents.event.rate, medianSec: { value: 18, source: '#2693: about 5,000 acts a minute at 1,000 agents' } },
});

/** Two schedules as one: `b`'s agents numbered after `a`'s. */
export function merge(a, b, name) {
  const agents = [...a.agents, ...b.agents.map((x) => ({ ...x, i: x.i + a.n }))];
  return { shape: name, n: a.n + b.n, seconds: a.seconds, seed: a.seed, agents, parts: [a.shape, b.shape], summary: summarize(agents, a.seconds) };
}

/** The ladder's steps (X7, #4015): agent counts for the measured runs on a served world. */
export const LADDER = Object.freeze([10, 20, 50, 100, 200, 350, 500, 750, 1000]);

/** A ladder step's two arms, its count fixed by its name (`--agents` is not read): uneven is the shared `event` shape
 *  as it is; even is `uniform` at the pace that intends as many acts as the uneven arm with the same seconds and seed,
 *  so the two differ in how the load falls, not in how much there is (docs/architecture/scaling.md). */
const ladder = (n) => ({
  [`ladder-${n}-uneven`]: (_, s, seed) => schedule('event', n, s, seed),
  [`ladder-${n}-even`]: (_, s, seed) => {
    const acts = schedule('event', n, s, seed).summary.acts;
    return schedule('uniform', n, s, seed, { actSec: Math.round((10 * n * s) / Math.max(1, acts)) / 10 });
  },
});

/** The loads: (agents, seconds, seed) → a schedule. */
export const LOADS = Object.freeze({
  target: (n, s, seed) => schedule(TARGET, n, s, seed),
  'target-even': (n, s, seed) => schedule('uniform', n, s, seed, { actSec: 12 }),
  // A tenth of the agents at 2 intents a second, which `event` cannot say (its minSec is 2 s): 9/10 on the target,
  // 1/10 on `uniform` at actSec 0.5.
  stretch: (n, s, seed) => {
    const fast = Math.round(n / 10);
    return merge(schedule(TARGET, n - fast, s, seed), schedule('uniform', fast, s, seed, { actSec: 0.5 }), 'stretch');
  },
  ...Object.assign({}, ...LADDER.map(ladder)),
  ...Object.fromEntries(LADDER.flatMap((n) => ['even', 'uneven'].flatMap((arm) => Object.keys(RATES)
    .map((rate) => [`mix-${n}-${arm}-${rate}`, mixLoad(n, arm, rate)])))),
  // What an idle body costs (#4154): 5,000 Souls present, 500 of them acting (every tenth, the last agent among
  // them so all 5,000 sign in and are borne), as the 500's `mix` load.
  ...Object.fromEntries(['even', 'uneven'].flatMap((arm) => Object.keys(RATES).map((rate) => [`mix-5000x500-${arm}-${rate}`, (_, s, seed) => {
    const few = mixLoad(500, arm, rate)(500, s, seed);
    const by = new Map(few.agents.map((a) => [a.i * 10 + 9, a]));
    const agents = Array.from({ length: 5000 }, (_, i) => ({ ...(by.get(i) ?? { stays: [[0, s]], acts: [] }), i }));
    return { ...few, n: 5000, agents, summary: summarize(agents, s) };
  }]))),
});

/** The driver's file: the describe line, then `<due ms> <agent> <kind> <verb>` a line, by due time then agent. */
export function scheduleFile(load, sched) {
  const acts = sched.agents.flatMap((a) => a.acts.map((x) => [Math.round(x.at * 1000), a.i, x.kind]));
  acts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const head = `# ${describe(sched.summary, `${load} (seed ${sched.seed}, ${sched.n} agents, ${sched.seconds} s)`)}`;
  return `${head}\n${acts.map(([t, i, k]) => `${t} ${i} ${k} ${VERBS[k] ?? '-'}`).join('\n')}\n`;
}

if (isMain(import.meta.url)) {
  const [load, ...rest] = process.argv.slice(2);
  const opt = (k, d) => { const j = rest.indexOf(`--${k}`); return j < 0 ? d : rest[j + 1]; };
  const out = opt('out'), make = LOADS[load];
  if (!make || !out) {
    console.error(`usage: loads.mjs <${Object.keys(LOADS).join('|')}> [--agents n] [--seconds s] [--seed k] --out <file>`);
    process.exit(2);
  }
  const text = scheduleFile(load, make(Number(opt('agents', 1000)), Number(opt('seconds', 600)), Number(opt('seed', 1))));
  writeFileSync(out, text);
  console.log(text.slice(2, text.indexOf('\n')));
}
