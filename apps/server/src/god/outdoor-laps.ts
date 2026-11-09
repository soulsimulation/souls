// #1647: the native program owns duration and interruption. Only its completed receipt writes a record.
import { opSchema, type Op, type StoredDef, type WorldModel } from '@souls/world-compiler';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';

type Refusal = { code: string; reason: string };
type Body = { pose?: { p: number[] }; human?: { holding?: unknown; hands?: unknown; handActuator?: unknown } };
export type OutdoorLapsHost = {
  model: WorldModel;
  engine: { world: { entities: Record<string, Body> }; clearanceAtV1?(x: number, z: number, level: number): number };
  levelAt(x: number, z: number, y: number): number;
  soul(id: string): { id: string; entity_id: string; name: string } | undefined;
  denied(id: string, soul: { soulId: string; entityId: string; name: string }): Refusal | null;
  commit(ops: Op[], note: string): { accepted: boolean };
  log(message: string): void;
};
const isLaps = (def: StoredDef | undefined) => def?.name === 'core-outdoor-laps' && def.version === 1;
export function createOutdoorLaps(h: OutdoorLapsHost) {
  const marker = (id: string) => { const e = h.model.entities.get(id); return e && isLaps(h.model.resolvedDef(e.def)) ? e : null; };
  function plan(soul: EdgeSoul, id: string, action: string) {
    const e = marker(id); if (!['walk-lap','jog-lap'].includes(action) || !e) return null;
    const denied = h.denied(id, soul); if (denied) return denied;
    const b = h.engine.world.entities[soul.entityId]; if (!b?.human) return { code: 'body.unavailable', reason: 'Your body is unavailable.' };
    if (b.human.holding || b.human.hands || b.human.handActuator || Object.values(h.engine.world.entities).some(x => (x as {support?:{kind?:string;by?:string}}).support?.kind === 'in-hand' && (x as {support?:{by?:string}}).support?.by === soul.entityId)) return { code: 'object.state', reason: 'Finish what your hands are doing before beginning an outdoor lap.' };
    const p = h.model.worldPose(e), level = h.levelAt(p.x, p.z, p.y);
    if (h.engine.clearanceAtV1 && h.engine.clearanceAtV1(p.x, p.z, level) < 0.4) return { code: 'object.state', reason: 'There is not clear ground at the centre of this lap marker.' };
    const gait = action === 'jog-lap' ? 'jog' : 'walk';
    const waypoints = [[0,-2],[-3,-2],[-3,2],[3,2],[3,-2],[0,-2]].map(([x,z]) => ({x:p.x + x*Math.cos(p.yaw)+z*Math.sin(p.yaw),z:p.z-x*Math.sin(p.yaw)+z*Math.cos(p.yaw)}));
    return { summary: 'Completed an outdoor ' + gait + ' lap.', steps: [
      {verb:'stand',params:{}},
      ...waypoints.map((point,i)=>({verb:'mars:walk_to',params:{...point,level,...(i>0?{gait}:{})}})),
      {verb:'stand',params:{}}
    ] };

  }
  function onReceipt(r: EdgeReceipt) {
    if (r.phase !== 'completed' || !Number.isSafeInteger(r.endedTick) || r.endedTick! < 0) return;
    const match = /^object:(.+):(walk-lap|jog-lap)$/.exec(r.capability); if (!match) return;
    const e = marker(match[1]), soul = h.soul(r.soulId); if (!e || !soul || h.denied(e.id, { soulId: soul.id, entityId: soul.entity_id, name: soul.name })) return;
    const tick = Number(e.state?.lastCompletedTick ?? -1), previous = String(e.state?.lastReceipt ?? '');
    if (r.endedTick! < tick || (r.endedTick === tick && r.id <= previous)) return;
    const done = h.commit([opSchema.parse({ op: 'set', id: e.id, state: { completedLaps: Math.min(1e9, Number(e.state?.completedLaps ?? 0) + 1), lastBy: soul.name.slice(0, 100), lastGait: match[2] === 'jog-lap' ? 'jog' : 'walk', lastCompletedTick: r.endedTick, lastReceipt: r.id } })], `${r.soulId} completed an outdoor lap`);
    if (!done.accepted) h.log('outdoor-laps: the world refused the completion record');
  }
  return { plan, onReceipt, facts(id: string) {
    const e = marker(id); if (!e) return null;
    return { practice: `Outdoor solo lap: approach the start stripe, follow four corners around the 6 by 4 metre authored rectangle, return to the stripe and stand. Choose walk-lap or jog-lap. Native navigation may detour or refuse a blocked leg; no distance/fitness claim. Only whole completed laps count. Completed laps: ${e.state?.completedLaps ?? 0}. Last gait: ${e.state?.lastGait ?? 'none'}.` + (e.state?.lastBy ? ` Most recently ${e.state.lastBy}, at tick ${e.state.lastCompletedTick}.` : '') };
  } };
}
export type OutdoorLaps = ReturnType<typeof createOutdoorLaps>;
