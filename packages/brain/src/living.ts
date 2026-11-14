import { nextFloat, seedRng } from '@souls/engine-contract';
import type { MidContext, MidDecision } from './mid.ts';

export type Needs = { energy: number; hunger: number; company: number; restlessness: number };
/** need-anchor/1 (#2296): `needs` and `lastTick` are the anchor's values and tick, and `anchor` holds each need's rate per
 *  day and the day length. A need's value at tick t is clamp(value + rate × (t − tick) / day), read with `needsAt`. Before
 *  need-anchor/1 a life has no `anchor`, and `advanceNeeds` adds a step to `needs` every tick (the old reader). */
export type NeedAnchor = { rate: Needs; day: number };
export type Life = { needs: Needs; journal: string; acts: string[]; lastTick: number; reflectedDay: number; anchor?: NeedAnchor };
/** The accelerated world day (one per real hour at 20 ticks/s): every world's day before #1649, now the dev-only
 *  accelerated clock and the fallback where no clock runs. A real-time world's day is 1,728,000 ticks (server real-clock.ts). */
export const DAY_TICKS = 72000;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
export function newLife(tick: number): Life {
  return { needs: { energy: 80, hunger: 20, company: 35, restlessness: 20 }, journal: 'I am new here. I want to learn the place and find what suits me.', acts: [], lastTick: tick, reflectedDay: -1 };
}
/** Each need's rate per world day from the enacted body state. `dayTicks` is the world clock's day (#1649: a real-time
 *  world's needs move over a real day); DAY_TICKS where no clock runs. */
export function needRates(activity: string, companyNear: boolean, nourished=false, floater=false): Needs {
  const asleep = /sleep/.test(activity), resting = /rest|sit/.test(activity), eating = /eat/.test(activity);
  const social = companyNear && (/talk|converse|listen|warm|gather|watch/.test(activity) || (floater && resting));
  const occupied = !/idle|stand|wait|rest|sleep/.test(activity);
  return { energy: asleep ? 360 : resting ? (floater?360:50) : occupied ? -105 : -65, hunger: eating ? -26000 : nourished ? -4200 : asleep ? 35 : 70,
    company: social ? -2200 : 75, restlessness: occupied ? -220 : asleep ? -50 : 95 };
}
/** Slow needs depend on enacted body state and elapsed world days, never wall time. The old reader: one step every tick,
 *  kept for histories from before need-anchor/1. */
export function advanceNeeds(life: Life, tick: number, activity: string, companyNear: boolean, nourished=false, floater=false, dayTicks=DAY_TICKS): void {
  const d = (tick - life.lastTick) / dayTicks; life.lastTick = tick;
  const n = life.needs, r = needRates(activity, companyNear, nourished, floater);
  n.energy = clamp(n.energy + d * r.energy);
  n.hunger = clamp(n.hunger + d * r.hunger);
  n.company = clamp(n.company + d * r.company);
  n.restlessness = clamp(n.restlessness + d * r.restlessness);
}
const KEYS = ['energy', 'hunger', 'company', 'restlessness'] as const;
/** A life's needs at `tick`, one expression from its anchor (need-anchor/1); a life without an anchor holds them as they are. */
export function needsAt(life: Life, tick: number): Needs {
  const a = life.anchor; if (!a) return life.needs;
  const n = life.needs, t = tick - life.lastTick;
  return { energy: clamp(n.energy + a.rate.energy * t / a.day), hunger: clamp(n.hunger + a.rate.hunger * t / a.day),
    company: clamp(n.company + a.rate.company * t / a.day), restlessness: clamp(n.restlessness + a.rate.restlessness * t / a.day) };
}
/** need-anchor/1, once a tick: the rates the body state gives at `tick` hold from the tick before (as the old reader's step
 *  covered it; a life adopting the form takes its first rates from its last step). The anchor is rewritten only when a rate or the day length changes; otherwise nothing is written. */
