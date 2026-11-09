// #1594: the native program owns duration and interruption. Only its completed receipt writes a record.
import { opSchema, type Op, type StoredDef, type WorldModel } from '@souls/world-compiler';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';

type Refusal = { code: string; reason: string };
type Body = { pose?: { p: number[] }; human?: { holding?: unknown; hands?: unknown; handActuator?: unknown } };
export type MeditationHost = {
  model: WorldModel;
  engine: { world: { entities: Record<string, Body> }; clearanceAtV1?(x: number, z: number, level: number): number };
  levelAt(x: number, z: number, y: number): number;
  soul(id: string): { id: string; entity_id: string; name: string } | undefined;
  denied(id: string, soul: { soulId: string; entityId: string; name: string }): Refusal | null;
  commit(ops: Op[], note: string): { accepted: boolean };
  log(message: string): void;
};
const isMat = (def: StoredDef | undefined) => def?.name === 'core-meditation-mat' && def.version === 1;
export function createMeditation(h: MeditationHost) {
  const mat = (id: string) => { const e = h.model.entities.get(id); return e && isMat(h.model.resolvedDef(e.def)) ? e : null; };
  function plan(soul: EdgeSoul, id: string, action: string) {
    const e = mat(id); if (action !== 'meditate' || !e) return null;
    const denied = h.denied(id, soul); if (denied) return denied;
    const b = h.engine.world.entities[soul.entityId]; if (!b?.human) return { code: 'body.unavailable', reason: 'Your body is unavailable.' };
    if (b.human.holding || b.human.hands || b.human.handActuator || Object.values(h.engine.world.entities).some(x => (x as {support?:{kind?:string;by?:string}}).support?.kind === 'in-hand' && (x as {support?:{by?:string}}).support?.by === soul.entityId)) return { code: 'object.state', reason: 'Finish what your hands are doing before beginning a quiet practice.' };
    const p = h.model.worldPose(e), level = h.levelAt(p.x, p.z, p.y);
    if (h.engine.clearanceAtV1 && h.engine.clearanceAtV1(p.x, p.z, level) < 0.4) return { code: 'object.state', reason: 'There is not clear ground at the centre of this mat.' };
    const face: [number, number] = [p.x + Math.sin(p.yaw), p.z + Math.cos(p.yaw)];
    return { summary: 'Completed a 30-second quiet seated practice.', steps: [
      { verb: 'stand', params: {} },
      { verb: 'mars:walk_to', params: { x: p.x, z: p.z, level } },
      { verb: 'mars:pose_v1', params: { activity: 'sit-ground', seconds: 30, face } },
      { verb: 'stand', params: {} }
    ] };
  }
  function onReceipt(r: EdgeReceipt) {
    if (r.phase !== 'completed' || !Number.isSafeInteger(r.endedTick) || r.endedTick! < 0) return;
    const match = /^object:(.+):meditate$/.exec(r.capability); if (!match) return;
    const e = mat(match[1]), soul = h.soul(r.soulId); if (!e || !soul || h.denied(e.id, { soulId: soul.id, entityId: soul.entity_id, name: soul.name })) return;
    const tick = Number(e.state?.lastCompletedTick ?? -1), previous = String(e.state?.lastReceipt ?? '');
    if (r.endedTick! < tick || (r.endedTick === tick && r.id <= previous)) return;
    const done = h.commit([opSchema.parse({ op: 'set', id: e.id, state: { lastBy: soul.name.slice(0, 100), lastCompletedTick: r.endedTick, lastReceipt: r.id } })], `${r.soulId} completed a quiet practice`);
    if (!done.accepted) h.log('meditation: the world refused the completion record');
  }
  return { plan, onReceipt, facts(id: string) {
    const e = mat(id); if (!e) return null;
    return { practice: e.state?.lastBy ? `Most recent completed 30-second quiet practice: ${e.state.lastBy}, at tick ${e.state.lastCompletedTick}.` : 'No completed quiet practice recorded yet.' };
  } };
}
export type Meditation = ReturnType<typeof createMeditation>;
