// Small authoritative object seam for the first classroom. A session owns the
// `display:<id>` claim and may update only that display; independent commands use
// the same claim through Runtime.submit.
import { z } from 'zod';
import type { ActionDef, Diagnostic, StepResult } from '../actions/types.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { CATALOG } from '../world/catalog.ts';
import type { Entity } from '../world/types.ts';

export type DisplayMode = 'on' | 'off';
export type DisplayReadout = { id: string; available: boolean; mode: DisplayMode; content: string; session?: string; phase?: string; floorHolder?: string; attentionTarget?: { actor?: string; point?: [number, number] } };
export type DisplayFocus = { session: string; displayId: string; content?: string; floorHolder?: string; attentionTarget?: { actor?: string; point?: [number, number] }; phase: string };

const displayOf = (rt: Runtime, id: string): Entity | Diagnostic => {
  const e = rt.world.entities[id];
  if (!e) return { code: 'object.unknown', message: `no display entity "${id}"`, subjects: [id] };
  if (e.kind !== 'fixture' || !CATALOG[e.def]?.capabilities?.display)
    return { code: 'object.no-display', message: `${id} (${e.def}) has no usable display capability`, subjects: [id] };
  return e;
};

/** Capability check used at activity admission; an unavailable unit cannot be used. */
export function displaySupport(rt: Runtime, displayId: string): Diagnostic | null {
  const e = displayOf(rt, displayId);
  if ('code' in e) return e;
  if (e.equipment?.config.available === false)
    return { code: 'display.unavailable', message: `${displayId} is unavailable`, subjects: [displayId] };
  return null;
}

export function displayReadout(rt: Runtime, displayId: string): DisplayReadout | Diagnostic {
  const e = displayOf(rt, displayId);
  if ('code' in e) return e;
  const c = e.equipment?.kind === 'display' ? e.equipment.config : {};
  return {
    id: displayId, available: c.available !== false,
    mode: c.mode === 'on' ? 'on' : 'off', content: typeof c.content === 'string' ? c.content : '',
    ...(typeof c.session === 'string' && c.session ? { session: c.session } : {}),
    ...(typeof c.phase === 'string' && c.phase ? { phase: c.phase } : {}),
    ...(typeof c.floorHolder === 'string' && c.floorHolder ? { floorHolder: c.floorHolder } : {}),
    ...(c.attentionActor || c.attentionHasPoint ? { attentionTarget: {
      ...(typeof c.attentionActor === 'string' && c.attentionActor ? { actor: c.attentionActor } : {}),
      ...(c.attentionHasPoint === true ? { point: [Number(c.attentionX), Number(c.attentionZ)] as [number, number] } : {}),
    } } : {}),
  };
}

function owner(rt: Runtime, displayId: string, session: string): Diagnostic | null {
  const holders = rt.holder(`display:${displayId}`);
  if (holders.length === 1 && holders[0] === session && rt.isActive(session)) return null;
  return { code: 'display.not-owned', message: `${session} cannot change ${displayId}; display:${displayId} is ${holders.length ? `held by ${holders.join(', ')}` : 'unclaimed'}`, subjects: [session, displayId], details: { holder: holders[0] } };
}

const validContent = (e: Entity, content: string): Diagnostic | null => {
  const max = CATALOG[e.def].capabilities!.display!.maxChars;
  return content.length <= max ? null : { code: 'display.content-too-long', message: `${e.id} accepts at most ${max} characters; received ${content.length}`, subjects: [e.id] };
};

