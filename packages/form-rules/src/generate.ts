// Generated cases for comparing builds (SA-F2 A2): random states for every form of the given kinds,
// from a seeded whole-number generator, so the same seed gives the same cases everywhere.
// A generated case has no expected verdict; two builds must agree on it. Hand-written cases in
// ../cases/ carry the expected verdicts.

import type { Entry, Input, Node } from './rules.ts';

export function generator(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (lo: number, hi: number) => lo + (next() % (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[next() % list.length];
  return { int, pick, chance: (pct: number) => next() % 100 < pct };
}

const AUDIENCES = ['public', 'holder', 'owner', 'members', 'creator'] as const;

/** `count` inputs over every form of `kinds`, without the kinds themselves (add them to decide). */
export function generate(kinds: Record<string, Entry>, count: number, seed: number): Omit<Input, 'kinds'>[] {
  const g = generator(seed);
  const pairs: [string, string][] = [];
  for (const kind of Object.keys(kinds).sort()) for (const form of Object.keys(kinds[kind].forms ?? {}).sort()) pairs.push([kind, form]);
  const seatKinds = Object.keys(kinds).sort().filter((k) => Object.keys(kinds[k].slots ?? {}).length > 0);
  const out: Omit<Input, 'kinds'>[] = [];
  for (let c = 0; c < count; c++) {
    const [kind, formName] = g.pick(pairs);
    const entry = kinds[kind];
    const form = entry.forms![formName];
    const nodes: Record<string, Node> = {};
    const self: Node = { kind, fields: {}, links: {}, slots: {} };
    for (const [name, def] of Object.entries(entry.state ?? {}) as [string, Record<string, unknown>][]) {
      if (!g.chance(80)) continue;
      if (def.type === 'bool') self.fields![name] = g.chance(50);
      else if (def.type === 'enum') self.fields![name] = g.pick(def.values as string[]);
      else if (def.type === 'int' || def.type === 'duration') self.fields![name] = g.chance(3) ? 0.5 : g.int(0, 2000);
      else if (def.type === 'timed') self.fields![name] = timedValue(g);
      else self.fields![name] = g.chance(50) ? null : 't_words';
    }
    for (const name of Object.keys(entry.links ?? {})) {
      const n = g.int(0, 2);
      self.links![name] = Array.from({ length: n }, (_, i) => `b${i + 2}`);
    }
    for (const [name, def] of Object.entries(entry.slots ?? {})) self.slots![name] = Array.from({ length: g.int(0, def.most) }, (_, i) => `b${i + 5}`);
    nodes.n1 = self;
    const seatKind = seatKinds.length ? g.pick(seatKinds) : null;
    if (seatKind) {
      const slots: Record<string, unknown[]> = {};
      for (const [name, def] of Object.entries(kinds[seatKind].slots ?? {})) slots[name] = Array.from({ length: g.int(0, def.most) }, (_, i) => `b${i + 7}`);
      nodes.p1 = { kind: seatKind, slots };
    }
    nodes.c1 = { kind: g.pick(['eden:cup', 'test:battery', 'eden:kettle']) };
    const hands: Record<string, string | null> = {};
    for (const name of ['left', 'right'].slice(0, g.int(0, 2))) hands[name] = g.pick([null, 'n1', 'c1']);
    const actor: Node = { hands };
    if (g.chance(95)) actor.effector_mm = [g.int(-1500, 1500), g.int(-1500, 1500), g.int(-1500, 1500)];
    nodes.b1 = actor;
    const moves: Record<string, { reach_mm: number }> = {};
    for (const step of form.steps ?? []) if (step.move && g.chance(95)) moves[step.move] = { reach_mm: g.int(0, 2000) };
    const args: Record<string, unknown> = {};
    for (const [name, def] of Object.entries((form as { takes?: Record<string, { type: string; select?: { in?: string } }> }).takes ?? {})) {
      if (g.chance(5)) continue;
      if (def.type === 'slot') {
        const inParent = def.select?.in === 'parent';
        const holder = inParent ? nodes.p1 : self;
        const names = [...Object.keys(holder ? kinds[holder.kind!].slots ?? {} : {}), 'nowhere'];
        const slot = g.pick(names);
        args[name] = inParent ? { node: 'p1', slot } : slot;
      } else if (def.type === 'part') args[name] = g.pick([...Object.keys(entry.points ?? {}), 'nowhere']);
      else if (def.type === 'thing') args[name] = 'c1';
      else if (def.type === 'text') args[name] = 't_words';
      else args[name] = g.int(0, 10);
    }
    const sees = g.chance(30) ? 'all' : AUDIENCES.filter((a) => a === 'public' || g.chance(30));
    const now_us = g.chance(95) ? g.int(0, 400000000) : undefined;
    out.push({ act: { this: 'n1', form: formName, args }, state: { actor: 'b1', nodes, moves, now_us }, asker: { sees } });
  }
  return out;
}

const timedValue = (g: ReturnType<typeof generator>) => ({ value: g.int(0, 120000), per_s: g.int(-2000, 2000), set_us: g.int(0, 200000000) });

export type TimedInput = { def: { min?: number; max?: number }; stored: unknown; at_us: number; level: { at_least: number } | { at_most: number } };

/** `count` timed values with a time and a level, from a seeded generator (SA-F5a): for comparing builds. */
export function generateTimed(count: number, seed: number): TimedInput[] {
  const g = generator(seed);
  const out: TimedInput[] = [];
  for (let c = 0; c < count; c++) {
    const def: TimedInput['def'] = {};
    if (g.chance(80)) def.min = g.int(0, 30000);
    if (g.chance(80)) def.max = g.int(60000, 110000);
    const stored = timedValue(g);
    const level = g.chance(50) ? { at_least: g.int(0, 120000) } : { at_most: g.int(0, 120000) };
    out.push({ def, stored, at_us: stored.set_us + g.int(g.chance(2) ? -10 : 0, 400000000), level });
  }
  return out;
}