export function advanceNeedAnchor(life: Life, tick: number, rate: Needs, day=DAY_TICKS): void {
  const a = life.anchor;
  if (a && a.day === day && KEYS.every((k) => a.rate[k] === rate[k])) return;
  const from = a ? Math.max(life.lastTick, tick - 1) : life.lastTick;   // adopting: the first rates hold from the last step
  life.needs = needsAt(life, from); life.lastTick = from; life.anchor = { rate, day };
}
export function clockAt(tick: number, origin: number, dayTicks = DAY_TICKS) {
  const elapsed = Math.max(0, tick - origin), day = Math.floor(elapsed / dayTicks), phase = (elapsed % dayTicks) / dayTicks;
  const datetime = new Date(Date.UTC(2026, 9, 3, 6) + elapsed / dayTicks * 86400_000).toISOString();
  return { day, phase, hour: Number(datetime.slice(11, 13)), minute: Number(datetime.slice(14, 16)), datetime };
}
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
/** Same needs/journal chooser is the fake mind and the fallback after provider/budget failure. */
export function livingChoice(c: MidContext, seed: string): MidDecision {
  const rng = seedRng(seed), n = c.soul.needs;
  if (!n) throw new Error('living chooser needs a living Soul');
  const nature = words(`${c.soul.about} ${c.soul.journal ?? ''} ${(c.soul.mandate??[]).map(r=>r.words).join(' ')}`), recent = c.soul.recent;
  const scored = c.options.map(o => {
    const text = `${o.template} ${o.label} ${o.goodWhen ?? ''}`.toLowerCase();
    let score = 1 + nextFloat(rng) * 3;
    for (const w of words(text)) if (nature.has(w)) score += 1.2;
    if (/sleep|rest/.test(text)) score += (100 - n.energy) / 10;
    if (/eat|meal|supper|food|cook|finish the bowl|bask|recharge/.test(text)) score += n.hunger / 10 + Math.max(0, n.hunger - 65) * 1.5;
    if (/join|talk|chat|host|music/.test(text)) score += n.company / 12;
    if (/join.*supper|share a meal/.test(text)) score += n.company / 5;
    if (/walk|glide|wander|draw|garden|build|work|chess|read/.test(text)) score += n.restlessness / 16;
    if (/sleep/.test(text) && n.energy > 60) score -= 8;
    if (/^return (bowl|spoon)/.test(text)) score += 10;
    if (n.energy < 15 && /sleep/.test(text)) score += 40;
    if (o.template === 'wait') score -= 5;
    if (recent.some(a => a.startsWith(o.template))) score -= 5;
    if (o.servesIntent) score += 6;
    return { o, score: Math.max(0.1, score) };
  });
  const total = scored.reduce((s, o) => s + o.score, 0); let draw = nextFloat(rng) * total;
  const pick = scored.find(x => (draw -= x.score) <= 0)?.o ?? scored[0]?.o;
  const option = c.running && !c.soul.intentIsNew ? 'continue' : pick?.id ?? 'continue';
  return { option, how: 'fallback', pool: scored.map(x => x.o.id), probabilities: Object.fromEntries(scored.map(x => [x.o.id, x.score / total])), topP: 0, keepGoing: null, mood: n.energy < 20 ? 'weary' : n.company > 65 ? 'lonely' : 'content', reevalSeconds: 120, sociable: n.company / 100, seed };
}
/** Bounded first-person notes when the reflection call cannot run. No program or timetable. */
export function reflectInCode(name: string, life: Life, unfinished: string[], tick = life.lastTick): string {
  const needs = needsAt(life, tick);
  const counts = new Map<string, number>(); for (const a of life.acts) counts.set(a, (counts.get(a) ?? 0) + 1);
  const often = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
  return `Today I spent time on ${often.length ? often.join(', then ') : 'watching the place'}. ${unfinished.length ? `I still want to ${unfinished.slice(0, 3).join(' and ')}.` : 'I have no unfinished promise.'} ${needs.company > 60 ? 'I would like more company tomorrow.' : needs.energy < 30 ? 'I want to leave room for rest tomorrow.' : `I am finding what suits me here, as ${name}.`}`.slice(0, 1200);
}
