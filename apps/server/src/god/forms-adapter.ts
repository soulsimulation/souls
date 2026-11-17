// Adapter for today's engine (Soul Actions SA-F3a, #2928): a form of an entry's thing, loaded by tools/entry/load.mjs
// (SA-F3d), carried out with the motions and waits today's engine already has. Thrown away at the cut-over (Engine v2
// F1 #2766, F2 #2767, F3 #2768).
//
// - Offers: each form of the entry that anyone may start by an act becomes an action of the thing's def (`formActions`,
//   read by actuators.ts `actionsOf`). A form is not offered when a step or an effect needs what this adapter does not
//   map; `unmapped` names why.
// - Steps: `walk_to` a point → mars:walk_to; a `move` (press, slide) at a point → a walk to the entry's nearest stand
//   point, then mars:hand_actuator_v1 at the point (a slide is pressed: today's slide needs a direction the entry does
//   not give, so the motion is cruder); `wait` → a standing pose of that length. Points are the entry's, in the thing's
//   frame; where none has room to stand, today's approach (the nearest clear ground) is used.
// - Effects: nothing changes when the act is accepted. When its programme ends (the ledger's actOutcome), the form is
//   asked again with @souls/form-rules `effects()` as the world sees it now; if a need no longer holds, the receipt fails
//   with the reason and nothing is applied. Otherwise its `set` changes are committed once, as one engine edit.
// - Amounts (SA-F4a, #2929): a `transfer` is two `set`s whose `by`s sum to zero, on this thing and an argument; every
//   `set` of the result, on any thing it names, goes into that one edit, after @souls/form-rules `apply` has checked it
//   (whole numbers, amounts that balance), so both things change or neither. An argument that is a thing chosen by a
//   select (`kind`, nearest to the actor) is chosen here, again at the end; the actor's hand is the god thing it holds.
//   A move toward an argument with no point (`hold_under`) is a walk to clear ground by it and a short stand there.
//   The kinds are read from content/kinds and from the rules' own test kinds (the entry format has no amount yet).
// - Not here: no reservation (two Souls may both set off; the second fails at the end). A timer (a due list),
//   reparent, create and remove are new engine only or later tasks; a link has no field in today's def. Interruption
//   and restart are today's: the receipt fails and nothing is applied.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { opSchema, type Op, type StoredDef, type WorldModel } from '@souls/world-compiler';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';
import { apply, effects, type Change } from '../../../../packages/form-rules/src/effects.ts';
import { heldGodThing } from './held.ts';
import type { Entry, Form } from '../../../../packages/form-rules/src/rules.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Step = { verb: string; params: Record<string, unknown> };
type Refusal = { code: string; reason: string };
type Action = StoredDef['actions'][number];

const ROOT = resolve(import.meta.dirname, '../../../..');
const KINDS_DIRS = [join(ROOT, 'content/kinds'), join(ROOT, 'packages/form-rules/cases/kinds')], MOVES_DIR = join(ROOT, 'content/moves');
/** Moves today's hand can make at a point (a slide is pressed: see the header). */
const HAND_MOVES = new Set(['press', 'slide']);
/** Effects that become changes today's store holds. */
const KEPT = new Set(['set', 'transfer']);
/** Who may start a form here: anyone, or its holder (the rules' held_by_actor need decides who holds it). */
const WHO = new Set([undefined, 'anyone', 'holder']);
type Takes = Record<string, { type?: string; select?: { of?: string; kind?: string; order?: string; rank?: number } }>;
const argName = (v: unknown) => (v && typeof v === 'object' && 'arg' in (v as object) ? String((v as { arg: unknown }).arg) : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function jsonFiles(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? jsonFiles(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : []); } catch { return []; }
}
let kindsCache: Record<string, Entry> | null = null, movesCache: Record<string, { reach_mm: number }> | null = null;
const missed = new Set<string>();
/** The published entries by kind, read once (a kind not found is looked for again once, then not until a restart). */
function kinds(kind?: string): Record<string, Entry> {
  if (!kindsCache || (kind && !kindsCache[kind] && !missed.has(kind))) {
    if (kindsCache && kind) missed.add(kind);
    kindsCache = {};
    for (const f of KINDS_DIRS.flatMap(jsonFiles)) { try { const e = JSON.parse(readFileSync(f, 'utf8')); if (e?.format === 'souls-entry/1') kindsCache[e.kind] = e; } catch { /* a broken file is check.mjs's to report */ } }
  }
  return kindsCache;
}
function moves(): Record<string, { reach_mm: number }> {
  if (!movesCache) {
    movesCache = {};
    for (const f of jsonFiles(MOVES_DIR)) { try { const m = JSON.parse(readFileSync(f, 'utf8')); if (m?.format === 'souls-move/1') movesCache[m.move] = { reach_mm: m.reach_mm }; } catch { /* move.mjs reports it */ } }
  }
  return movesCache;
}

