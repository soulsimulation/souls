// #2281: a television has state (off, or on showing one of a small set of pictures) and lights the room while on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kitWhen } from '@souls/generators';
import vocab2 from '../vocab-2.json' with { type: 'json' };
import { TELEVISION_2, TV_CHANNELS } from './television.family.ts';
import { coreLibrary } from '../../library.ts';
import { WorldModel } from '../../model.ts';

type Shape = { when?: string; glow?: number; color?: string; role?: string };
const drawn = (shapes: Shape[], params: Record<string, unknown>, state: Record<string, unknown>) => shapes.filter((s) => kitWhen(s.when, params, state));

test('television@2 adds a channel and a light; @1 keeps its bytes', () => {
  const library = coreLibrary(), old = library.get('core/television@1')!, next = library.get('core/television@2')!;
  assert.deepEqual(vocab2.find((d) => d.name === 'core-television')!.make, old.make, '@1 unchanged');
  const m = new WorldModel({ constants: { ground: 'land' }, seed: 'tv' }); m.library = library;
  assert.equal(next.hash, m.defineDef(TELEVISION_2, 'core', 0).hash);
  assert.deepEqual(next.state.channel, { type: 'enum', values: [...TV_CHANNELS], default: 'garden' });
  assert.equal(next.state.on.default, false);
  assert.deepEqual(next.actions.map((a) => a.name), ['switch-on', 'switch-off', 'change-channel']);
  const change = next.actions.find((a) => a.name === 'change-channel')!;
  assert.deepEqual(change.when, [{ field: 'on', is: true }], 'the channel changes only while on');
  assert.deepEqual(change.then, [{ op: 'cycle', field: 'channel', values: [...TV_CHANNELS] }]);
  assert.equal((next.components.light as { range: number }).range, 3, 'a soft light on the room');
  for (const variant of ['cabinet', 'flat']) { const b = m.bake(next, { variant }, 1); assert.ok(b.tris > 0 && b.tris <= m.constants.limits.budget.tris, `${variant}: ${b.tris} tris`); }
});

test('off the screen is dark glass; on it shows the picture of its channel, glowing, and only that picture', () => {
  const shapes = (TELEVISION_2.make as unknown as { args: { shapes: Shape[] } }).args.shapes;
  for (const variant of ['cabinet', 'flat']) {
    const off = drawn(shapes, { variant }, { on: false, channel: 'sea' }).filter((s) => s.role === 'screen');
    assert.equal(off.length, 1); assert.equal(off[0].glow, undefined); assert.equal(off[0].color, '#0d1114');
    const seen = new Set<string>();
    for (const channel of TV_CHANNELS) {
      const on = drawn(shapes, { variant }, { on: true, channel }).filter((s) => s.role === 'screen');
      assert.ok(on.length >= 3 && on.every((s) => s.glow === 0.9), `${variant} ${channel}`);
      const key = JSON.stringify(on); assert.ok(!seen.has(key), 'each channel is its own picture'); seen.add(key);
    }
  }
});
