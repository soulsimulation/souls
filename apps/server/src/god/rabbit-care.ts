import { opSchema, type Op, type WorldModel } from '@souls/world-compiler';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';
import { ACT_REACH } from './actuators.ts';
import { supportY } from './nav.ts';
type Refusal = { code: string; reason: string };
type Body = { pose?: { p: number[] }; support?: { kind?: string; by?: string }; human?: { holding?: unknown; hands?: unknown; handActuator?: unknown } };
export type RabbitCareHost = { model: WorldModel; worldId: string; engine: { world: { tick: number; entities: Record<string, Body> }; clearanceAtV1?(x: number, z: number, level?: number): number }; levelAt(x: number, z: number, y: number): number; soul(id: string): { id: string; entity_id: string; name: string } | undefined; denied(id: string, s: Pick<EdgeSoul, 'soulId' | 'entityId' | 'name'>): Refusal | null; commit(ops: Op[], note: string): { accepted: boolean }; log(s: string): void };
type Capture = { stock: string; rabbit: string; body: string; soul: string; tick: number; world: string; stockStamp: string; rabbitStamp: string; rabbitName: string };
const fail = (reason: string, code = 'object.state'): Refusal => ({ code, reason });
export function createRabbitCare(h: RabbitCareHost) {
  const requested = new Map<string, Capture>(), pending = new Map<string, Capture>();
  const named = (id: string, name: string) => { const e = h.model.entities.get(id), d = e && h.model.resolvedDef(e.def); return e && d?.name === name && d.version === 1 ? e : null; };
  const stock = (id: string) => named(id, 'core-rabbit-feed');
  const stamp = (id: string) => { const e = h.model.entities.get(id); return JSON.stringify([e?.def, e?.owner, e?.access, e?.in, e && h.model.worldPose(e), e?.params, e?.state]); };
  function check(s: Pick<EdgeSoul, 'soulId' | 'entityId' | 'name'>, id: string, text?: unknown, finishing = false) {
    const e = stock(id); if (!e) return fail('This supplied rabbit feed is no longer there.', 'object.gone');
    const no = h.denied(id, s); if (no) return no;
    const b = h.engine.world.entities[s.entityId], at = b?.pose?.p;
    if (!b?.human || !at || at.length !== 3 || !at.every(Number.isFinite)) return fail('Your native body is unavailable.', 'body.unavailable');
    if (b.human.holding || b.human.hands || b.human.handActuator || Object.values(h.engine.world.entities).some(x => x.support?.kind === 'in-hand' && x.support.by === s.entityId)) return fail('Empty your hands before offering rabbit feed.');
    if (!Number.isSafeInteger(e.state?.portions ?? 3) || Number(e.state?.portions ?? 3) < 1) return fail('No supplied rabbit-feed portion remains.');
    if (text === undefined) return { e, b };
    if (typeof text !== 'string' || !text.trim()) return fail('Choose the exact ID or ordinary reference of an unfed garden rabbit.');
    let target; try { target = h.model.get(text.trim()); } catch {}
    if (!target) return fail('That rabbit is no longer there.', 'object.gone');
    const denied = h.denied(target.id, s); if (denied) return denied;
    if (!named(target.id, 'core-garden-rabbit')) return fail('Choose an opt-in garden rabbit; other animals are not supported.');
    if (target.state?.fed === true) return fail('This rabbit has already eaten its supplied portion; choose another unfed rabbit.');
    if (target.params?.behavior !== 'idle') return fail('The rabbit must be resting at its authored feeding place.');
    const p = h.model.worldPose(e), q = h.model.worldPose(target), sf = h.levelAt(p.x, p.z, supportY(h.model, e)), tf = h.levelAt(q.x, q.z, supportY(h.model, target));
    if (sf !== tf || Math.hypot(q.x - p.x, q.z - p.z) > 6) return fail('Keep the rabbit within six metres of its feed on the same native floor.', 'object.out-of-reach');
    if (finishing && (h.levelAt(at[0], at[2], at[1]) !== tf || Math.hypot(at[0] - q.x, at[2] - q.z) > ACT_REACH)) return fail('Complete the feeding beside this rabbit on its native floor.', 'object.out-of-reach');
    return { e, b, target };
  }
  function plan(s: EdgeSoul, id: string, action: string, params?: Record<string, unknown>) {
    if (!stock(id) || action !== 'feed-rabbit') return null;
    const c = check(s, id, params?.text); if ('code' in c) return c;
    if (!('target' in c) || !c.target) return { summary: 'Choose an unfed garden rabbit by exact ID or ordinary reference.', steps: [] };
    const steps: { verb: string; params: Record<string, unknown> }[] = [{ verb: 'stand', params: {} }];
    for (const [e, seconds] of [[c.e, 1], [c.target, 2]] as const) {
      const p = h.model.worldPose(e), gap = h.model.resolvedDef(e.def)!.size.box[2] * p.s / 2 + .7;
      const x = p.x + Math.sin(p.yaw) * gap, z = p.z + Math.cos(p.yaw) * gap, level = h.levelAt(x, z, supportY(h.model, e));
      if (h.engine.clearanceAtV1 && h.engine.clearanceAtV1(x, z, level) < .4) return fail('There is no clear standing room beside the feed or rabbit.');
      steps.push({ verb: 'mars:walk_to', params: { x, z, level } }, { verb: 'mars:pose_v1', params: { activity: 'feed', seconds, face: [p.x, p.z] } });
    }
    const end = h.model.worldPose(c.target);
    steps.push({ verb: 'mars:pose_v1', params: { activity: 'nod', seconds: 1, face: [end.x, end.z] } }, { verb: 'stand', params: {} });
    return { summary: 'Offer one supplied portion through completed native feeding; the same rabbit becomes fed and rests.', steps };
  }
  function begin(s: EdgeSoul, id: string, action: string, params: Record<string, unknown>) {
    if (!stock(id) || action !== 'feed-rabbit') return;
    const c = check(s, id, params.text); if ('code' in c || !('target' in c) || !c.target) return;
    requested.set(s.soulId, { stock: id, rabbit: c.target.id, soul: s.soulId, body: s.entityId, world: h.worldId, tick: h.engine.world.tick, stockStamp: stamp(id), rabbitStamp: stamp(c.target.id), rabbitName: h.model.pathOf(c.target.id).slice(0, 160) });
  }
  function onReceipt(r: EdgeReceipt) {
    const m = /^object:(.+):feed-rabbit$/.exec(r.capability);
    if (r.phase === 'started') { const q = requested.get(r.soulId); requested.delete(r.soulId); if (q && m && q.stock === m[1] && q.tick === r.acceptedTick) pending.set(r.id, q); return; }
    if (!['completed', 'failed', 'replaced'].includes(r.phase)) return;
    const q = pending.get(r.id); pending.delete(r.id);
    if (!q || !m || m[1] !== q.stock || r.soulId !== q.soul || r.phase !== 'completed') return;
    const e = stock(q.stock), s = h.soul(q.soul);
    if (!e || !s || s.entity_id !== q.body || q.world !== h.worldId || stamp(e.id) !== q.stockStamp || stamp(q.rabbit) !== q.rabbitStamp || !Number.isSafeInteger(r.endedTick) || r.endedTick! < q.tick || r.endedTick! < Number(e.state?.lastCompletedTick ?? -1) || e.state?.lastReceipt === r.id) return;
    const c = check({ soulId: s.id, entityId: s.entity_id, name: s.name }, e.id, q.rabbit, true);
    if ('code' in c || !('target' in c) || !c.target) return;
    const ops = [opSchema.parse({ op: 'set', id: e.id, state: { portions: Number(e.state?.portions ?? 3) - 1, feedings: Number(e.state?.feedings ?? 0) + 1, lastBy: s.name.slice(0, 80), lastRabbit: q.rabbitName, lastReceipt: r.id, lastCompletedTick: r.endedTick } }), opSchema.parse({ op: 'set', id: c.target.id, params: { behavior: 'sleep' }, state: { fed: true, feeder: s.name.slice(0, 80), source: h.model.pathOf(e.id).slice(0, 160) } })];
    if (!h.commit(ops, `${r.soulId} fed the chosen garden rabbit from supplied stock`).accepted) h.log('rabbit-care: refused atomic feeding; stock and rabbit unchanged');
  }
  return { plan, begin, onReceipt, facts(id: string) {
    const e = stock(id); if (e) return { rabbitCare: `Supplied feed portions: ${e.state?.portions ?? 3}. Completed feedings: ${e.state?.feedings ?? 0}. Latest feeder: ${e.state?.lastBy || 'none'}. Latest rabbit: ${e.state?.lastRabbit || 'none'}. Choose an unfed garden rabbit by exact ID in text. Three completed native feed seconds consume one whole supplied portion. Both objects require access, unchanged state and same floor; empty hands. Rabbit remains at its authored feeding place and rests after eating; no hunger clock or autonomous animal locomotion. Latest feeder/target are historical snapshots.` };
    const rabbit = named(id, 'core-garden-rabbit'); return rabbit ? { rabbitCare: `Garden rabbit: ${rabbit.state?.fed ? 'fed and resting' : 'unfed'}. Feeder: ${rabbit.state?.feeder || 'none'}. Supplied source: ${rabbit.state?.source || 'none'}. A fed rabbit refuses another portion. This opt-in fixed-place animal uses existing idle/sleep presentation; no physiological timing claim.` } : null;
  } };
}
export type RabbitCare = ReturnType<typeof createRabbitCare>;
