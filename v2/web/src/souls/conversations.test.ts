// N-V21 (#3678): spectators see public conversations in a dock and their members framed. The thread model folds
// public lines as today's aloud scenes; whispers and private turns (no words in the public view) never show; a part
// played again after a reconnect folds once; the dock and a Soul's page show the thread as text; opening a thread
// frames its members.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec, SaidRec } from '../source/source.ts';
import { Conversations, GAP_US, groupShot } from './layer.ts';

const said = (speaker: string, at: number, words: string | null, ref = `r${speaker}${at}`): SaidRec => ({ speaker, at, length: 2_000_000, reach: 12_000, ref, words });
const spots: Record<string, [number, number, number]> = { a: [0, 0, 0], b: [2, 0, 0], c: [3, 0, 1], far: [100, 0, 0] };
const where = (id: string) => (spots[id] ? { x: spots[id][0], y: spots[id][1], z: spots[id][2] } : null);
const ids = Object.keys(spots);

test('public lines fold into one thread per scene; far talk is its own; a gap ends a scene', () => {
  const c = new Conversations();
  const t1 = c.add(said('a', 1e6, 'hello'), where, ids)!;
  assert.equal(c.add(said('b', 2e6, 'hi a'), where, ids), t1, 'b was within reach of a');
  const far = c.add(said('far', 3e6, 'alone'), where, ids)!;
  assert.notEqual(far, t1);
  assert.deepEqual(Conversations.members(t1), ['a', 'b']);
  assert.ok(t1.hearers.has('c'), 'c heard it without speaking');
  assert.deepEqual(c.of('b').map((t) => t.id), [t1.id]);
  const later = c.add(said('a', 2e6 + GAP_US + 1, 'back again'), where, ids)!;
  assert.notEqual(later, t1, 'a new scene after the gap');
});

test('A2: a line without public words (a whisper, a private turn) never shows; A3: a replayed part folds once', () => {
  const c = new Conversations();
  assert.equal(c.add(said('a', 1e6, null), where, ids), null);
  assert.equal(c.threads.size, 0);
  const t = c.add(said('a', 2e6, 'one'), where, ids)!;
  const v = c.version;
  assert.equal(c.add(said('a', 2e6, 'one'), where, ids), null, 'the same line again after a reconnect');
  assert.equal(c.version, v);
  c.add(said('b', 1.5e6, 'earlier, arrived late'), where, ids);
  assert.deepEqual(t.lines.map((l) => l.words), ['earlier, arrived late', 'one'], 'kept in time order');
});

test('a group shot holds every member and looks at their middle from the camera side', () => {
  const pts = [{ x: 0, y: 2, z: 0 }, { x: 4, y: 2, z: 0 }];
  const s = groupShot(pts, 50, 16 / 9, { x: 2, y: 10, z: 30 })!;
  assert.deepEqual(s.target, { x: 2, y: 2, z: 0 });
  assert.ok(s.eye.z > 4 && Math.abs(s.eye.x - 2) < 1e-9, `from the camera's side: ${JSON.stringify(s.eye)}`);
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  cam.position.set(s.eye.x, s.eye.y, s.eye.z);
  cam.lookAt(s.target.x, s.target.y, s.target.z);
  cam.updateMatrixWorld();
  for (const p of pts) {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(cam);
    assert.ok(Math.abs(v.x) < 1 && Math.abs(v.y) < 1, 'member in view');
  }
  assert.equal(groupShot([], 50, 1, { x: 0, y: 0, z: 0 }), null);
});

