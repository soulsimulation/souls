// The camera reel's catalogue (camera tranche, C01) checked against itself, the world templates and the Soul client's
// own argument reader: node --test tools/camera-reel/catalogue.test.mjs. It starts no world.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requestOf } from '../../v2/client/src/cli/souls.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const cat = read('./catalogue.json');
const { scenes } = cat;
const group = (s) => s.kind.split('.')[0];
const FAKE_ID = `${'0'.repeat(32)}-1`;

/** The kinds the plan asks for (tracking issue, section 5). */
const ASKED = ['walk.open-ground', 'walk.street-turns', 'walk.trees-posts', 'walk.narrow-passage', 'walk.u-turn', 'walk.stop-start', 'walk.jog',
  'building.house-in-out', 'building.tiny-room', 'building.large-hall', 'building.stairs',
  'still.bench', 'still.object', 'still.two-talking', 'still.circle-of-four',
  'ride.balloon', 'ride.cable-car', 'ride.big-wheel', 'ride.boat',
  'group.six-in-line', 'group.carry-crew', 'group.field-game', 'group.others-crossing',
  'broadcast.quiet', 'broadcast.busy'];

test('30 to 45 scenes, numbered in order, each 20 to 45 s (a Broadcast session three minutes)', () => {
  assert.ok(scenes.length >= 30 && scenes.length <= 45, String(scenes.length));
  assert.equal(new Set(scenes.map((s) => s.id)).size, scenes.length);
  scenes.forEach((s, k) => {
    assert.equal(s.n, k + 1, s.id);
    if (group(s) === 'broadcast') assert.deepEqual([s.length_s, s.camera.mode], [180, 'broadcast'], s.id);
    else assert.ok(s.length_s >= 20 && s.length_s <= 45 && s.camera.mode === 'follow' && s.souls.includes(s.camera.subject), s.id);
    assert.ok(s.shape in cat.conventions.shape && ['day', 'dusk', 'night'].includes(s.light) && s.why, s.id);
  });
});

test('the six worlds, every kind asked for, three lights and both shapes are covered', () => {
  assert.deepEqual([...new Set(scenes.map((s) => s.world))].sort(), Object.keys(cat.worlds).sort());
  assert.deepEqual(Object.keys(cat.worlds).sort(), ['eden-2026', 'eden-district', 'hello-hamlet', 'littlemartians-two', 'mars-camp', 'mars-two']);
  const kinds = new Set(scenes.map((s) => s.kind));
  assert.deepEqual(ASKED.filter((k) => !kinds.has(k)), []);
  for (const light of ['day', 'dusk', 'night']) assert.ok(scenes.filter((s) => s.light === light).length >= 5, light);
  for (const shape of ['portrait', 'landscape']) assert.ok(scenes.filter((s) => s.shape === shape).length >= 10, shape);
});

test('held out: every third scene by number, across all worlds and kind groups, no asked kind only there', () => {
  for (const s of scenes) assert.equal(s.set, s.n % 3 === 0 ? 'held-out' : 'tuning', s.id);
  const held = scenes.filter((s) => s.set === 'held-out'), tuning = scenes.filter((s) => s.set === 'tuning');
  assert.equal(held.length * 3, scenes.length);
  assert.equal(new Set(held.map((s) => s.world)).size, 6);
  assert.deepEqual([...new Set(held.map(group))].sort(), [...new Set(scenes.map(group))].sort());
  const tuned = new Set(tuning.map((s) => s.kind));
  assert.deepEqual(ASKED.filter((k) => !tuned.has(k)), []);
});