/** Called by an active classroom action after its own display claim is granted. */
export function classroomDisplayFocus(rt: Runtime, p: DisplayFocus): Diagnostic | null {
  const d = displaySupport(rt, p.displayId);
  if (d) return d;
  const held = owner(rt, p.displayId, p.session);
  if (held) return held;
  const e = rt.world.entities[p.displayId];
  if (p.content !== undefined) {
    const bad = validContent(e, p.content);
    if (bad) return bad;
  }
  const c = e.equipment?.kind === 'display' ? e.equipment.config : {};
  e.equipment = { kind: 'display', config: {
    ...c, available: true, mode: 'on', content: p.content ?? (typeof c.content === 'string' ? c.content : ''),
    ...(c.tv === true ? { picture: 'lesson' } : {}),   // classroom-tv/1 (#2302): a running class puts its lesson on the TV
    session: p.session, phase: p.phase, floorHolder: p.floorHolder ?? '',
    attentionActor: p.attentionTarget?.actor ?? '',
    attentionHasPoint: p.attentionTarget?.point !== undefined,
    attentionX: p.attentionTarget?.point?.[0] ?? 0,
    attentionZ: p.attentionTarget?.point?.[1] ?? 0,
  } };
  return null;
}

/** Cleanup may only be performed while this session still owns the display. */
export function classroomDisplayClear(rt: Runtime, session: string, displayId: string): Diagnostic | null {
  const e = displayOf(rt, displayId);
  if ('code' in e) return e;
  const held = owner(rt, displayId, session);
  if (held) return held;
  const c = e.equipment?.kind === 'display' ? e.equipment.config : {};
  e.equipment = { kind: 'display', config: { ...c, mode: 'off', session: '', phase: '', floorHolder: '', attentionActor: '', attentionHasPoint: false, attentionX: 0, attentionZ: 0 } };
  return null;
}

type Control = { display: string; mode: DisplayMode; content?: string };
type ControlExec = { id: string; p: Control };

/** Standalone director control; a classroom session's display claim excludes it. */
export const displayControl: ActionDef<Control, null, ControlExec> = {
  verb: 'display_control',
  description: 'Switch a capable classroom display on or off and optionally replace its bounded text content.',
  schema: z.strictObject({ display: z.string().min(1).max(80), mode: z.enum(['on', 'off']), content: z.string().max(160).optional() }),
  reservations: (_w, p) => [{ resource: `display:${p.display}`, mode: 'exclusive' }],
  plan(rt, p) {
    const e = displayOf(rt, p.display);
    if ('code' in e) return { ok: false, diagnostic: e };
    if (p.mode === 'on' && e.equipment?.config.available === false) return { ok: false, diagnostic: displaySupport(rt, p.display)! };
    if (p.content !== undefined) {
      const bad = validContent(e, p.content);
      if (bad) return { ok: false, diagnostic: bad };
    }
    return { ok: true, program: null };
  },
  start: (_rt, p, _prog, id) => ({ id, p }),
  step(rt, ex): StepResult {
    const e = rt.world.entities[ex.p.display];
    if (!e || !CATALOG[e.def]?.capabilities?.display) return { status: 'failed', diagnostic: { code: 'object.no-display', message: `${ex.p.display} no longer has a display capability`, subjects: [ex.p.display] } };
    const c = e.equipment?.kind === 'display' ? e.equipment.config : {};
    e.equipment = { kind: 'display', config: { ...c, mode: ex.p.mode, content: ex.p.content ?? (typeof c.content === 'string' ? c.content : ''), ...(c.tv === true && ex.p.content !== undefined ? { picture: 'lesson' } : {}), session: '', phase: '', floorHolder: '', attentionActor: '', attentionHasPoint: false } };
    return { status: 'completed', outputs: { display: e.id, mode: ex.p.mode } };
  },
  cancel: () => ({ ok: true }),
};

/** classroom-tv/1 (#2302): what a classroom TV can show, in the order `next` steps through them: the lesson text it
 *  showed before it was a TV, then the four pictures of the library television (core-television@2). */
export const TV_PICTURES = ['lesson', 'garden', 'sea', 'stars', 'test-card'] as const;
export type TvPicture = (typeof TV_PICTURES)[number];
/** How near a body must stand to work the TV: the classroom, not the far side of the commons. */
export const TV_REACH = 12;
export const tvPictureOf = (c: Record<string, unknown>): TvPicture => TV_PICTURES.includes(c.picture as TvPicture) ? c.picture as TvPicture : 'lesson';

/** classroom-tv/1 (#2302): once, mark a display a TV showing its lesson. Leaves mode, content and a class's claim as they are.
 *  Returns false when it is no display or already a TV. */
