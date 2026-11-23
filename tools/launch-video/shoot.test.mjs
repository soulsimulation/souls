// 0.135 P3a: a body's place from its history sample, and a hand-set pose as a shot. The planner itself runs on a scene's
// world with `node tools/launch-video/shoot.mjs --recording <scene dir> --describe` (or a scene with camera.plan).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { frames, pageSources, placeOf, rotate, thingsOf } from './v2-history.mjs';
import { poseShot, TICK_US } from './shoot.mjs';

const Q = 2 ** 30, half = Math.SQRT1_2 * Q;

test('a sample in a turned, moved frame is placed in the world frame', () => {
  assert.deepEqual(rotate([Q, 0, 0, 0], [1, 2, 3]), [1, 2, 3]);
  const r = rotate([half, 0, half, 0], [1, 0, 0]); // a quarter turn about y
  assert.ok(Math.abs(r[0]) < 1e-9 && Math.abs(r[2] + 1) < 1e-9, `${r}`);
  const nodes = [
    { id: 'g.0', parent: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], kind: 'souls:ground' },
    { id: 'h.1', parent: 'g.0', pos: [10e6, 2e6, 0], rot: [half, 0, half, 0], kind: 'eden:house' },
  ];
  const p = placeOf(['b.0', 'h.1', null, 7, 1e6, 0, 0], frames(nodes));
  assert.equal(p.id, 'b.0'); assert.equal(p.at, 7);
  assert.ok(Math.abs(p.p[0] - 10) < 1e-9 && Math.abs(p.p[1] - 2) < 1e-9 && Math.abs(p.p[2] + 1) < 1e-9, `${p.p}`);
});

test('a fixed pose, or one eased to another, is a range of take ticks the page replays', () => {
  const s = poseShot('0,5,10:0,1,0:40>10,5,10:10,1,0', { fromTick: 1000, seconds: 2, aspect: 1.6 });
  assert.equal(s.schema, 'souls-shot/1'); assert.equal(s.fromTick, 1000); assert.equal(s.toTick, 1000 + 2e6 / TICK_US); assert.equal(s.dt, 0.05);
  assert.deepEqual(s.track.samples[0].position, [0, 5, 10]); assert.deepEqual(s.track.samples.at(-1).position, [10, 5, 10]);
  assert.equal(s.track.samples[0].fov, 40);
});

test("a world's things from its public stream, in its facts' shape, and its page's sources over the network", async () => {
  const nodes = [
    { id: 'g.0', parent: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], kind: 'souls:ground' },
    { id: 'h.1', parent: 'g.0', pos: [10e6, 2e6, 0], rot: [half, 0, half, 0], kind: 'eden:house', placeName: 'house', solids: [[0, 0, 500, 500, 0, 0, 2000, 1, 0]] },
    { id: 'p.2', parent: 'g.0', pos: [0, 0, 0], rot: [Q, 0, 0, 0], kind: 'eden:path' },
  ];
  const t = thingsOf(nodes);
  assert.equal(t.length, 1, 'only nodes with solids');
  assert.deepEqual(t[0].world.slice(0, 3).map((x) => Math.round(x)), [10000, 2000, 0]);
  assert.ok(Math.abs(t[0].world[3] - 90000) < 1e-6, `a quarter turn is 90000 mdeg: ${t[0].world[3]}`);
  assert.equal(t[0].name, 'house');
  const server = createServer((req, res) => res.end(req.url === '/w/a/' ? '<script>window.__simConfig={"worldKey":"a","v2Stream":"/s/w/a/views/x/","v2History":"/s/w/a/history/"}</script>' : '<html></html>'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await pageSources(`${at}/w/a/`), { stream: `${at}/s/w/a/views/x/`, history: `${at}/s/w/a/history/` });
    await assert.rejects(pageSources(`${at}/w/old/`), /names no v2Stream/);
  } finally { server.close(); }
});