/** The entry a def was loaded from (load.mjs: tag `entry`, param `entry` = `<kind>@<hash>`), or null. */
export function entryOf(def: StoredDef | undefined): Entry | null {
  if (!def?.tags?.includes('entry')) return null;
  const ref = (def.params as Record<string, { default?: unknown }> | undefined)?.entry?.default;
  if (typeof ref !== 'string' || !ref.includes(':')) return null;
  const kind = ref.split('@')[0];
  return kinds(kind)[kind] ?? null;
}

/** Why this adapter cannot carry a form out on today's engine, or null when it can. */
export function unmapped(form: Form & { takes?: unknown }): string | null {
  if (form.starts !== 'act' || !WHO.has(form.who as string)) return 'not started by anyone\'s act';
  // an argument is chosen here only when it is a thing picked by its select, the nearest first (SA-F4a)
  for (const [, a] of Object.entries((form.takes ?? {}) as Takes)) if (a?.type !== 'thing' || !a.select || (a.select.order ?? 'nearest') !== 'nearest' || (a.select.rank ?? 1) !== 1) return 'an argument chosen otherwise than the nearest thing: a later task';
  for (const s of form.steps ?? []) {
    const toward = argName((s as { toward?: unknown }).toward);
    if (s.step === 'move' && s.at === undefined && toward && (form.takes as Takes | undefined)?.[toward]) continue;   // walk by it, stand
    if (s.step === 'move' && !HAND_MOVES.has(String(s.move))) return `the move ${s.move}: a later task`;
    if (s.step === 'move' && typeof s.at !== 'string') return 'a move at an argument: a later task';
    if (s.step === 'walk_to' && typeof (s as { point?: unknown } & typeof s).point !== 'string') return 'a walk to an argument: a later task';
    if (!['move', 'walk_to', 'wait'].includes(s.step)) return `the step ${s.step}: take, put, sit and rise are later tasks (SA-F4)`;
  }
  for (const e of form.effects ?? []) {
    if (e.change === 'timer') continue;   // new engine only (a due list): listed, not run
    if (!KEPT.has(e.change)) return `the effect ${e.change}: ${e.change === 'link' || e.change === 'unlink' ? 'a link has no field in today\'s def' : 'new engine only or a later task'}`;
  }
  return null;
}

/** The actions an entry thing's def is offered (actuators.ts `actionsOf`): one per form this adapter can carry out. */
export function formActions(def: StoredDef): Action[] {
  const entry = entryOf(def); if (!entry) return [];
  return Object.entries(entry.forms ?? {}).filter(([, f]) => !unmapped(f)).map(([name]) => (
    { name, label: name.replace(/_/g, ' '), roles: 'anyone', reach: 'anywhere', params: {}, when: [], then: [] }
  )) as unknown as Action[];
}

export type FormsHost = {
  model: WorldModel;
  engine: { world: { entities: Record<string, any>; tick: number }; standableNearV1?(at: Vec2, level?: number, except?: string, minClear?: number, maxRing?: number): Vec2 | null; clearanceAtV1?(x: number, z: number, level?: number): number };
  levelAt(x: number, z: number, y: number): number;
  commit(ops: Op[], note: string): { accepted: boolean };
  log(m: string): void;
};

