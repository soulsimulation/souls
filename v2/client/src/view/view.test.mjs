// #3687: `view` gives today's sight as words, its picture and a map, read from the page on this machine. The browser
// is a stand-in here (its page runs `gather` against a small drawn world in this process); the real one is in the proof.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { caption, clearLine, compassOf, computeSight, sideOf } from './sight.mjs';
import { copyId, copyNames, gather, parseView, runView } from './view.mjs';

const ME = { id: 'a.1', name: 'Oriel', p: [0, 0, 0], room: null, inside: false };
// Eyes at the origin looking north (−z): east (+x) is right.
const base = (more = {}) => ({ clock: '12:00', me: ME, eye: [0, 1.6, 0], target: [0, 1, -10], bodies: [], things: [], areas: [], blocks: [], ...more });

test('the words: ahead, left and right, near and far, as today', () => {
  const s = computeSight(base({
    bodies: [{ id: 'a.2', name: 'Bea', p: [1.5, 0, -4] }, { id: 'a.3', name: 'Cal', p: [0, 0, 8] }],
    things: [{ id: 'a.4', name: 'bench 4', p: [-2, 0, -3] }, { id: 'a.5', name: 'tavern 5', p: [10, 0, -60], place: true }],
    areas: [{ id: 'a.6', name: 'the green', outline: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }],
  }));
  assert.equal(s.heading.compass, 'north');
  assert.deepEqual(s.souls.map((o) => [o.name, o.side]), [['Bea', 'right']], 'Cal is behind');
  assert.deepEqual(s.things.map((t) => [t.name, t.side, t.kind]), [['bench 4', 'far left', 'thing'], ['tavern 5', 'right', 'place']]);
  assert.match(s.alt, /^Oriel sees this, at the green, looking north \(12:00, day\)\. Left to right: the bench 4 3\.6 m far left; Bea, 4\.3 m right\. Further off: the tavern 5 61 m right\. One other person is in view\./);
  assert.match(s.alt, /nothing behind, nothing through walls\.$/);
});

test('walls hide, low things and a thing\'s own solids do not; rooms keep their own', () => {
  const wall = { owner: 'a.9', poly: [[-5, -6], [5, -6], [5, -5.5], [-5, -5.5]], room: null };
  const s = computeSight(base({ bodies: [{ id: 'a.2', name: 'Bea', p: [0, 0, -10] }], things: [{ id: 'a.9', name: 'shed 9', p: [0, 0, -5.8] }], blocks: [wall] }));
  assert.equal(s.souls.length, 0, 'behind the wall');
  assert.deepEqual(s.things.map((t) => t.name), ['shed 9'], 'its own wall does not hide it');
  assert.equal(clearLine([wall], [0, 0], [0, -4]), true);
  const inside = computeSight(base({ me: { ...ME, room: 'r.1', inside: true, roomName: 'room 1', buildingName: 'inn 3' }, bodies: [{ id: 'a.2', name: 'Bea', p: [1, 0, -3], room: 'r.1' }, { id: 'a.3', name: 'Cal', p: [-1, 0, -3], room: null }] }));
  assert.deepEqual(inside.souls.map((o) => o.name), ['Bea'], 'out of the room is out of sight');
  assert.match(inside.alt, /inside inn 3 \(room 1\), looking north \(12:00, day, indoors\)/);
  const upstairs = computeSight(base({ bodies: [{ id: 'a.2', name: 'Bea', p: [0, 4, -3] }] }));
  assert.equal(upstairs.souls.length, 0, 'another level');
});

test('night shortens sight; repeated things are one line', () => {
  const far = { id: 'a.2', name: 'Bea', p: [0, 0, -20] };
  assert.equal(computeSight(base({ bodies: [far] })).souls.length, 1);
  const night = computeSight(base({ clock: '23:30', bodies: [far] }));
  assert.equal(night.souls.length, 0);
  assert.match(night.alt, /23:30, night \(dark: only nearby things are clear\)/);
  const chairs = computeSight(base({ things: [1, 2, 3].map((k) => ({ id: `a.${k + 10}`, name: `chair ${k + 10}`, p: [k - 2, 0, -4] })) }));
  assert.equal(chairs.things.length, 1);
  assert.match(chairs.alt, /3 × chair \(nearest chair 12, 4 m ahead\)/);
});

