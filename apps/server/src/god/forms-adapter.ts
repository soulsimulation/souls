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
//   The kinds are read from content/kinds, then the rules' own test kinds (the entry format has no amount yet); a
//   published kind wins. The argument is chosen again at the end (no reservation): the nearest one then is debited.
// - Take and put (SA-F4b, #2930): a change of parent is today's item verbs. A `take` step becomes mars:take_item of
//   the thing the form's reparent moves, into the hand the rules chose; a `put` step becomes mars:put_item onto a free
//   place on top of the anchor (placement `on`), the place nearest the body. The stand point is the entry's (the
//   thing's for a take, the anchor's for a put) where one has room; else today's own approach. The body's forms that
//   change a thing argument's parent (its `put`) are offered on each entry thing, with the thing as that argument.
//   Such a form is decided when it starts (the motion itself makes the change, so its needs no longer hold at the end:
//   a hand that was free now holds the cup); at the end the adapter checks that the thing is where the rules put it.
// - Not here: no reservation (two Souls may both set off; the second fails at the end). A timer (a due list), create,
//   remove, a put into a named slot and other placement words are new engine only or later tasks; a link has no field
//   in today's def. Interruption and restart are today's: the receipt fails and nothing is applied.
// - Pour and sip (SA-F4d, #2931): the moves `pour` and `consume` of a held thing are today's two verbs, reached by
//   parameters for any held thing, not by code for cans and cups. A pour toward an argument is mars:watering_can_v1
//   (stage pour, the right hand: today's pour is right-handed) from the entry's stand point by the target, the grip
//   placed so the entry's outlet point is over the target, for the move's pour time, with the level after from the
//   rules' amount. A consume is mars:cup_v1 (stage drink, one sip), the level before and the sip from the rules'
//   amount. Today's drink draws a mug's pose for any shape. The amounts are applied at the end, as any `set`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { opSchema, type Op, type StoredDef, type WorldModel } from '@souls/world-compiler';
import { HUMAN_RADIUS } from '../../../../mars/viewer/engine/world/catalog.ts';
import { apply, effects, type Change } from '../../../../packages/form-rules/src/effects.ts';
import { surfaceSlotsOf, slotOccupant } from '../../../../mars/viewer/engine/items/model.ts';
import { canPoint, TILT, TILT_MORE } from '../../../../mars/viewer/engine/items/watering.ts';
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
/** Moves of a held thing that today's verbs make by parameters (SA-F4d). */
const HELD_MOVES = new Set(['pour', 'consume']);
/** A pour (tea.ts's numbers): the pouring hand this far right of the body's axis; the outlet this far over the target's
 *  top (m). */
const POUR_HAND_RIGHT = 0.17, OUTLET_DROP = 0.07;
/** The stream runs from this far (rad) before the full tilt and fully at it, so it does not start at a can's shallow
 *  angle and overshoot (tea.ts passes its kettle's window for the same reason). */
const FLOW_LEAD = 7 * Math.PI / 180;
/** Effects that become changes today's store holds (a reparent is made by today's take and put, SA-F4b). */
const KEPT = new Set(['set', 'transfer', 'reparent']);
/** The body's kind (lane A's entry, SA-G3): its forms that move a thing argument are offered on that thing. */
const BODY_KIND = 'eden:humanoid';
/** The node the rules see as the actor's place (here). */
const HERE = '@here';
/** Who may start a form here: anyone, or its holder (the rules' held_by_actor need decides who holds it). */
const WHO = new Set([undefined, 'anyone', 'holder']);
type Takes = Record<string, { type?: string; select?: { of?: string; kind?: string; order?: string; rank?: number } }>;
/** A form offered on an entry thing: its own, or the body's with the thing as its argument `thing`. */
type FormRef = { form: Form & { takes?: Takes }; body: Entry | null };
const argName = (v: unknown) => (v && typeof v === 'object' && 'arg' in (v as object) ? String((v as { arg: unknown }).arg) : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
// entry 41's M04 finding (tea.ts): an idle gesture is let go before a hand reaches
const LET_GO: Step = { verb: 'mars:let_go_v1', params: {} };

function jsonFiles(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? jsonFiles(join(dir, e.name)) : e.name.endsWith('.json') ? [join(dir, e.name)] : []); } catch { return []; }
}
/** Why this adapter cannot carry a form out on today's engine, or null when it can. `offered` names the argument the
 *  thing it is offered on fills (the body's forms, SA-F4b). */
