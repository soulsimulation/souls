// classroom-tv/1 (#2302): the Eden classroom screen as a TV Souls work by offered ids. The object is the social face of the
// native screen: its state is read from the screen entity every time (never kept as bookkeeping), and each act is one native
// `classroom_tv` step the engine decides (reach, a class holding the screen) and logs like any other body step.
import type {WorldHost} from './world.ts';
import type {EdgeLedger} from './edge/ledger/ledger.ts';
import type {ObjectKind, TimeCtx} from './edge/comms/objects/types.ts';
import {readOnlyObjectAdvance, type Objects} from './edge/comms/objects/framework.ts';

export const CLASSROOM_TV_KIND = 'classroom-tv';
export type ClassroomTvState = {display: string; on: boolean; picture: string; inClass: boolean};
type Read = (display: string) => Omit<ClassroomTvState, 'display'> | null;

function from(display: string, read: Read): ClassroomTvState {
  const v = read(display);
  return {display, on: v?.on ?? false, picture: v?.picture ?? 'lesson', inClass: v?.inClass ?? false};
}
const step = (s: ClassroomTvState, op: 'on' | 'off' | 'next', label: string) => ({state: s, result: {display: s.display, op},
  bodies: [{label, steps: [{verb: 'mars:classroom_tv', params: {display: s.display, op}}]}]});
const inClass = (s: ClassroomTvState) => s.inClass ? {code: 'classroom-tv.in-class', reason: 'A class is using the screen for its lesson; wait until it ends.'} : null;

export function classroomTvKind(read: Read): ObjectKind<ClassroomTvState> {
  return {
    kind: CLASSROOM_TV_KIND,
    description: 'The classroom TV. Switched on, it shows one picture: the lesson, a garden, the sea, stars or a test card; change the picture to see the next. Off, it is dark glass. Work it from inside the classroom; while a class runs, its lesson stays on the screen.',
    listed: false,
    roles: [],
    schema: {display: {type: 'string', visibility: 'public'}, on: {type: 'boolean', visibility: 'public'}, picture: {type: 'string', visibility: 'public', description: 'lesson, garden, sea, stars or test-card'}, inClass: {type: 'boolean', visibility: 'public'}},
    initial: (p) => from(String(p.display ?? ''), read),
    rolesOf: () => [],
    advance: readOnlyObjectAdvance((s: ClassroomTvState, _ctx: TimeCtx) => {const n = from(s.display, read); return n.on === s.on && n.picture === s.picture && n.inClass === s.inClass ? null : {state: n};}),
    actions: {
      'switch-on': {label: 'Switch the classroom TV on', movesBody: true, roles: 'anyone', reach: 'place', params: {},
        available: s => s.on ? {code: 'classroom-tv.already-on', reason: 'The TV is already on.'} : inClass(s),
        validate: s => s.on ? {code: 'classroom-tv.already-on', reason: 'The TV is already on.'} : inClass(s),
        apply: s => step(s, 'on', 'Switch the classroom TV on')},
      'switch-off': {label: 'Switch the classroom TV off', movesBody: true, roles: 'anyone', reach: 'place', params: {},
        available: s => !s.on ? {code: 'classroom-tv.off', reason: 'The TV is already off.'} : inClass(s),
        validate: s => !s.on ? {code: 'classroom-tv.off', reason: 'The TV is already off.'} : inClass(s),
        apply: s => step(s, 'off', 'Switch the classroom TV off')},
      'change-picture': {label: 'Change the picture on the classroom TV', movesBody: true, roles: 'anyone', reach: 'place', params: {},
        available: s => !s.on ? {code: 'classroom-tv.off', reason: 'The TV is off; switch it on first.'} : inClass(s),
        validate: s => !s.on ? {code: 'classroom-tv.off', reason: 'The TV is off; switch it on first.'} : inClass(s),
        apply: s => step(s, 'next', 'Change the picture on the classroom TV')},
    },
  };
}

/** Publish the classroom TV object once the engine has a TV screen (after classroom-tv/1 is adopted). Idempotent. */
export function installClassroomTv(host: WorldHost, edge: EdgeLedger): string | null {
  const objects = edge.comms?.objects as Objects | undefined; if (!objects) return null;
  const ents = () => host.engine.world.entities as Record<string, {pose: {p: number[]}; equipment?: {kind: string; config: Record<string, unknown>}}>;
  const screen = Object.entries(ents()).find(([, e]) => e.equipment?.kind === 'display' && e.equipment.config.tv === true);
  if (!screen) return null;
  const [id, e] = screen;
  if (!objects.kindOf(CLASSROOM_TV_KIND)) objects.register(classroomTvKind(display => {
    const c = ents()[display]?.equipment?.config; if (!c) return null;
    const rt = (host.engine as unknown as {rt?: {holder(r: string): string[]}}).rt;
    return {on: c.mode === 'on' && c.available !== false, picture: typeof c.picture === 'string' ? c.picture : 'lesson', inClass: (rt?.holder(`display:${display}`).length ?? 0) > 0};
  }));
  if (objects.has(id)) return id;
  const place = edge.places.containing(e.pose.p[0]!, e.pose.p[2]!, 0)[0]?.id ?? [...edge.places.byId.values()].find(p => p.parent === null)?.id;
  if (!place) return null;
  objects.create({id, kind: CLASSROOM_TV_KIND, name: 'classroom TV', placeId: place, params: {display: id}});
  return id;
}
