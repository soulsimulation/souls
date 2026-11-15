// #2443: an edit re-settles a padded neighbour only when the ground under its flat changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_KIT, WorldModel, applyBatch, coreRef, type Refused } from './index.ts';

function hillside() {
  const w = new WorldModel({ constants: { extent: 1000, ground: 'land' }, seed: 'pads' });
  for (const d of CORE_KIT) w.defineDef(d, 'core', 0);
  const ok = (r: ReturnType<typeof applyBatch>) => assert.equal(r.result.accepted, true, JSON.stringify((r.result as Refused).failures));
  ok(applyBatch(w, { ops: [{ op: 'place', def: coreRef('knoll'), name: 'knoll', p: [40, 10], params: { height: 5, radius: 30 } }] }, 'god', 1));
  ok(applyBatch(w, { ops: [
    { op: 'place', def: coreRef('cottage'), name: 'a', p: [28, 10] },
    { op: 'place', def: coreRef('cottage'), name: 'b', p: [52, 10] },
  ] }, 'god', 2));
  return { w, ok };
}
/** Pad ids lifted or set while `fn` runs (on the prototype: a batch plans on a fork of the model). */
function padWrites(fn: () => void): string[] {
  const out: string[] = [], proto = WorldModel.prototype, set = proto.setLandform;
  proto.setLandform = function (this: WorldModel, l, id) { if (id.endsWith(':pad')) out.push(id); return set.call(this, l, id); };
  try { fn(); } finally { proto.setLandform = set; }
  return out;
}

test('removing and restoring a padded building leaves its padded neighbour, pad and pose, untouched', () => {
  const { w, ok } = hillside();
  const a = w.get('a')!, b = w.get('b')!, bPad = w.ground().landforms.find((l) => l.id === `${b.id}:pad`)!;
  assert.ok(bPad, 'b stands on a pad');
  const sub = w.subtree(a.id).map((id) => w.entities.get(id)!);
  const writes = padWrites(() => ok(applyBatch(w, { ops: [{ op: 'remove', id: a.id, cascade: true }, ...sub.map((entity) => ({ op: 'restore' as const, entity }))] }, 'god', 3, { trusted: true })));
  assert.ok(writes.includes(`${a.id}:pad`), 'a\'s own pad comes up and goes back');
  assert.ok(!writes.includes(`${b.id}:pad`), `b is not re-settled (pad writes: ${writes.join(' ')})`);
  assert.deepEqual(w.get('b'), b);
  assert.equal(w.ground().landforms.find((l) => l.id === `${b.id}:pad`), bPad, 'b keeps the same pad');
});

test('a landform raised under a padded building\'s flat still re-settles it', () => {
  const { w, ok } = hillside();
  const b = w.get('b')!;
  const writes = padWrites(() => ok(applyBatch(w, { ops: [{ op: 'place', def: coreRef('knoll'), name: 'bump', p: [52, 10], params: { height: 2, radius: 6 } }] }, 'god', 3)));
  assert.ok(writes.includes(`${b.id}:pad`), `b is re-settled on the changed ground (pad writes: ${writes.join(' ')}; ${JSON.stringify(w.get('bump')?.p)})`);
});