export function createFormsAdapter(h: FormsHost) {
  const M = () => h.model;
  const thing = (id: string) => { const e = M().entities.get(id), def = e && M().resolvedDef(e.def), entry = entryOf(def); return e && def && entry ? { e, def, entry } : null; };
  const nameOf = (id: string) => { const e = M().entities.get(id); return e?.name ? M().pathOf(id) : 'it'; };
  /** god local → world (mending.ts, the contact actuator's convention); entry points are whole millimetres. */
  const toWorld = (wp: { x: number; y: number; z: number; yaw: number; s: number }, mm: number[]): Vec3 => {
    const l = [mm[0] / 1000, mm[1] / 1000, mm[2] / 1000], c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
    return [wp.x + (l[0] * c + l[2] * s) * wp.s, wp.y + l[1] * wp.s, wp.z + (-l[0] * s + l[2] * c) * wp.s];
  };
  /** What the form needs and does now, asked of @souls/form-rules as the world: the thing's fields as today's store holds
   *  them, a body with free hands (holding is a later task) and its effector in the thing's frame (whole millimetres). */
  function ask(t: NonNullable<ReturnType<typeof thing>>, id: string, action: string, bodyId: string, effector: number[], receipt: string): any {
    const args = argsOf(t, id, action, bodyId), kinds: Record<string, Entry> = {}, nodes: Record<string, any> = {};
    for (const n of new Set([id, ...Object.values(args)])) { const x = n === id ? t : thing(n)!; kinds[x.entry.kind] = x.entry; nodes[n] = { kind: x.entry.kind, fields: fieldsOf(x) }; }
    const all = h.engine.world.entities, gripped = all[bodyId]?.human?.grip?.entity, held = heldGodThing(all, bodyId)?.id ?? (typeof gripped === 'string' ? gripped : null);
    nodes[bodyId] = { hands: { left: null, right: held }, effector_mm: effector };
    const input = { kinds, act: { this: id, form: action, args }, state: { actor: bodyId, nodes, moves: moves() } };
    return Object.assign(effects({ ...input, receipt }), { input });
  }
  const fieldsOf = (x: NonNullable<ReturnType<typeof thing>>) => { const f: Record<string, unknown> = {}; for (const [k, d] of Object.entries(x.entry.state ?? {})) f[k] = x.e.state?.[k] ?? d.default; return f; };
  /** A form's arguments, each the entry thing nearest the actor that its select admits (a kind, when it names one). */
  function argsOf(t: NonNullable<ReturnType<typeof thing>>, id: string, action: string, bodyId: string): Record<string, string> {
    const takes = (t.entry.forms?.[action] as { takes?: Takes } | undefined)?.takes ?? {}, out: Record<string, string> = {};
    const p = h.engine.world.entities[bodyId]?.pose?.p as Vec3 | undefined;
    for (const [name, a] of Object.entries(takes)) {
      let best = Infinity;
      for (const [eid, e] of M().entities) {
        if (eid === id || Object.values(out).includes(eid)) continue;
        const x = thing(eid); if (!x || (a.select?.kind && x.entry.kind !== a.select.kind)) continue;
        const wp = M().worldPose(e), d = p ? Math.hypot(wp.x - p[0], wp.z - p[2]) : 0;
        if (d < best) { best = d; out[name] = eid; }
      }
    }
    return out;
  }
  const clear = (p: Vec3, level: number) => (h.engine.clearanceAtV1 ? h.engine.clearanceAtV1(p[0], p[2], level) : Infinity) >= HUMAN_RADIUS + 0.02;
  /** The steps of a form for this body, or a refusal; null when this is not an entry thing's form. */
  function plan(soul: { entityId: string }, id: string, action: string): { steps: Step[]; summary: string } | Refusal | null {
    const t = thing(id), form = t?.entry.forms?.[action]; if (!t || !form || unmapped(form)) return null;
    const body = h.engine.world.entities[soul.entityId]; if (!body?.pose?.p) return null;
    // the needs as they stand now, with the hand where the form's move puts it (its walk meets within_reach)
    const mv = (form.steps ?? []).find((s) => s.step === 'move'), now = ask(t, id, action, soul.entityId, (mv && t.entry.points?.[mv.at as string]?.at_mm) ?? [0, 0, 0], 'plan');
    if (now.verdict !== 'yes') return { code: `form.${now.reason ?? 'refused'}`, reason: `${refusalText(nameOf(id), now)}.` };
    const wp = M().worldPose(t.e), level = h.levelAt(wp.x, wp.z, wp.y), points = t.entry.points ?? {};
    const stands = Object.entries(points).filter(([, p]) => (p as { role?: string }).role === 'stand').map(([, p]) => toWorld(wp, p.at_mm));
    const steps: Step[] = [{ verb: 'stand', params: {} }];
    let at: Vec2 = [body.pose.p[0], body.pose.p[2]];
    const walk = (to: Vec2, face: Vec3) => {
      if (Math.hypot(to[0] - at[0], to[1] - at[1]) > 0.1) steps.push({ verb: 'mars:walk_to', params: { x: r3(to[0]), z: r3(to[1]), level, face: r3(Math.atan2(face[2] - to[1], face[0] - to[0])) } });
      at = to;
    };
    for (const s of form.steps ?? []) {
      if (s.step === 'walk_to') { const p = points[String((s as { point?: string } & typeof s).point)]; if (!p) return { code: 'form.no-point', reason: `${nameOf(id)} has no point ${(s as { point?: string } & typeof s).point}.` }; const w = toWorld(wp, p.at_mm); walk([w[0], w[2]], toWorld(wp, [0, 0, 0])); continue; }
      const toward = argName((s as { toward?: unknown }).toward);
      if (s.step === 'move' && s.at === undefined && toward) {
        // a move toward an argument with no point (hold under a tap): walk to clear ground by it and stand there a moment
        const other = argsOf(t, id, action, soul.entityId)[toward], oe = other && M().entities.get(other);
        if (!oe) return { code: 'form.argument_missing', reason: `There is nothing near to ${action.replace(/_/g, ' ')} ${nameOf(id)} from.` };
        const ow = M().worldPose(oe), by = h.engine.standableNearV1?.([ow.x, ow.z], level, soul.entityId, 0.4, 16) ?? null;
        if (!by) return { code: 'form.no-room', reason: `There is no room to stand by ${nameOf(other)}.` };
        walk(by, [ow.x, ow.y, ow.z]); steps.push({ verb: 'mars:pose_v1', params: { activity: 'listen', seconds: 2 } }); continue;
      }
      if (s.step === 'wait') { steps.push({ verb: 'mars:pose_v1', params: { activity: 'listen', seconds: Math.min(3600, Math.max(0.5, Number((s as { us?: number }).us ?? 0) / 1e6)) } }); continue; }
      const p = points[s.at as string]; if (!p) return { code: 'form.no-point', reason: `${nameOf(id)} has no point ${s.at}.` };
      const hand = toWorld(wp, p.at_mm);
      // where to stand: the entry's stand point nearest the hand's point; else today's approach, the nearest clear ground
      let stand: Vec2 | null = null, best = Infinity;
      // (only a stand point with room to stand: mending.ts's clearance test)
      for (const q of stands) { const d = Math.hypot(q[0] - hand[0], q[2] - hand[2]); if (d < best && clear(q, level)) { best = d; stand = [q[0], q[2]]; } }
      stand ??= h.engine.standableNearV1?.([hand[0], hand[2]], level, soul.entityId, 0.4, 16) ?? null;
      if (!stand) return { code: 'form.no-room', reason: `There is no room to stand and reach ${nameOf(id)}.` };
      walk(stand, hand);
      steps.push({ verb: 'mars:let_go_v1', params: {} }, { verb: 'mars:hand_actuator_v1', params: { target: id, at: hand.map(r3) } });
    }
    return { steps, summary: `${action.replace(/_/g, ' ')} ${nameOf(id)}` };
  }
  /** The ledger's actOutcome: when a form's programme ends, ask its needs again and apply its changes once. Null for
   *  anything that is not an entry thing's form, and for a programme that did not finish (today's failure stands). */
  function outcome(capability: string, bodyId: string, finished: boolean): 'done' | Refusal | null {
    const m = /^object:(.+):([a-z][a-z0-9_]*)$/.exec(capability); if (!m) return null;
    const [, id, action] = m, t = thing(id), form = t?.entry.forms?.[action];
    if (!t || !form || unmapped(form) || !finished) return null;
    const body = h.engine.world.entities[bodyId]; if (!body?.pose?.p) return { code: 'body.unavailable', reason: 'Your body is unavailable; nothing changed.' };
    // The hand's reach: today's press completes only once the hand has touched the point, so a finished programme puts the
    // effector at the form's point when the body still stands within the move's reach of it; else the body's own place.
    const wp = M().worldPose(t.e), mv = (form.steps ?? []).find((s) => s.step === 'move'), point = mv && t.entry.points?.[mv.at as string];
    let effector: number[] = [0, 0, 0];
    if (point) {
      const hand = toWorld(wp, point.at_mm), reach = (moves()[String(mv!.move)]?.reach_mm ?? 600) / 1000;
      const near = Math.hypot(body.pose.p[0] - hand[0], body.pose.p[2] - hand[2]) <= reach + 0.6;   // a stand point is up to an arm and a body away
      if (near) effector = point.at_mm;
      else { const dx = body.pose.p[0] - wp.x, dz = body.pose.p[2] - wp.z, c = Math.cos(wp.yaw), s = Math.sin(wp.yaw); effector = [Math.round((dx * c - dz * s) * 1000), 0, Math.round((dx * s + dz * c) * 1000)]; }
    }
    const r = ask(t, id, action, bodyId, effector, `${capability}@${h.engine.world.tick}`);
    if (r.verdict !== 'yes') return { code: `form.${r.reason ?? 'refused'}`, reason: `${refusalText(nameOf(id), r)}; nothing changed.` };
    // every set, on any thing it names, checked by the rules' own apply (whole, balanced) and committed as one edit
    const checked = apply(r.input.state, r);
    if (!checked.ok) return { code: `form.${checked.reason}`, reason: `${nameOf(id)}: the change could not be applied (${checked.reason.replace(/_/g, ' ')}); nothing changed.` };
    const patches = new Map<string, Record<string, unknown>>();
    for (const c of r.changes as Change[]) {
      if (c.change !== 'set') continue;
      const x = c.node === id ? t : thing(c.node); if (!x) return { code: 'object.refused', reason: `${nameOf(c.node)} is gone; nothing changed.` };
      if (fieldsOf(x)[c.field] === (c as { to?: unknown }).to) continue;   // an amount of 0 (a full kettle): no edit for it
      const def = x.def;
      patches.set(c.node, { ...patches.get(c.node), [c.field]: valueFor(def, c.field, (c as { to?: unknown }).to) });
    }
    const ops = [...patches].map(([node, state]) => opSchema.parse({ op: 'set', id: node, state }));
    if (ops.length && !h.commit(ops, `${bodyId} ${action} ${id}`).accepted)
      return { code: 'object.refused', reason: `The world refused that change to ${nameOf(id)}.` };
    if (r.timers?.length) h.log(`forms: ${action} on ${id}: ${r.timers.length} timer(s) not run (new engine only)`);
    return 'done';
  }
  /** Is this capability a form of an entry thing (so tea.ts does not watch the body for it)? */
  const owns = (capability: string) => { const m = /^object:(.+):([a-z][a-z0-9_]*)$/.exec(capability); return !!m && !!thing(m[1])?.entry.forms?.[m[2]]; };
  return { plan, outcome, owns };
}
export type FormsAdapter = ReturnType<typeof createFormsAdapter>;

/** A form-rules value as today's def holds it: a flag 0/1 as a bool, a text reference as its key. */
function valueFor(def: StoredDef, field: string, v: unknown): unknown {
  const type = (def.state as Record<string, { type?: string }>)[field]?.type;
  if (type === 'bool') return v === true || v === 1;
  if (v && typeof v === 'object' && 'text' in (v as object)) return (v as { text: unknown }).text;
  return v ?? null;
}
/** The reason a receipt fails with, from a "no" or "unknown" of the rules. */
function refusalText(name: string, r: any): string {
  const d = r.detail ?? {};
  if (r.reason === 'field_differs') return `${name}: ${d.field} is ${JSON.stringify(d.found)}, and this needs it ${'is' in (d.wanted ?? {}) ? JSON.stringify(d.wanted.is) : `not ${JSON.stringify(d.wanted?.not)}`}`;
  if (r.reason === 'out_of_reach') return `${name}: the ${d.point} was out of reach when the motion ended`;
  if (r.verdict === 'unknown') return `${name}: what this needs could not be read`;
  return `${name}: ${String(r.reason ?? 'refused').replace(/_/g, ' ')}${d.what ? ` (${d.what})` : ''}`;
}
