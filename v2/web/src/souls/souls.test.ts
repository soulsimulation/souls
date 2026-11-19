// W4 (#2748): the Souls copy (names kept across parts, speech for the time its record gives, status, recent events)
// and A3: an utterance holding markup and an address is drawn as plain text, on the canvas and on a Soul's page, with
// no element and no link made from it. A minimal stand-in for the DOM records every element made and every text set.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec, SaidRec } from '../source/source.ts';
import { SoulsCopy, wrap } from './souls.ts';
import { place } from './layer.ts';

const body = (id: string, extra: Partial<NodeRec> = {}): NodeRec => ({ id, kind: 'souls:body@1', parent: 'room', slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...extra });
const said = (speaker: string, at: number, words: string | null, length = 2_000_000): SaidRec => ({ speaker, at, length, reach: 12_000, ref: `r${at}`, words });
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
  Object.assign(globalThis, { document: doc, innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener() {} });
  made.length = 0;
  const { pageSouls } = await import('./page.ts');

  const hostile = '<a href="https://example.com/x">click</a> <script>alert(1)</script> <b>bold</b> www.example.com';
  const at = 5_000_000;
  const nodes = new Map([['s.1', body('s.1', { name: '<img src=x onerror=alert(1)>' })]]);
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
  // The Soul's page: the name and the sentence as text, and the only elements are the page's own.
  assert.ok(texts.includes('<img src=x onerror=alert(1)>'));
  assert.ok(texts.some((t) => t.endsWith(`said “${hostile}”`)));
  assert.deepEqual([...new Set(made)].sort(), ['aside', 'button', 'canvas', 'h2', 'li', 'ol', 'p']);
  assert.ok(!made.includes('a') && !made.includes('script') && !made.includes('img') && !made.includes('b'));
});
