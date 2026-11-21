// W4 (#2748): the Souls copy (names kept across parts, speech for the time its record gives, status, recent events)
// and A3: an utterance holding markup and an address is drawn as plain text, on the canvas and on a Soul's page, with
// no element and no link made from it. A minimal stand-in for the DOM records every element made and every text set.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { reconcileSnapshot, type NodeRec, type SaidRec } from '../source/source.ts';
import { SoulsCopy, spoken, wrap } from './souls.ts';
import { place } from './layer.ts';

const body = (id: string, extra: Partial<NodeRec> = {}): NodeRec => ({ id, kind: 'souls:body@1', parent: 'room', slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...extra });
const said = (speaker: string, at: number, words: string | null, length = 2_000_000): SaidRec => ({ speaker, at, length, reach: 5_000, ref: `r${at}`, words });
const none = { nodes: new Map<string, NodeRec>(), tracks: new Map() };

test('names stay across parts that do not carry them; speech shows for its length; status is derived', () => {
  const c = new SoulsCopy();
  c.apply({ nodes: [body('a.1', { name: 'Oriel', description: 'keeps the lamps' }), body('b.2'), { ...body('lamp.3'), kind: 'r2:lamp' }], removed: [], to: 0 });
  assert.deepEqual([...c.souls.keys()], ['a.1', 'b.2']);
  c.apply({ nodes: [body('a.1')], removed: [], said: [said('a.1', 10_000_000, 'hello'), said('b.2', 10_000_000, null)], to: 11_000_000 });
  assert.equal(c.souls.get('a.1')!.name, 'Oriel');
  assert.equal(c.speaking(9_999_999).size, 0);
  assert.equal(c.speaking(11_000_000).get('a.1')!.words, 'hello');
  assert.equal(c.speaking(12_000_000).size, 0, 'gone when its length is over');
  assert.ok(!c.speaking(11_000_000).has('b.2'), 'words not in the public file are not drawn');
  assert.equal(c.status('a.1', 11_000_000, none), 'speaking');
  assert.equal(c.status('a.1', 13_000_000, none), 'standing');
  const seated = { nodes: new Map([['a.1', body('a.1', { slot: 2 })]]), tracks: new Map() };
  assert.equal(c.status('a.1', 13_000_000, seated), 'seated');
  const moving = { nodes: new Map(), tracks: new Map([['a.1', { samples: [{ at: 12_000_000 }, { at: 13_500_000 }] }]]) };
  assert.equal(c.status('a.1', 13_000_000, moving), 'walking');
  for (let i = 0; i < 12; i++) c.apply({ nodes: [], removed: [], said: [said('a.1', 20_000_000 + i, `line ${i}`)], to: 21_000_000 });
  const p = c.page('a.1', 30_000_000, none)!;
  assert.equal(p.recent.length, 8);
  assert.equal(p.recent[0].words, 'line 11', 'newest first');
  c.apply({ nodes: [], removed: ['a.1'], to: 22_000_000 });
  assert.equal(c.page('a.1', 30_000_000, none), null);
});

test('checkpoint snapshot reconciles nodes without pruning speech or advancing event time', () => {
  const c = new SoulsCopy();
  c.apply({ nodes: [body('a.1', { name: 'original' })], removed: [], said: [said('a.1', 10_000_000, 'still speaking')], to: 11_000_000 });
  const before = c.page('a.1', 11_000_000, none)!.recent;
  c.snapshot([body('a.1', { name: 'checkpoint name' }), body('b.2')], []);
  assert.equal(c.souls.get('a.1')!.name, 'checkpoint name');
  assert.equal(c.speaking(11_000_000).get('a.1')!.words, 'still speaking');
  assert.deepEqual(c.page('a.1', 11_000_000, none)!.recent, before);
  c.snapshot([], ['b.2']); assert.ok(!c.souls.has('b.2'));
  assert.equal(c.speaking(11_000_000).size, 1, 'node reconciliation cannot expire an existing utterance');
});

test('a fresh worker full snapshot removes retained older nodes on history-to-live or source restart', () => {
  const old = body('old.1'), kept = body('kept.2'), added = body('added.3');
  const retained = new Map([[old.id, old], [kept.id, kept]]);
  const c = new SoulsCopy(); c.snapshot([...retained.values()], []);
  // A new worker has no previous copy, so its own removed list is empty. Actual caller state is authoritative.
  const snapshot = reconcileSnapshot(retained.keys(), { nodes: [kept, added], removed: [] });
  assert.deepEqual(snapshot.removed, [old.id]);
  for (const id of snapshot.removed) retained.delete(id);
  for (const node of snapshot.nodes) retained.set(node.id, node);
  c.snapshot(snapshot.nodes, snapshot.removed);
  assert.deepEqual([...retained.keys()], [kept.id, added.id]); assert.deepEqual([...c.souls.keys()], [kept.id, added.id]);
  assert.deepEqual(reconcileSnapshot(retained.keys(), { nodes: [added], removed: ['explicit.4'] }).removed, ['explicit.4', kept.id]);
  assert.deepEqual(reconcileSnapshot(retained.keys(), { nodes: [], removed: [] }).removed, [kept.id, added.id], 'a valid empty drawable snapshot replaces the older view');
});