export function unmapped(form: Form & { takes?: unknown }, offered?: string): string | null {
  if (form.starts !== 'act' || !WHO.has(form.who as string)) return 'not started by anyone\'s act';
  // the rules do not read `who`: a holder's form is mapped only when its needs check the holding
  if (form.who === 'holder' && !(form.needs ?? []).some((n) => n.need === 'held_by_actor')) return 'a holder\'s form that does not need the holding';
  // an argument is chosen here only when it is a thing picked by its select, the nearest first (SA-F4a)
  for (const [name, a] of Object.entries((form.takes ?? {}) as Takes)) {
    if (name === offered || a?.type === 'placement') continue;   // the offered thing; a placement word (see `put`)
    const sel = a?.select as Record<string, unknown> | undefined;
    if (a?.type !== 'thing' || !sel || (sel.of ?? 'things') !== 'things' || (sel.in ?? 'here') !== 'here' || (sel.anchor ?? 'me') !== 'me' || (sel.order ?? 'nearest') !== 'nearest' || (sel.rank ?? 1) !== 1) return 'an argument chosen otherwise than the nearest thing: a later task';
  }
  const parents = (form.effects ?? []).filter((e) => e.change === 'reparent');
  for (const s of form.steps ?? []) {
    const toward = argName((s as { toward?: unknown }).toward);
    if (s.step === 'move' && s.at === undefined && toward && (form.takes as Takes | undefined)?.[toward]) continue;   // walk by it, stand
    if (s.step === 'move' && HELD_MOVES.has(String(s.move))) {
      // SA-F4d: made with this thing in hand, so the form must need the holding; a pour goes toward an argument thing
      if (!(form.needs ?? []).some((n) => n.need === 'held_by_actor' && (n as { thing?: unknown }).thing === undefined)) return `the move ${s.move} of a thing not held: a later task`;
      if (typeof s.at !== 'string') return 'a move at an argument: a later task';
      if (s.move === 'pour' && !(toward && (form.takes as Takes | undefined)?.[toward])) return 'a pour toward nothing named: a later task';
      continue;
    }
    if (s.step === 'move' && !HAND_MOVES.has(String(s.move))) return `the move ${s.move}: a later task`;
    if (s.step === 'move' && typeof s.at !== 'string') return 'a move at an argument: a later task';
    if (s.step === 'walk_to' && typeof (s as { point?: unknown } & typeof s).point !== 'string') return 'a walk to an argument: a later task';
    if (s.step === 'take' || s.step === 'put') {
      // SA-F4b: the item and where it goes come from the form's reparent; today's slots are not named as the entry's
      if ((s as { slot?: unknown }).slot !== undefined) return `a ${s.step} at a named slot: a later task`;
      const into = s.step === 'take' ? 'actor_hand' : 'here', at = (s as { place?: { at?: unknown } }).place?.at;
      if (s.step === 'put' && !argName((s as { place?: { anchor?: unknown } }).place?.anchor)) return 'a put with no anchor named: new engine only (E4)';
      if (!parents.some((e) => e.into === into)) return `a ${s.step} that does not move a thing ${s.step === 'take' ? 'into a hand' : 'down here'}: a later task`;
      if (at !== undefined && at !== 'on' && !(argName(at) && (form.takes as Takes | undefined)?.[argName(at)!]?.type === 'placement')) return `the placement ${JSON.stringify(at)}: new engine only (E4)`;
      continue;
    }
    if (!['move', 'walk_to', 'wait'].includes(s.step)) return `the step ${s.step}: sit and rise are later tasks (SA-F4)`;
  }
  if (parents.length && (form.effects ?? []).some((e) => e.change !== 'reparent' && e.change !== 'timer')) return 'a change of parent with other changes: a later task';
  if (parents.length && !(form.steps ?? []).some((s) => s.step === 'take' || s.step === 'put')) return 'a change of parent with no take or put step: a later task';
  for (const e of form.effects ?? []) {
    if (e.change === 'timer') continue;   // new engine only (a due list): listed, not run
    if (e.change === 'reparent' && (e.what === 'this' || argName(e.what)) && (e.into === 'actor_hand' || e.into === 'here')) continue;
    if (e.change === 'reparent') return 'a change of parent into a slot or of the actor: a later task';
    if (!KEPT.has(e.change)) return `the effect ${e.change}: ${e.change === 'link' || e.change === 'unlink' ? 'a link has no field in today\'s def' : 'new engine only or a later task'}`;
  }
  return null;
}

