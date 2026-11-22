// The driver's loads (Engine v2 I10, #2693): what 1,000 scripted agents intend, from the shared load shapes
// (tools/bench/capacity/profiles/shapes.mjs, #2556), imported and never copied. Each load is one schedule, or two
// merged, and prints its `describe` line.
//
//   node v2/tools/driver/loads.mjs <target|target-even|stretch|ladder-<n>-<even|uneven>> [--agents 1000] [--seconds 600] [--seed 1] --out <file>
//
// The file is the driver's input (v2/tools/driver/README.md): the describe line, then one act a line, in time order,
// `<due ms> <agent> <kind> <verb>`, with `-` for a kind no v2 intent carries yet.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHAPES, describe, schedule, summarize } from '../../../tools/bench/capacity/profiles/shapes.mjs';

/** Each shape kind's v2 intent (its verb, v2/docs/intents.md rule 4). A kind missing here is sent as nothing,
 *  counted and reported by the driver. */
export const VERBS = Object.freeze({
  walk: 'eden:walk', sit: 'eden:sit', 'sit-ground': 'eden:sit-ground', read: 'eden:read', eat: 'eden:eat',
  'play-music': 'eden:play-music', gesture: 'eden:wave', say: 'eden:say',
});

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
export const LADDER = Object.freeze([10, 50, 100, 200, 350, 500]);

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
});

/** The driver's file: the describe line, then `<due ms> <agent> <kind> <verb>` a line, by due time then agent. */
export function scheduleFile(load, sched) {
  const acts = sched.agents.flatMap((a) => a.acts.map((x) => [Math.round(x.at * 1000), a.i, x.kind]));
  acts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const head = `# ${describe(sched.summary, `${load} (seed ${sched.seed}, ${sched.n} agents, ${sched.seconds} s)`)}`;
  return `${head}\n${acts.map(([t, i, k]) => `${t} ${i} ${k} ${VERBS[k] ?? '-'}`).join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