export function classroomTvMigrate(e: Entity | undefined): boolean {
  if (!e || e.kind !== 'fixture' || !CATALOG[e.def]?.capabilities?.display || e.equipment?.kind !== 'display' || e.equipment.config.tv === true) return false;
  e.equipment = { kind: 'display', config: { ...e.equipment.config, tv: true, picture: 'lesson' } };
  return true;
}

type Tv = { actor: string; display: string; op: 'on' | 'off' | 'next' };
/** classroom-tv/1 (#2302): a body in the room switches a classroom TV on or off, or shows its next picture. While a class
 *  holds the display (`display:<id>`), the class's lesson stays on it and this is refused. */
export const classroomTv: ActionDef<Tv, null, { id: string; p: Tv }> = {
  verb: 'classroom_tv',
  description: 'Switch a classroom TV on or off, or change it to its next picture (the lesson, garden, sea, stars, test card).',
  schema: z.strictObject({ actor: z.string().min(1), display: z.string().min(1).max(80), op: z.enum(['on', 'off', 'next']) }),
  reservations: (_w, p) => [{ resource: `display:${p.display}`, mode: 'exclusive' }],
  plan(rt, p) {
    const e = displayOf(rt, p.display);
    if ('code' in e) return { ok: false, diagnostic: e };
    const c = e.equipment?.kind === 'display' ? e.equipment.config : {};
    if (c.tv !== true) return { ok: false, diagnostic: { code: 'display.not-a-tv', message: `${p.display} is a lesson display, not a TV`, subjects: [p.display] } };
    if (c.available === false) return { ok: false, diagnostic: displaySupport(rt, p.display)! };
    const held = rt.holder(`display:${p.display}`);
    if (held.length) return { ok: false, diagnostic: { code: 'display.in-class', message: `${p.display} is showing a class's lesson (held by ${held.join(', ')})`, subjects: [p.display, ...held] } };
    const a = rt.world.entities[p.actor];
    if (!a?.human) return { ok: false, diagnostic: { code: 'object.unknown', message: `no body "${p.actor}"`, subjects: [p.actor] } };
    const d = Math.hypot(a.pose.p[0] - e.pose.p[0], a.pose.p[2] - e.pose.p[2]);
    if (d > TV_REACH || (a.human.level ?? 0) !== 0) return { ok: false, diagnostic: { code: 'display.out-of-reach', message: `${p.actor} is ${d.toFixed(1)} m from ${p.display}; come within ${TV_REACH} m`, subjects: [p.actor, p.display], details: { distance: d } } };
    if (p.op === 'next' && c.mode !== 'on') return { ok: false, diagnostic: { code: 'display.off', message: `${p.display} is off; switch it on first`, subjects: [p.display] } };
    return { ok: true, program: null };
  },
  start: (_rt, p, _prog, id) => ({ id, p }),
  step(rt, ex): StepResult {
    const e = rt.world.entities[ex.p.display];
    const c = e?.equipment?.kind === 'display' ? e.equipment.config : undefined;
    if (!e || !c || c.tv !== true) return { status: 'failed', diagnostic: { code: 'display.not-a-tv', message: `${ex.p.display} is no longer a TV`, subjects: [ex.p.display] } };
    const picture = ex.p.op === 'next' ? TV_PICTURES[(TV_PICTURES.indexOf(tvPictureOf(c)) + 1) % TV_PICTURES.length] : tvPictureOf(c);
    e.equipment = { kind: 'display', config: { ...c, mode: ex.p.op === 'off' ? 'off' : 'on', picture } };
    return { status: 'completed', outputs: { display: e.id, mode: ex.p.op === 'off' ? 'off' : 'on', picture } };
  },
  cancel: () => ({ ok: true }),
};

export const OBJECT_ACTIONS: ActionDef[] = [displayControl, classroomTv];

/** Environment adapter, deliberately a class: snapshot stores state, not service functions. */
export class ClassroomDisplayService {
  supports = displaySupport;
  focus = classroomDisplayFocus;
  clear = classroomDisplayClear;
}