test('each named failure has at least two scenes made to provoke it, two of them in the tuning set', () => {
  assert.deepEqual(Object.keys(cat.failures).sort(), ['balloon-jutting', 'cropped-head', 'forced-climb', 'glide-round-building', 'wall-pass', 'zigzag']);
  const known = new Set([...cat.measures, ...cat.detectors].map((m) => m.id));
  for (const [name, f] of Object.entries(cat.failures)) {
    assert.ok(known.has(f.detector), `${name}: ${f.detector}`);
    assert.ok(scenes.filter((s) => s.set === 'tuning' && s.provokes.includes(name)).length >= 2, name);
  }
  for (const s of scenes) for (const p of s.provokes) assert.ok(p in cat.failures, `${s.id}: ${p}`);
});

test('every thing a scene names is in its world\'s template, once', () => {
  const placed = new Map();
  for (const [world, w] of Object.entries(cat.worlds)) {
    const ops = read(`../../${w.template}`).batches.flatMap((b) => b.ops).filter((o) => o.op === 'place' && o.name);
    const tmp = new Map(ops.filter((o) => o.tmp).map((o) => [o.tmp, o.name]));
    placed.set(world, ops.map((o) => ({ name: o.name, in: tmp.get(o.in?.parent) ?? o.in?.parent ?? null })));
    assert.doesNotThrow(() => read(`../../${w.map}`), w.map);
  }
  for (const s of scenes) {
    for (const t of [...Object.values(s.things ?? {}), ...Object.values(s.fallback?.things ?? {})]) {
      const found = placed.get(s.world).filter((p) => p.name === t.name && (!t.in || p.in === t.in));
      assert.equal(found.length, 1, `${s.id}: ${t.name}${t.in ? ` in ${t.in}` : ''}`);
    }
  }
});

test('every command is one the Soul client reads, with its things, Souls and captured values named', () => {
  for (const s of scenes) {
    const captured = new Set();
    const lists = [['setup', s.setup], ['steps', s.steps], ['fallback', s.fallback?.setup ?? []]];
    for (const [where, list] of lists) {
      if (where !== 'setup') for (const step of s.setup) for (const v of Object.keys(step.capture ?? {})) captured.add(v);
      for (const step of list) {
        const at = `${s.id} ${where} ${step.cmd.join(' ')}`;
        assert.ok(s.souls.includes(step.who), at);
        if (where === 'steps') assert.ok((typeof step.t === 'number' && step.t >= 0 && step.t < s.length_s) || step.after === 'prev', at);
        const words = step.cmd.map((w) => w
          .replace(/@([a-z0-9-]+)/g, (_, a) => { assert.ok(s.things?.[a], `${at}: @${a}`); return FAKE_ID; })
          .replace(/^\$([a-f])$/, (_, a) => { assert.ok(s.souls.includes(a), `${at}: $${a}`); return FAKE_ID; })
          .replace(/\{([a-z]+)\}/g, (_, v) => { assert.ok(captured.has(v), `${at}: {${v}}`); return FAKE_ID; }));
        const read = requestOf(words);
        assert.ok(read.req && !read.refused, `${at}: ${JSON.stringify(read)}`);
        if (where === 'setup') for (const v of Object.keys(step.capture ?? {})) captured.add(v);
      }
    }
    if (s.record) assert.deepEqual([s.record.start, /^(ride|sail):@/.test(s.setup.at(-1).cmd[1])], ['takeoff', true], s.id);
  }
});

test('the eight measures each have a formula, the subjects it applies to and a target, over fields the log has', () => {
  assert.deepEqual(cat.measures.map((m) => m.id), ['overhead', 'forced-climbs', 'zigzags', 'head-outside', 'good-angle', 'sky', 'cuts', 'cost']);
  for (const m of cat.measures) assert.ok(m.formula && m.applies && m.target && m.unit, m.id);
  const fields = [...cat.log.frame, ...cat.log.subject, ...cat.log.optional].flatMap(([names]) => names.split(', '));
  assert.equal(new Set(fields).size, fields.length);
  for (const f of ['high', 'cut', 'user', 'mode', 'cost', 'sky', 'riding', 'indoors', 'th', 'hd', 'by', 'fx', 'blocked']) assert.ok(fields.includes(f), f);
});