export type FormsHost = {
  model: WorldModel;
  engine: { world: { entities: Record<string, any>; tick: number }; standableNearV1?(at: Vec2, level?: number, except?: string, minClear?: number, maxRing?: number): Vec2 | null; clearanceAtV1?(x: number, z: number, level?: number): number };
  levelAt(x: number, z: number, y: number): number;
  commit(ops: Op[], note: string): { accepted: boolean };
  log(m: string): void;
};

export function createFormsAdapter(h: FormsHost) {
  // #2416 A1: the entries and moves this world has read are its own, on its adapter, never module state
  let kindsCache: Record<string, Entry> | null = null, movesCache: Record<string, { reach_mm: number; phases?: Record<string, number> }> | null = null;
  const missed = new Set<string>();
  /** The published entries by kind, read once per world (a kind not found is looked for again once, then not until a restart). */
  function kinds(kind?: string): Record<string, Entry> {
    if (!kindsCache || (kind && !kindsCache[kind] && !missed.has(kind))) {
      if (kindsCache && kind) missed.add(kind);
      kindsCache = {};
      for (const f of KINDS_DIRS.flatMap(jsonFiles)) { try { const e = JSON.parse(readFileSync(f, 'utf8')); if (e?.format === 'souls-entry/1' && !kindsCache[e.kind]) kindsCache[e.kind] = e; } catch { /* a broken file is check.mjs's to report */ } }
    }
    return kindsCache;
  }
  function moves(): Record<string, { reach_mm: number; phases?: Record<string, number> }> {
    if (!movesCache) {
      movesCache = {};
      for (const f of jsonFiles(MOVES_DIR)) { try { const m = JSON.parse(readFileSync(f, 'utf8')); if (m?.format === 'souls-move/1') movesCache[m.move] = { reach_mm: m.reach_mm, phases: m.phases }; } catch { /* move.mjs reports it */ } }
    }
    return movesCache;
  }
  /** The entry a def was loaded from (load.mjs: tag `entry`, param `entry` = `<kind>@<hash>`), or null. */
  function entryOf(def: StoredDef | undefined): Entry | null {
    if (!def?.tags?.includes('entry')) return null;
    const ref = (def.params as Record<string, { default?: unknown }> | undefined)?.entry?.default;
    if (typeof ref !== 'string' || !ref.includes(':')) return null;
    const kind = ref.split('@')[0];
    return kinds(kind)[kind] ?? null;
  }
  /** The body's forms that change the parent of a thing argument named `thing` (its `put`), mapped here (SA-F4b). */
  function bodyForms(): [string, FormRef['form']][] {
    const body = kinds(BODY_KIND)[BODY_KIND]; if (!body) return [];
    return (Object.entries(body.forms ?? {}) as [string, FormRef['form']][]).filter(([, f]) => f.takes?.thing?.type === 'thing' && (f.effects ?? []).some((e) => e.change === 'reparent' && argName(e.what) === 'thing') && !unmapped(f, 'thing'));
  }
  /** The form offered on an entry thing by this name: its own, else the body's with the thing as its argument. */
  function formOf(entry: Entry, action: string): FormRef | null {
    const own = entry.forms?.[action]; if (own) return unmapped(own) ? null : { form: own, body: null };
    const b = bodyForms().find(([n]) => n === action);
    return b ? { form: b[1], body: kinds(BODY_KIND)[BODY_KIND] } : null;
  }
  /** The actions an entry thing's def is offered (actuators.ts `actionsOf`, through the act host): one per form this
   *  adapter can carry out. */
  function actions(def: StoredDef): Action[] {
    const entry = entryOf(def); if (!entry) return [];
    const names = [...Object.entries(entry.forms ?? {}).filter(([, f]) => !unmapped(f)).map(([n]) => n), ...bodyForms().map(([n]) => n).filter((n) => !entry.forms?.[n])];
    return names.map((name) => (
      { name, label: name.replace(/_/g, ' '), roles: 'anyone', reach: 'anywhere', params: {}, when: [], then: [] }
    )) as unknown as Action[];
  }
  const M = () => h.model, all = () => h.engine.world.entities, world = () => h.engine.world as never;
  const thing = (id: string) => { const e = M().entities.get(id), def = e && M().resolvedDef(e.def), entry = entryOf(def); return e && def && entry ? { e, def, entry } : null; };
  const nameOf = (id: string) => { const e = M().entities.get(id); return e?.name ? M().pathOf(id) : 'it'; };
  /** SA-F4b: the rules' answer for a form that changes a parent. `latest`, by body: its last plan (menus plan too);
   *  `planned`, by body|capability: the plan its act started with (`begun`), checked and dropped at the end. */
  const latest = new Map<string, { capability: string; answer: any }>(), planned = new Map<string, any>();
  /** god local → world (mending.ts, the contact actuator's convention); entry points are whole millimetres. */
  const toWorld = (wp: { x: number; y: number; z: number; yaw: number; s: number }, mm: number[]): Vec3 => {
    const l = [mm[0] / 1000, mm[1] / 1000, mm[2] / 1000], c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
    return [wp.x + (l[0] * c + l[2] * s) * wp.s, wp.y + l[1] * wp.s, wp.z + (-l[0] * s + l[2] * c) * wp.s];
  };
  /** What a body's hands hold, by today's support (it names the hand): a god thing or one of today's own items, so a hand
   *  holding either is not free; a gripped thing counts as the right. */
  const handsOf = (body: string) => {
    const out: Record<string, string | null> = { left: null, right: null };
    for (const x of Object.values(all())) if (x?.support?.kind === 'in-hand' && x.support.by === body && (x.support.hand === 'left' || x.support.hand === 'right')) out[x.support.hand] = x.id;
    const gripped = all()[body]?.human?.grip?.entity;
    if (!out.right && typeof gripped === 'string' && out.left !== gripped) out.right = gripped;
    return out;
  };
  /** What the form needs and does now, asked of @souls/form-rules as the world: the thing's fields as today's store holds
   *  them, the god things the body holds, the form's argument things, its effector in the thing's frame (whole
   *  millimetres) and where each thing is: in a hand, in a place on another thing, or loose in the actor's place. */
  function ask(t: NonNullable<ReturnType<typeof thing>>, id: string, f: FormRef, action: string, bodyId: string, effector: number[], receipt: string): any {
    const args = argsOf(t, id, f, bodyId), kinds: Record<string, Entry> = {}, nodes: Record<string, any> = {};
    for (const n of new Set([id, ...Object.values(args)])) {
      const x = n === id ? t : thing(n);
      if (x) { kinds[x.entry.kind] = x.entry; nodes[n] = { kind: x.entry.kind, fields: fieldsOf(x) }; } else if (M().entities.has(n)) nodes[n] = {};
    }
    if (f.body) kinds[f.body.kind] = f.body;
    nodes[bodyId] = { ...(f.body ? { kind: f.body.kind } : {}), hands: handsOf(bodyId), effector_mm: effector };
    const keys = Object.keys(nodes), here: string[] = [bodyId];
    nodes[HERE] = { loose: here };
    for (const n of keys) {
      if (n === bodyId) continue;
      const s = all()[n]?.support;
      if (s?.kind === 'in-hand' && s.by === bodyId) continue;   // in its hands above
      if (s?.kind === 'in-hand' && typeof s.by === 'string') { nodes[s.by] ??= { hands: {} }; nodes[s.by].hands = { ...nodes[s.by].hands, [s.hand]: n }; if (!here.includes(s.by)) here.push(s.by); continue; }
      if (s?.kind === 'resting-on' && typeof s.on === 'string') {
        nodes[s.on] ??= {}; const slot = String(s.slot ?? 'top');
        nodes[s.on].slots = { ...nodes[s.on].slots, [slot]: [...(nodes[s.on].slots?.[slot] ?? []), n] };
        if (!keys.includes(s.on) && !here.includes(s.on)) here.push(s.on);
        continue;
      }
      here.push(n);
    }
    const input = { kinds, act: { this: f.body ? bodyId : id, form: action, args }, state: { actor: bodyId, nodes, moves: moves() } };
    return Object.assign(effects({ ...input, receipt }), { input });
  }
  const fieldsOf = (x: NonNullable<ReturnType<typeof thing>>) => { const f: Record<string, unknown> = {}; for (const [k, d] of Object.entries(x.entry.state ?? {})) f[k] = x.e.state?.[k] ?? d.default; return f; };
  /** Today's free places on top of a thing (not inside it, not hooks). */
  const freeTops = (eid: string) => { const w = world(); return surfaceSlotsOf(w, eid).filter((x) => !x.inside && !x.hang && !slotOccupant(w, x.owner, x.slot)); };
  /** A form's arguments: the thing it is offered on (the body's forms), `on` for a placement (today's one word), and each
   *  other the thing nearest the actor that its select admits: of its kind, or with no kind an entry thing; a put's
   *  anchor is the nearest thing, not in a hand, with a free place on top today (the word is `on`). */
  function argsOf(t: NonNullable<ReturnType<typeof thing>>, id: string, f: FormRef, bodyId: string): Record<string, string> {
    const out: Record<string, string> = f.body ? { thing: id } : {};
    const p = all()[bodyId]?.pose?.p as Vec3 | undefined;
    const anchors = new Set((f.form.steps ?? []).filter((s) => s.step === 'put').map((s) => argName((s as { place?: { anchor?: unknown } }).place?.anchor)));
    for (const [name, a] of Object.entries(f.form.takes ?? {})) {
      if (name in out) continue;
      if (a.type === 'placement') { out[name] = 'on'; continue; }
      let best = Infinity;
      for (const [eid, e] of M().entities) {
        if (eid === id || Object.values(out).includes(eid)) continue;
        const x = thing(eid);
        if (anchors.has(name) ? all()[eid]?.support?.kind === 'in-hand' || !freeTops(eid).length : a.select?.kind ? x?.entry.kind !== a.select.kind : !x) continue;
        const wp = M().worldPose(e), d = p ? Math.hypot(wp.x - p[0], wp.z - p[2]) : 0;
        if (d < best) { best = d; out[name] = eid; }
      }
    }
    return out;
  }
  const clear = (p: Vec3, level: number) => (h.engine.clearanceAtV1 ? h.engine.clearanceAtV1(p[0], p[2], level) : Infinity) >= HUMAN_RADIUS + 0.02;
  /** An entry thing's stand points, in the world. */
  const standsOf = (id: string): Vec3[] => { const x = thing(id); if (!x) return []; const wp = M().worldPose(x.e); return Object.values(x.entry.points ?? {}).filter((p) => (p as { role?: string }).role === 'stand').map((p) => toWorld(wp, p.at_mm)); };
  /** The steps of a form for this body, or a refusal; null when this is not an entry thing's form. */
  function plan(soul: { entityId: string }, id: string, action: string): { steps: Step[]; summary: string } | Refusal | null {
    const t = thing(id), f = t && formOf(t.entry, action); if (!t || !f) return null;
    latest.delete(soul.entityId);   // a refusal leaves no earlier yes for `begun` to keep
    const form = f.form, body = all()[soul.entityId]; if (!body?.pose?.p) return null;
    // the needs as they stand now, with the hand where the form's move puts it (its walk meets within_reach)
    const mv = (form.steps ?? []).find((s) => s.step === 'move'), now = ask(t, id, f, action, soul.entityId, (mv && t.entry.points?.[mv.at as string]?.at_mm) ?? [0, 0, 0], 'plan');
    if (now.verdict !== 'yes') return { code: `form.${now.reason ?? 'refused'}`, reason: `${refusalText(nameOf(id), now)}.` };
    const wp = M().worldPose(t.e), level = h.levelAt(wp.x, wp.z, wp.y), points = t.entry.points ?? {};
    const steps: Step[] = [{ verb: 'stand', params: {} }];
    let at: Vec2 = [body.pose.p[0], body.pose.p[2]];
    const walk = (to: Vec2, face: Vec3) => {
      if (Math.hypot(to[0] - at[0], to[1] - at[1]) > 0.1) steps.push({ verb: 'mars:walk_to', params: { x: r3(to[0]), z: r3(to[1]), level, face: r3(Math.atan2(face[2] - to[1], face[0] - to[0])) } });
      at = to;
    };
    /** Walk to the entry's stand point of `of` nearest `target` that has room; with none, today's item verb approaches. */
    const standBy = (of: string, target: Vec3) => {
      let stand: Vec2 | null = null, best = Infinity;
      for (const q of standsOf(of)) { const d = Math.hypot(q[0] - target[0], q[2] - target[2]); if (d < best && clear(q, level)) { best = d; stand = [q[0], q[2]]; } }
      if (stand) walk(stand, target);
      return !!stand;
    };
    for (const s of form.steps ?? []) {
      if (s.step === 'take' || s.step === 'put') {
        // SA-F4b: today's take_item / put_item of the thing the rules reparent, into the hand they chose or onto the anchor
        const c = (now.changes as Change[]).find((x) => x.change === 'reparent' && (s.step === 'take' ? 'hand' in x.to && x.to.node === soul.entityId : x.to.node === HERE)) as Extract<Change, { change: 'reparent' }> | undefined;
        const e = c && all()[c.node];
        if (!c || !e?.pose?.p) return { code: 'form.bad_input', reason: `${nameOf(id)}: nothing to ${s.step} in today's world.` };
        if (s.step === 'take') {
          if (e.support?.kind === 'in-hand') return e.support.by === soul.entityId ? { code: 'form.already_held', reason: `You already hold ${nameOf(c.node)}.` } : { code: 'form.held_by_other', reason: `${nameOf(c.node)} is in someone else's hand.` };
          standBy(c.node, e.pose.p as Vec3);
          steps.push(LET_GO, { verb: 'mars:take_item', params: { item: c.node, hand: (c.to as { hand: string }).hand } });
          continue;
        }
        const anchor = now.input.act.args?.[argName((s as { place?: { anchor?: unknown } }).place?.anchor) ?? ''];
        if (typeof anchor !== 'string') return { code: 'form.argument_missing', reason: `There is nothing near to put ${nameOf(c.node)} on.` };
        const free = freeTops(anchor).sort((a, b) => Math.hypot(a.p[0] - at[0], a.p[2] - at[1]) - Math.hypot(b.p[0] - at[0], b.p[2] - at[1]))[0];
        if (!free) return { code: 'form.no-room', reason: `There is no free place on ${nameOf(anchor)} to put ${nameOf(c.node)}.` };
        standBy(anchor, free.p);
        steps.push({ verb: 'mars:put_item', params: { item: c.node, surfaceSlot: free.id } });
        continue;
      }
      if (s.step === 'walk_to') { const p = points[String((s as { point?: string } & typeof s).point)]; if (!p) return { code: 'form.no-point', reason: `${nameOf(id)} has no point ${(s as { point?: string } & typeof s).point}.` }; const w = toWorld(wp, p.at_mm); walk([w[0], w[2]], toWorld(wp, [0, 0, 0])); continue; }
      const toward = argName((s as { toward?: unknown }).toward);
      if (s.step === 'move' && s.at === undefined && toward) {
        // a move toward an argument with no point (hold under a tap): walk to clear ground by it and stand there a moment
        const other = argsOf(t, id, f, soul.entityId)[toward], oe = other && M().entities.get(other);
        if (!oe) return { code: 'form.argument_missing', reason: `There is nothing near to ${action.replace(/_/g, ' ')} ${nameOf(id)} from.` };
        const ow = M().worldPose(oe), by = h.engine.standableNearV1?.([ow.x, ow.z], level, soul.entityId, 0.4, 16) ?? null;
        if (!by) return { code: 'form.no-room', reason: `There is no room to stand by ${nameOf(other)}.` };
        walk(by, [ow.x, ow.y, ow.z]); steps.push({ verb: 'mars:pose_v1', params: { activity: 'listen', seconds: 2 } }); continue;
      }
      if (s.step === 'move' && HELD_MOVES.has(String(s.move))) {
        // SA-F4d: today's pour and sip, by parameters: the entry's points, the move's time, the rules' amounts
        const e = all()[id], ph = moves()[String(s.move)]?.phases ?? {};
        if (e?.support?.kind !== 'in-hand' || e.support.by !== soul.entityId) return { code: 'form.not_held', reason: `${nameOf(id)}: not held.` };
        const amount = (now.changes as Change[]).find((c) => c.change === 'set' && c.node === id && typeof c.to === 'number' && typeof t.entry.state?.[c.field]?.max === 'number') as Extract<Change, { change: 'set' }> | undefined;
        const max = amount ? t.entry.state![amount.field].max! : 0, had = amount ? Number(fieldsOf(t)[amount.field] ?? 0) : 0, left = amount ? Number(amount.to) : 0;
        if (s.move === 'consume') {
          const from = max > 0 ? Math.min(1, Math.max(0, had / max)) : 1, sip = max > 0 ? Math.min(1, Math.max(0.01, (had - left) / max)) : 0.2;
          steps.push(LET_GO, { verb: 'mars:cup_v1', params: { item: id, stage: 'drink', face: r3(body.pose.yaw ?? 0), sips: 1, from: r3(from), sip: Math.round(sip * 10000) / 10000 } });
          continue;
        }
        if (e.support.hand !== 'right') return { code: 'form.wrong_hand', reason: `Today's pour is made with the right hand; ${nameOf(id)} is in your left.` };
        const into = now.input.act.args?.[toward!], te = typeof into === 'string' ? all()[into] : null;
        if (!te?.pose?.p) return { code: 'form.argument_missing', reason: `There is nothing near to ${action.replace(/_/g, ' ')} into.` };
        if (te.support?.kind === 'in-hand') return { code: 'form.target_held', reason: `Put ${nameOf(into)} down first; today's pour is into a thing that stands somewhere.` };
        const outPoint = points[s.at as string]; if (!outPoint) return { code: 'form.no-point', reason: `${nameOf(id)} has no point ${s.at}.` };
        const tp = te.pose.p as Vec3;
        if (!standBy(into, tp)) {
          const by = h.engine.standableNearV1?.([tp[0], tp[2]], level, soul.entityId, 0.4, 16) ?? null;
          if (!by) return { code: 'form.no-room', reason: `There is no room to stand by ${nameOf(into)}.` };
          walk(by, tp);
        }
        // tea.ts's placement with the entry's points: the pouring hand POUR_HAND_RIGHT right of the body's axis, the grip
        // where the outlet, tipped by today's pour at the middle of its tilt, stands OUTLET_DROP over the target's top;
        // the thing turned about the grip toward the target
        const fx = tp[0] - at[0], fz = tp[2] - at[1], fl = Math.hypot(fx, fz) || 1, f: Vec2 = [fx / fl, fz / fl], r: Vec2 = [-f[1], f[0]];
        const mm = (v: number[]): Vec3 => [v[0] / 1000, v[1] / 1000, v[2] / 1000];
        const grip = mm(Object.values(points).find((q) => (q as { role?: string }).role === 'grip')?.at_mm ?? [0, 0, 0]), out = mm(outPoint.at_mm);
        const tip = canPoint([0, 0, 0], grip, 0, TILT + TILT_MORE / 2, out), L = Math.hypot(tip[0], tip[2]);
        const top = ((thing(into)?.entry as { geometry?: { bounds_mm?: number[] } } | undefined)?.geometry?.bounds_mm?.[1] ?? 100) / 1000;
        const cf = fl, lat = -POUR_HAND_RIGHT;   // the target straight ahead; the hand to the right of it
        if (Math.abs(lat) >= L) return { code: 'form.no-room', reason: `${nameOf(id)} is too short to pour from beside you.` };
        const gf = cf - Math.sqrt(L * L - lat * lat), turn = Math.atan2(lat, cf - gf);
        const hold: Vec3 = [at[0] + f[0] * gf + r[0] * POUR_HAND_RIGHT, tp[1] + top + OUTLET_DROP - tip[1], at[1] + f[1] * gf + r[1] * POUR_HAND_RIGHT];
        const moved = had - left, unit = amount ? t.entry.state![amount.field].unit : undefined;
        steps.push({ verb: 'mars:watering_can_v1', params: { item: id, target: into, stage: 'pour', face: r3(Math.atan2(f[1], f[0])), hold: hold.map(r3), spoutYaw: r3(turn), tilt: r3(TILT), tiltMore: r3(TILT_MORE), flowFrom: r3(TILT - FLOW_LEAD), flowFull: r3(TILT), seconds: Math.min(20, Math.max(0.5, Number(ph.pour_us ?? 2500000) / 1e6)), levelAfter: r3(max > 0 ? Math.min(1, Math.max(0, left / max)) : 0), ...(unit === 'g' && moved > 0 ? { litres: r3(moved / 1000) } : {}) } });
        continue;
      }
      if (s.step === 'wait') { steps.push({ verb: 'mars:pose_v1', params: { activity: 'listen', seconds: Math.min(3600, Math.max(0.5, Number((s as { us?: number }).us ?? 0) / 1e6)) } }); continue; }
      const p = points[s.at as string]; if (!p) return { code: 'form.no-point', reason: `${nameOf(id)} has no point ${s.at}.` };
      const hand = toWorld(wp, p.at_mm);
      // where to stand: the entry's stand point nearest the hand's point; else today's approach, the nearest clear ground
      let stand: Vec2 | null = null, best = Infinity;
      // (only a stand point with room to stand: mending.ts's clearance test)
      for (const q of standsOf(id)) { const d = Math.hypot(q[0] - hand[0], q[2] - hand[2]); if (d < best && clear(q, level)) { best = d; stand = [q[0], q[2]]; } }
      stand ??= h.engine.standableNearV1?.([hand[0], hand[2]], level, soul.entityId, 0.4, 16) ?? null;
      if (!stand) return { code: 'form.no-room', reason: `There is no room to stand and reach ${nameOf(id)}.` };
      walk(stand, hand);
      steps.push(LET_GO, { verb: 'mars:hand_actuator_v1', params: { target: id, at: hand.map(r3) } });
    }
    // a change of parent is made by today's motion: keep the rules' answer as it was now; the plan made when the act starts
    // (wrapAct, just before `begun`) is the one checked at the end, never a later menu's
    if ((now.changes as Change[]).some((c) => c.change === 'reparent')) latest.set(soul.entityId, { capability: `object:${id}:${action}`, answer: now });
    return { steps, summary: `${action.replace(/_/g, ' ')} ${nameOf(id)}` };
  }
  /** The ledger's actOutcome: when a form's programme ends, ask its needs again and apply its changes once. Null for
   *  anything that is not an entry thing's form, and for a programme that did not finish (today's failure stands). */
  function outcome(capability: string, bodyId: string, finished: boolean): 'done' | Refusal | null {
    const m = /^object:(.+):([a-z][a-z0-9_]*)$/.exec(capability); if (!m) return null;
    const [, id, action] = m, t = thing(id), f = t && formOf(t.entry, action);
    if (!t || !f) return null;
    const form = f.form, key = `${bodyId}|${capability}`, before = planned.get(key); planned.delete(key);
    if (!finished) return null;
    const body = all()[bodyId]; if (!body?.pose?.p) return { code: 'body.unavailable', reason: 'Your body is unavailable; nothing changed.' };
    if ((form.effects ?? []).some((e) => e.change === 'reparent')) {
      // SA-F4b: today's take or put made the change; the rules' answer when it started says where the thing must be now
      if (!before) return { code: 'form.unplanned', reason: `${nameOf(id)}: this act was not planned by the forms adapter.` };
      const put = (form.steps ?? []).find((s) => s.step === 'put') as { place?: { anchor?: unknown } } | undefined;
      const anchor = put && before.input.act.args?.[argName(put.place?.anchor) ?? ''];
      for (const c of before.changes as Change[]) {
        if (c.change !== 'reparent') continue;
        const s = all()[c.node]?.support, inHand = 'hand' in c.to;
        if (inHand ? s?.kind === 'in-hand' && s.by === bodyId && s.hand === (c.to as { hand: string }).hand : s?.kind === 'resting-on' && (typeof anchor !== 'string' || s.on === anchor)) continue;
        return { code: 'form.not_moved', reason: `${nameOf(c.node)} is not ${inHand ? `in your ${(c.to as { hand: string }).hand} hand` :`on ${typeof anchor === 'string' ? nameOf(anchor) : 'a place here'}`} at the end of the motion.` };
      }
      return 'done';
    }
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
    const r = ask(t, id, f, action, bodyId, effector, `${capability}@${h.engine.world.tick}`);
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
  /** Is this capability a form of an entry thing, its own or the body's (so tea.ts does not watch the body for it)? */
  const owns = (capability: string) => { const m = /^object:(.+):([a-z][a-z0-9_]*)$/.exec(capability), t = m && thing(m[1]); return !!t && (!!t.entry.forms?.[m![2]] || bodyForms().some(([n]) => n === m![2])); };
  /** The act has started (the ledger's expect, right after the plan wrapAct made for it): keep that plan's answer. */
  const begun = (body: string, capability: string) => { const l = latest.get(body); if (l?.capability === capability) planned.set(`${body}|${capability}`, l.answer); };
  return { plan, outcome, owns, begun, actions };
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
  if (r.reason === 'field_differs') {
    const w = d.wanted ?? {}, range = [w.at_least !== undefined ? `at least ${w.at_least}` : '', w.at_most !== undefined ? `at most ${w.at_most}` : ''].filter(Boolean).join(' and ');
    return `${name}: ${d.field} is ${JSON.stringify(d.found)}, and this needs it ${'is' in w ? JSON.stringify(w.is) : 'not' in w ? `not ${JSON.stringify(w.not)}` : range}`;
  }
  if (r.reason === 'out_of_reach') return `${name}: the ${d.point} was out of reach when the motion ended`;
  if (r.verdict === 'unknown') return `${name}: what this needs could not be read`;
  return `${name}: ${String(r.reason ?? 'refused').replace(/_/g, ' ')}${d.what ? ` (${d.what})` : ''}`;
}
