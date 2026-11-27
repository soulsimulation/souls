import test from 'node:test';
import assert from 'node:assert/strict';
import { kindBounds } from './vite.config.ts';

test('physical entries with roles retain their shape, state and declared slot posture; activities stay object-free', async () => {
  const plugin = kindBounds(), emitted = new Map<string, string>();
  const context = { addWatchFile() {}, emitFile(a: { name: string; source: string }) { emitted.set(a.name, a.source); return a.name; } };
  const resolved = plugin.configResolved as (c: {command: string}) => void;
  resolved({command: 'build'});
  const transform = plugin.transform as (this: typeof context, code: string, id: string) => {code: string};
  const out = transform.call(context, '', '/src/v2-engine/source/kind-bounds.ts').code;
  const table = (name: string) => JSON.parse(out.match(new RegExp(`export const ${name} = (.*);`))![1]);
  assert.deepEqual(table('KIND_BOUNDS')['eden:hall_lecture'], [1600, 1300, 1200]);
  assert.equal(table('KIND_BOUNDS')['eden:lecture'], undefined, 'a logical lecture has no physical bounds');
  assert.deepEqual(table('KIND_SLOTS')['eden:hall_lecture'], [{row: [1, 0, 100, -350, 0, 1], posture: 'stand'}]);
  assert.equal(table('KIND_SLOTS')['eden:chair'][0].posture, 'sit');
  const looks = JSON.parse(emitted.get('kind-looks.json')!);
  assert.ok(looks['eden:hall_lecture'].looks.shape.shapes.length);
  assert.equal(looks['eden:lecture'], undefined);
  assert.equal(JSON.parse(emitted.get('kind-state.json')!)['eden:hall_lecture'].phase[0], 28);
});