test('labels give way far first, speech before chips, never overlapping', () => {
  const w = (s: string) => s.length * 7;
  const cands = [
    { id: 'far', x: 100, y: 100, dist: 50, chip: 'Far', status: 'standing', speech: null },
    { id: 'near', x: 104, y: 100, dist: 5, chip: 'Near', status: 'standing', speech: null },
    { id: 'talk', x: 400, y: 300, dist: 80, chip: 'Talk', status: 'speaking', speech: 'hi there' },
    { id: 'off', x: -500, y: 100, dist: 1, chip: 'Off', status: 'standing', speech: null },
  ];
  const placed = place(cands, w, (s) => wrap(s, 240, w), 800, 600);
  assert.deepEqual(placed.map((p) => p.id), ['talk', 'near']);
  assert.deepEqual(wrap('one two three four five six', 50, w, 2), ['one two', 'three…']);
});

// A3: a stand-in DOM and canvas that record what the page makes.
test('A3: markup and an address in an utterance are drawn as plain text, with no element or link made from them', async () => {
  const made: string[] = [];
  const texts: string[] = [];
  const drawn: string[] = [];
  class El {
    tag: string;
    style = { cssText: '', display: '' };
    children: El[] = [];
    private text = '';
    width = 0;
    height = 0;
    constructor(tag: string) {
      this.tag = tag;
      made.push(tag);
    }
    set textContent(s: string) {
      this.text = s;
      texts.push(s);
    }
    get textContent() {
      return this.text;
    }
    set innerHTML(_: string) {
      throw new Error('innerHTML is never set');
    }
    setAttribute() {}
    append(...c: El[]) {
      this.children.push(...c);
    }
    replaceChildren(...c: El[]) {
      this.children = c;
    }
    after() {}
    addEventListener() {}
    getContext() {
      return {
        font: '', fillStyle: '', textBaseline: 'top',
        measureText: (s: string) => ({ width: s.length * 4 }),
        fillText: (s: string) => drawn.push(s),
        fillRect() {}, clearRect() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {},
      };
    }
  }
  const doc = { body: new El('body'), createElement: (t: string) => new El(t) };
  // C14: the open Soul's status line comes from the directory by its grant, and is set as text like the rest.
  const grant = `soul-${'cd'.repeat(16)}-4`, asked: string[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    asked.push(`${url} ${init.body}`);
    return new Response(url === '/v1/account/now' ? JSON.stringify({ now: { [grant]: { text: '<script>alert(2)</script> mending nets', at: Math.floor(Date.now() / 1000) } } }) : '{}');
  };
  Object.assign(globalThis, { document: doc, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener() {}, fetch });
  made.length = 0;
  const { pageSouls } = await import('./page.ts');

  const hostile = '<a href="https://example.com/x">click</a> <script>alert(1)</script> <b>bold</b> www.example.com';
  const at = 5_000_000;
  const nodes = new Map([['s.1', body('s.1', { name: '<img src=x onerror=alert(1)>', soul: grant })]]);
  const world = { nodes, tracks: new Map(), frame: () => new THREE.Matrix4() };
  const souls = pageSouls(new El('canvas') as never, world as never, new URLSearchParams('soul=s.1'));
  souls.apply({ number: 1, from: 0, to: at + 1, nodes: [...nodes.values()], removed: [], samples: [], hash: null, said: [said('s.1', at, hostile, 30_000_000)] });
  const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 1000);
  camera.position.set(0, 3, 10);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld();
  souls.draw(at + 1_000_000, camera);

  // The canvas: the words drawn by fillText, as they are, in lines; the name as it is.
  assert.equal(drawn.join(' '), hostile, `drawn: ${JSON.stringify(drawn)}`);
  souls.open('s.1');
  souls.draw(at + 2_000_000, camera);
  await new Promise((r) => setTimeout(r, 20));
  souls.draw(at + 2_100_000, camera);
  assert.ok(asked.includes(`/v1/account/now {"souls":["${grant}"]}`), asked.join('\n'));
  assert.ok(texts.includes('“<script>alert(2)</script> mending nets” · just now'), JSON.stringify(texts));
  // The Soul's page: the name and the sentence as text, and the only elements are the page's own.
  assert.ok(texts.includes('<img src=x onerror=alert(1)>'));
  assert.ok(texts.some((t) => t.endsWith(`said “${hostile}”`)));
  assert.deepEqual([...new Set(made)].sort(), ['aside', 'button', 'canvas', 'h2', 'li', 'ol', 'p']);
  assert.ok(!made.includes('a') && !made.includes('script') && !made.includes('img') && !made.includes('b'));
});

test('C26: a line that carries farther than talk is shown as a shout', () => {
  const line = (reach: number): SaidRec => ({ speaker: 'a', at: 0, length: 1e6, reach, ref: 'r', words: 'the bridge is out' });
  assert.equal(spoken(line(5_000)), 'the bridge is out');
  assert.equal(spoken(line(12_000)), '(shouts) the bridge is out');
});