test('the dock and the Soul page show a thread as text, live; opening it frames its members', async () => {
  const texts: string[] = [];
  class El {
    tag: string;
    style: Record<string, string> = { cssText: '', display: '' };
    dataset: Record<string, string> = {};
    children: El[] = [];
    onclick: (() => void) | null = null;
    scrollTop = 0; scrollHeight = 0; clientHeight = 0;
    private text = '';
    constructor(tag: string) { this.tag = tag; }
    set textContent(s: string) { this.text = s; texts.push(s); }
    get textContent() { return this.text; }
    set innerHTML(_: string) { throw new Error('innerHTML is never set'); }
    setAttribute() {}
    append(...c: El[]) { this.children.push(...c); }
    replaceChildren(...c: El[]) { this.children = c; }
    after() {}
    addEventListener() {}
    getContext() {
      return { font: '', fillStyle: '', textBaseline: 'top', measureText: (s: string) => ({ width: s.length * 4 }), fillText() {}, fillRect() {}, clearRect() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} };
    }
  }
  const doc = { body: new El('body'), createElement: (t: string) => new El(t) };
  Object.assign(globalThis, { document: doc, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener() {} });
  const { pageSouls } = await import('./page.ts');
  const body = (id: string, name: string, x: number): NodeRec => ({ id, kind: 'souls:body@1', parent: null, slot: null, pos: [x * 1e6, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, name });
  const nodes = new Map([['a.1', body('a.1', 'Ada', 0)], ['b.2', body('b.2', 'Bo', 2)], ['w.3', body('w.3', 'Wren', 1)]]);
  const world = { nodes, tracks: new Map(), frame: (id: string | null) => new THREE.Matrix4().makeTranslation(id ? nodes.get(id)!.pos[0] / 1e6 : 0, 0, 0) };
  const souls = pageSouls(new El('canvas') as never, world as never, new URLSearchParams('soul=a.1'));
  const part = (n: number, s: SaidRec[]) => ({ number: n, from: 0, to: 20e6, nodes: [...nodes.values()], removed: [], samples: [], hash: null, said: s });
  souls.apply(part(1, [said('a.1', 5e6, 'Shall we walk?'), said('w.3', 5.5e6, null)]));
  souls.apply(part(2, [said('b.2', 6e6, 'Yes, to the lake')]));
  souls.apply(part(2, [said('b.2', 6e6, 'Yes, to the lake')])); // replayed after a reconnect
  const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 1000);
  camera.position.set(1, 3, 12);
  camera.lookAt(1, 2, 0);
  camera.updateMatrixWorld();
  const framed: THREE.Vector3[][] = [];
  souls.framer = (eye, target) => framed.push([eye, target]);
  souls.draw(7e6, camera);
  // The group button over the two speakers, and the Soul page's own conversations.
  const all = (e: El): El[] => [e, ...e.children.flatMap(all)];
  const els = all(doc.body);
  const marker = els.find((e) => e.tag === 'button' && e.dataset.thread)!;
  assert.ok(marker && marker.style.display === 'block', 'a button over the live group');
  const row = els.find((e) => e.tag === 'button' && e.textContent.startsWith('With Bo'))!;
  assert.equal(row.textContent, 'With Bo · Bo: Yes, to the lake');
  row.onclick!();
  souls.draw(7.1e6, camera);
  const dock = els.find((e) => e.tag === 'aside' && e.children.some((c) => c.tag === 'ol' && c !== undefined) && e.style.cssText.includes('left:12px'))!;
  assert.equal(dock.style.display, 'flex');
  const lines = dock.children.find((c) => c.tag === 'ol')!.children.map((li) => li.textContent);
  assert.deepEqual(lines, ['Ada: Shall we walk?', 'Bo: Yes, to the lake'], 'members and turns, once each, no whisper');
  assert.equal(dock.children[1].textContent, 'Ada & Bo');
  assert.ok(!texts.some((t) => t.includes('Wren:')), 'the line without public words is never shown');
  assert.equal(framed.length, 1, 'opening from the page frames the members');
  assert.ok(Math.abs(framed[0][1].x - 1) < 1e-6, 'looking at their middle');
  // Live: a new turn shows in the open dock.
  souls.apply(part(3, [said('a.1', 8e6, 'Bring the lamp')]));
  souls.draw(8.5e6, camera);
  assert.equal(dock.children.find((c) => c.tag === 'ol')!.children.at(-1)!.textContent, 'Ada: Bring the lamp');
  // A reconnect's snapshot keeps the thread and the open dock.
  souls.snapshot([...nodes.values()], []);
  souls.draw(9e6, camera);
  assert.equal(dock.style.display, 'flex');
  assert.equal(dock.children.find((c) => c.tag === 'ol')!.children.length, 3);
  souls.converse(null);
  souls.draw(9.1e6, camera);
  assert.equal(dock.style.display, 'none');
});