test('compass and sides are today\'s', () => {
  assert.equal(compassOf(1, 0).compass, 'east');
  assert.equal(compassOf(0, 1).compass, 'south');
  assert.deepEqual([-0.7, -0.3, -0.1, 0, 0.1, 0.3, 0.7].map((r) => sideOf(r)), ['far left', 'left', 'ahead-left', 'ahead', 'ahead-right', 'right', 'far right']);
  assert.match(caption({ heading: { compass: 'west' }, where: { inside: false, place: null }, light: { clock: null, label: 'day' }, souls: [], things: [] }, 'X'), /^X sees this, outdoors, looking west \(day\)\. Nobody else is in view\./);
});

test('the arguments: --alt-only, --out, --map and map, --small', () => {
  assert.deepEqual([parseView([]).out, parseView([]).size], ['view.jpg', [1280, 720]]);
  assert.equal(parseView(['--alt-only']).out, null);
  assert.deepEqual([parseView([], { map: true }).out, parseView(['--map']).size], ['map.jpg', [768, 768]]);
  assert.equal(parseView(['--out', 'me.png', '--small']).size[0], 640);
  assert.throws(() => parseView(['--map', '--alt-only']), { code: 'usage' });
  assert.throws(() => parseView(['--out', 'x.gif']), { code: 'usage' });
  assert.throws(() => parseView(['left']), { code: 'usage' });
});

test('names come from the copy, by id', async () => {
  assert.equal(copyId('ab.12'), 'ab-12');
  const ask = async (r) => ({ found: [{ id: 'ab-120', name: 'other' }, { id: r.words, name: `named ${r.words}` }] });
  assert.deepEqual([...await copyNames(['ab.12', 'ab.12'], ask)], [['ab.12', 'named ab-12']]);
  assert.equal((await copyNames(['ab.12'], null)).size, 0);
});

// A drawn world in this process: frames are translations (Matrix4-like elements), the camera a stand-in.
function drawn() {
  const frame = (x, y, z) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] });
  const nodes = new Map([
    ['s.0', { id: 's.0', kind: 'eden:ground@x', parent: null, at: null }],
    ['s.1', { id: 's.1', kind: 'souls:body@x', parent: 's.0', at: 1, soul: 'soul-ab-7' }],
    ['s.2', { id: 's.2', kind: 'souls:body@x', parent: 's.0', at: 1 }],
    ['s.3', { id: 's.3', kind: 'eden:bench@x', parent: 's.0', at: null, solids: [[0, 0, 500, 200, 0, 0, 500]] }],
    ['s.4', { id: 's.4', kind: 'eden:wall@x', parent: 's.0', at: null, solids: [[0, 0, 5000, 200, 0, 0, 3000]] }],
    ['s.5', { id: 's.5', kind: 'eden:place@x', parent: 's.0', at: null, outline: [[-40000, -40000], [40000, -40000], [40000, 40000], [-40000, 40000]] }],
    ['s.6', { id: 's.6', kind: 'eden:room@x', parent: 's.0', at: null, outline: [[-5000, -30000], [5000, -30000], [5000, -20000], [-5000, -20000]] }],
  ]);
  const pos = { 's.0': [0, 0, 0], 's.1': [0, 0, 0], 's.2': [1, 0, -12], 's.3': [-1, 0, -3], 's.4': [0, 0, -8], 's.5': [0, 0, 0] };
  const names = { 's.1': 'Oriel', 's.2': 'Bea', 's.3': 'bench 3', 's.4': 'wall 4', 's.5': 'place 5' };
  const cam = { at: null, camera: { position: { set: (...p) => (cam.at = p) }, lookAt() {} }, controls: { target: { set() {} }, update() {} } };
  globalThis.v2 = {
    world: { nodes, tracks: new Map(), frame: (id) => frame(...(pos[id] ?? [0, 0, 0])) },
    director: { t: Date.UTC(2026, 10, 21, 14, 5) * 1000, free() {} },
    cam,
    capture: {
      where: () => [...nodes.values()].filter((n) => n.id !== 's.0').map((n) => ({ id: n.id, name: names[n.id], role: /body/.test(n.kind) ? 'soul' : 'thing' })),
      aim: (id) => (id === 's.1' || id === 'Oriel' ? { spot: { id: 's.1', name: 'Oriel', role: 'soul' }, aim: { eye: [0, 1.6, -0.35], target: [0, 1, -10.35] } } : null),
    },
  };
  const shots = [];
  const page = { evaluate: async (f, arg) => f(arg), screenshot: async (o) => shots.push(o) };
  const pw = { chromium: { launchPersistentContext: async () => ({ pages: () => [page], clearCookies: async () => {}, close: async () => {} }) } };
  page.goto = async () => {}; page.waitForFunction = async () => {};
  return { pw, shots, cam };
}
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };

test('A1, A3: the page\'s drawn moment as words, the Soul found by its grant, names asked of the daemon', async () => {
  const { pw, shots } = drawn();
  const home = mkdtempSync(join(tmpdir(), 'view-'));
  const asked = [];
  const ask = async (r) => (asked.push(r.op), { found: r.words === 's-2' ? [] : [{ id: r.words, name: r.words === 's-3' ? 'the oak bench' : r.words }] });
  const a = await runView(['--alt-only', '--page', 'https://soul.example/v2/'], { home, pw, ask, who: { soul: 'oriel', grant: 'soul-ab-7' } });
  assert.equal(a.soul, 'oriel');
  assert.equal(a.heading, 'north');
  assert.deepEqual(a.sees, [], 'Bea stands behind the wall');
  assert.match(a.alt, /^Oriel sees this, at s-5, looking north \(14:05, day\)\. Left to right: the oak bench 2\.8 m left; the s-4 7\.7 m ahead\. Nobody else is in view\./);
  assert.equal(shots.length, 0, '--alt-only takes no picture');
  assert.ok(asked.every((op) => op === 'find'));
  const g = gather.call(null, ['soul-ab-7', null, 130]);
  assert.deepEqual(g.blocks.map((b) => b.owner), ['s.4'], 'a bench is low');
  assert.deepEqual(g.areas.map((a) => a.id), ['s.5'], 'a room is no landmark');
});

test('A2: the picture from the eyes, and the map from overhead', async () => {
  const { pw, shots, cam } = drawn();
  const home = mkdtempSync(join(tmpdir(), 'view-')), cwd = mkdtempSync(join(tmpdir(), 'view-'));
  const v = await runView(['--page', 'https://soul.example/v2/'], { home, cwd, pw, who: { soul: 'oriel', grant: 'soul-ab-7' } });
  assert.equal(v.saved, join(cwd, 'view.jpg'));
  assert.equal(shots.at(-1).type, 'jpeg');
  const m = await runView(['--page', 'https://soul.example/v2/', '--out', 'here.png'], { home, cwd, pw, map: true, who: { soul: 'oriel', grant: 'soul-ab-7' } });
  assert.equal(m.saved, join(cwd, 'here.png'));
  assert.equal(shots.at(-1).type, 'png');
  assert.deepEqual(cam.at, [0, 60, 1.2], 'overhead, north up');
  await assert.rejects(runView(['--page', 'https://soul.example/v2/'], { home, pw, who: { grant: 'soul-ab-9' } }), { code: 'body-not-drawn' });
});

test('with no browser: the brief and why', async () => {
  const home = mkdtempSync(join(tmpdir(), 'view-'));
  const r = await runView(['--page', 'https://soul.example/v2/'], { home, pw: null, who: { soul: 'oriel', grant: 'soul-ab-7' }, ask: async () => ({ room: { name: 'room 1' } }) });
  assert.equal(r.picture, null);
  assert.match(r.why, /No headless browser/);
  assert.deepEqual(r.words.brief, { room: { name: 'room 1' } });
});
