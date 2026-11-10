import {opSchema, type Op, type Entity, type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt, EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Soul = Pick<EdgeSoul, 'soulId' | 'entityId' | 'name'>;
type Refusal = {code: string; reason: string};
type Body = {pose?: {p: number[]; yaw?: number}; support?: {kind?: string; on?: string; by?: string}; human?: {holding?: unknown; hands?: unknown}};
export type CrankLampHost = {
  model: WorldModel; engine: {world: {tick: number; entities: Record<string, Body>}; clearanceAtV1?(x: number, z: number, level?: number): number};
  levelAt(x: number, z: number, y: number): number;
  soul(id: string): {id: string; entity_id: string; name: string} | undefined;
  denied(id: string, soul: Soul): Refusal | null;
  commit(ops: Op[], note: string): {accepted: boolean}; log(s: string): void;
};
type Capture = {source: string; action: string; soul: string; body: string; stamp: string; tick: number; seconds: number; work: number};
export function validLampState(s: Record<string, unknown>) {
  return typeof s.on === 'boolean' && Number.isInteger(s.charge) && Number(s.charge) >= 0 && Number(s.charge) <= 6
    && ['cranks', 'activations', 'usedCharge', 'litUntilTick'].every(k => Number.isSafeInteger(s[k]) && Number(s[k]) >= 0)
    && Number(s.cranks) < 1e6 && Number(s.activations) < 1e6 && Number(s.usedCharge) <= 3e6
    && [0, 5, 10, 15].includes(Number(s.lastSeconds));
}
export function createCrankLamp(h: CrankLampHost) {
  const pending = new Map<string, Capture>(), started = new Map<string, Capture>();
  const active = new Map<string, number>();
  let recovered = false;
  const target = (id: string) => {const e = h.model.entities.get(id), d = e && h.model.resolvedDef(e.def); return d?.name === 'core-crank-inspection-lamp' && d.version === 1 ? e! : null;};
  const physical = (e: Entity) => {const p = h.engine.world.entities[e.id]?.pose, w = h.model.worldPose(e); return p ? {x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.yaw ?? w.yaw} : w;};
  const parent = (e: Entity) => h.model.entities.get(h.engine.world.entities[e.id]?.support?.on ?? '');
  const identity = (e: Entity) => [e.id, e.v, e.def, e.in, e.owner, e.access, e.params, e.state, physical(e)];
  const stamp = (e: Entity) => JSON.stringify([identity(e), h.engine.world.entities[e.id]?.support, (() => {const p = parent(e); return p ? identity(p) : null;})()]);
  const fail = (reason: string): Refusal => ({code: 'object.state', reason});
  function ready(s: Soul, e: Entity) {
    const denied = h.denied(e.id, s); if (denied) return denied;
    if (!validLampState(e.state ?? {})) return fail('Ask the creator to restore whole charge0–6 and valid lamp records before using this lamp.');
    const p = physical(e), table = parent(e);
    if (h.engine.world.entities[e.id]?.support?.kind !== 'resting-on' || !table || p.y < .65 || p.y > 1.35)
      return fail('Place this same lamp on an ordinary supported tabletop0.65–1.35m high before working its crank or switch.');
    const no = h.denied(table.id, s); if (no) return no;
    const b = h.engine.world.entities[s.entityId];
    if (!b?.human || !b.pose?.p) return {code: 'body.unavailable', reason: 'Your native body is unavailable.'};
    if (b.human.holding || Object.values(b.human.hands ?? {}).some(Boolean) || Object.values(h.engine.world.entities).some(v => v.support?.kind === 'in-hand' && v.support.by === s.entityId))
      return fail('Put down held objects before working this supported lamp.');
    return null;
  }
  function capture(s: Soul, e: Entity, action: string, params: Record<string, unknown>): Capture | Refusal {
    const no = ready(s, e); if (no) return no;
    let seconds = 0;
    if (action === 'illuminate') {
      const v = params.seconds ?? '5';
      if (typeof v !== 'string' || !['5', '10', '15'].includes(v)) return fail('Choose seconds as string5,10 or15; each five seconds spends one charge.');
      seconds = Number(v);
      if (e.state?.on === true) return fail('This lamp is already illuminating; wait for expiry or extinguish it before another interval.');
      if (Number(e.state?.charge) < seconds / 5) return fail(`This lamp needs ${seconds / 5} stored charge for that interval; crank it first or choose fewer seconds.`);
    } else if (action === 'crank') {
      if (e.state?.on === true) return fail('Wait for the light to expire or extinguish it before cranking.');
      if (Number(e.state?.charge) > 4) return fail('There is not room for two more charges; spend charge on illumination first.');
    } else if (action === 'extinguish') {
      if (e.state?.on !== true) return fail('This lamp is already dark; crank it or activate a charged interval.');
    } else return fail('Choose a declared crank, illuminate or extinguish offer.');
    return {source: e.id, action, soul: s.soulId, body: s.entityId, stamp: stamp(e), tick: h.engine.world.tick, seconds, work: action === 'crank' ? 4 : 1};
  }
  function plan(s: Soul, id: string, action: string, params: Record<string, unknown> = {}) {
    const e = target(id); if (!e || !['crank', 'illuminate', 'extinguish'].includes(action)) return null;
    const q = capture(s, e, action, params); if ('code' in q) return q;
    const at = physical(e), x = at.x - Math.sin(at.yaw) * 1.1, z = at.z + Math.cos(at.yaw) * 1.1, level = h.levelAt(x, z, at.y);
    if ((h.engine.clearanceAtV1?.(x, z, level) ?? 1) < .4) return fail('Clear the ordinary standing point in front of this lamp table first.');
    return {summary: action === 'illuminate' ? `Complete activation after approach, then spend ${q.seconds / 5} charge for ${q.seconds} seconds of actual world illumination.` : 'Complete native handwork on the same supported lamp; interrupted work earns no charge.', steps: [
      {verb: 'stand', params: {}}, {verb: 'walk_to', params: {to: [x, z]}},
      {verb: 'mars:pose_v1', params: {activity: 'operate', seconds: q.work, face: [at.x, at.z]}},
      {verb: 'mars:pose_v1', params: {activity: 'nod', seconds: .5, base: 'idle', release: true, clear: true, face: [at.x, at.z]}}, {verb: 'stand', params: {}},
    ]};
  }
  function begin(s: Soul, id: string, action: string, params: Record<string, unknown> = {}) {
    const e = target(id); if (!e) return; const q = capture(s, e, action, params); if (!('code' in q)) pending.set(s.soulId, q);
  }
  function dark(id: string, note: string) {
    const e = target(id); if (!e || e.state?.on !== true) {active.delete(id); return;}
    if (h.commit([opSchema.parse({op: 'set', id, state: {on: false, litUntilTick: 0}})], note).accepted) active.delete(id);
    else h.log('crank lamp: darkening refused; active deadline retained for the next native tick');
  }
  function tick() {
    if (!recovered) {
      recovered = true;
      // One startup reconciliation, never a recurring world scan. Restart conservatively ends any old interval.
      for (const e of h.model.entities.values()) if (target(e.id)?.state?.on === true) {active.set(e.id, 0); dark(e.id, 'End historical crank-lamp light after restart without charge refund');}
    }
    for (const [id, until] of active) if (h.engine.world.tick >= until) dark(id, 'Completed crank-lamp illumination deadline; charge remains spent');
  }
  function onReceipt(r: EdgeReceipt) {
    if (r.phase === 'started') {const q = pending.get(r.soulId); pending.delete(r.soulId); if (q && q.tick === r.acceptedTick && r.capability === `object:${q.source}:${q.action}`) started.set(r.id, q); return;}
    if (!['completed', 'failed', 'replaced', 'aborted', 'cancelled'].includes(r.phase)) return;
    const q = started.get(r.id); started.delete(r.id); pending.delete(r.soulId);
    if (!q || r.phase !== 'completed' || r.capability !== `object:${q.source}:${q.action}` || r.soulId !== q.soul || r.startedTick == null || r.endedTick == null || r.endedTick - r.startedTick < q.work * 20) return;
    const e = target(q.source), row = h.soul(q.soul); if (!e || !row || row.entity_id !== q.body || e.state?.lastReceipt === r.id || stamp(e) !== q.stamp) return;
    const s = {soulId: row.id, entityId: row.entity_id, name: row.name}, p = h.engine.world.entities[q.body]?.pose?.p, at = physical(e);
    if (ready(s, e) || !p || Math.hypot(p[0] - at.x, p[2] - at.z) > ACT_REACH || h.levelAt(p[0], p[2], p[1]) !== h.levelAt(at.x, at.z, at.y)) return;
    const state: Record<string, unknown> = {lastBy: row.name.slice(0, 80), lastReceipt: r.id, lastCompletedTick: r.endedTick};
    let until = 0;
    if (q.action === 'crank') Object.assign(state, {charge: Number(e.state?.charge) + 2, cranks: Number(e.state?.cranks) + 1});
    else if (q.action === 'illuminate') {until = h.engine.world.tick + q.seconds * 20; Object.assign(state, {on: true, charge: Number(e.state?.charge) - q.seconds / 5, usedCharge: Number(e.state?.usedCharge) + q.seconds / 5, activations: Number(e.state?.activations) + 1, lastSeconds: q.seconds, litUntilTick: until});}
    else Object.assign(state, {on: false, litUntilTick: 0});
    if (h.commit([opSchema.parse({op: 'set', id: e.id, state})], `${r.soulId} completed crank-lamp ${q.action}`).accepted) {
      if (until) active.set(e.id, until); else if (q.action === 'extinguish') active.delete(e.id);
    } else h.log('crank lamp: atomic native work refused; previous charge and history retained');
  }
  return {plan, begin, onReceipt, tick, facts(id: string) {const e = target(id); return e ? {crankLamp: `Inspection lamp: ${e.state?.charge}/6 whole charge; light ${e.state?.on ? 'on until its native deadline' : 'off'}; completed cranks ${e.state?.cranks}, activations ${e.state?.activations}, spent charge ${e.state?.usedCharge}; last interval ${e.state?.lastSeconds}s, worker ${e.state?.lastBy || 'none'}. Crank4s adds2 if room; illuminate string seconds5/10/15 spends1/2/3 after completed activation; extinguish1s never refunds. Supported accessible tabletop and empty hands. ${[...started.values()].some(q => q.source === id) ? 'Native work active; no new charge or activation credit yet. ' : ''}Restart ends the light without refund; coarse charge batches, no scientific energy model.`} : null;}};
}
export type CrankLamp = ReturnType<typeof createCrankLamp>;
