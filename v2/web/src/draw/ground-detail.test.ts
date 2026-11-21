// C11 (#3682): the ground's detail as today's page draws it on Eden: the meadow palette's terrain colour, shore and
// river banks fading from wet to the ground's colour, and the ground cover's grass, tufts and flowers, bare on paths,
// below the plain and under footprints.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { WorldView, terrainColour } from './world.ts';
import { DRAPES, GroundCover, bankColour, cellKind, coverSetting, drapeMesh, siteAt, wetness, type CoverGround } from './drapes.ts';

const ROT: NodeRec['rot'] = [1 << 30, 0, 0, 0];
const node = (o: Partial<NodeRec> & { id: string; kind: string }): NodeRec => ({ parent: null, slot: null, pos: [0, 0, 0], rot: ROT, at: null, ...o });

test('A1: the terrain takes today\'s meadow colours (pinned from apps/web ground-palette.ts terrainColorFor)', () => {
  // [height, slope, x, z, today's colour]: the plain, the shore below it, the bed, high ground, a steep bank, snow.
  const today: [number, number, number, number, number][] = [[0, 0, 3, 5, 0x7e8f61], [-0.5, 0.1, 10, -7, 0xb7af89], [-2, 0, -40, 22, 0xb7af8a], [45, 0.3, 100, 100, 0x7e8e62], [12, 1.2, 7, 9, 0x858b73], [160, 0.2, 50, 60, 0x9fa797]];
  const c = new THREE.Color();
  for (const [y, s, x, z, hex] of today) assert.equal(terrainColour(c, y, s, x, z).getHex(), hex, `height ${y}, slope ${s}`);
});

/** One 16 m tile: a plain at 0 that falls into a pond 2 m deep west of x = 4. */
function pondGround(): NodeRec {
  const n = 16, h = new DataView(new ArrayBuffer((n + 1) ** 2 * 4));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h.setInt32((j * (n + 1) + i) * 4, i < 4 ? -2000 + i * 500 : 0, true);
  return node({ id: 'g', kind: 'eden:ground', parent: 'w', tileSize: 16_000, tiles: [[0, 0, new Uint8Array(h.buffer), new Uint8Array(n * n)]] });
}

test('A2: the shore is painted down to the bed with no hard cut, and a bank fades from wet to the ground', () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), pondGround()], []);
  const mesh = w.group.children.find((m) => m.name === 'terrain') as THREE.Mesh;
  const pos = mesh.geometry.getAttribute('position'), col = mesh.geometry.getAttribute('color');
  // Along a row: the colour steps by no more than its neighbours' difference in today's palette (no class cut).
  const row = [...Array(pos.count).keys()].filter((i) => pos.getZ(i) === 8).sort((a, b) => pos.getX(a) - pos.getX(b));
  const plain = new THREE.Color(0x7f9062), shore = new THREE.Color(0xb6ae89);
  const at = (i: number) => new THREE.Color(col.getX(i), col.getY(i), col.getZ(i));
  assert.ok(Math.abs(at(row[0]).r - shore.r) < 0.02, 'the bed in the shore colour');
  assert.ok(Math.abs(at(row[10]).g - plain.g) < 0.02, 'the plain in the meadow colour');
  // A bank quad from the water's edge (x 2) up to the plain (x 6): wet at its foot, the ground's colour at its top.
  const heightAt = (x: number, z: number) => w.heightAt(x, z);
  const c = new THREE.Color();
  const foot = bankColour(c, DRAPES.shore, 'shore', wetness(2, 8, heightAt(2, 8)!, heightAt)).clone();
  const top = bankColour(c, DRAPES.shore, 'shore', wetness(7, 8, heightAt(7, 8)!, heightAt)).clone();
  const pebble = new THREE.Color(DRAPES.shore);
  assert.ok(Math.abs(foot.r - pebble.r * 0.75) < 0.01, `wet foot ${foot.getHexString()}`);
  assert.equal(top.getHex(), pebble.clone().lerp(new THREE.Color(0x7d9c56), 0.25).getHex(), 'dry top: today\'s shore/1 outer colour');
  const drape = drapeMesh([{ colour: DRAPES.shore, bank: 'shore', lift: 0.02, points: [[2, 6], [7, 6], [7, 10], [2, 10]] }], heightAt)!;
  const dc = drape.geometry.getAttribute('color'), dp = drape.geometry.getAttribute('position');
  const reds = [...Array(dc.count).keys()].map((i) => [dp.getX(i), dc.getX(i)]).sort((a, b) => a[0] - b[0]);
  assert.ok(reds[0][1] < reds[reds.length - 1][1], 'the drape lightens from the water up');
});

/** A flat 64 m meadow at 0, a path across z 30..33, a lawn x 40..60, a shore below the plain west of x 4. */
const meadow = (): CoverGround => ({
  heightAt: (x, z) => (x < 0 || z < 0 || x > 64 || z > 64 ? null : x < 4 ? -1 : 0),
  colour: (c, y, s, x, z) => terrainColour(c, y, s, x, z),
  blocked: (_x, z) => z >= 30 && z <= 33,
  lawn: (x, _z) => (x >= 40 && x <= 60 ? { edge: 1.2, rim: Math.min(x - 40, 60 - x) } : null),
  base: 0,
});

test('A1: ground cover grows on the meadow, never on a path or below the plain; the same cell deals the same blades', () => {
  const g = meadow();
  assert.equal(siteAt(g, 2, 10, false), null, 'shore below the plain is bare');
  const open = siteAt(g, 20, 10, false)!;
  assert.ok(open.tuft > 0.5 && open.tall > 0, 'the meadow grows');
  const verge = siteAt(g, 20, 29, true)!;
  assert.ok(verge.tall >= 0.5 && verge.flower >= 0.2, 'a verge grows long, with flowers');
  const lawn = siteAt(g, 50, 10, false)!;
  assert.ok(lawn.short < open.short && lawn.tall < open.tall, 'a lawn is mown');
  for (const k of [0, 1, 2]) {
    const a = cellKind(g, 2, 3, k, Array.from({ length: 25 }, (_, i) => siteAt(g, 16 + (i % 5) * 2, 24 + Math.floor(i / 5) * 2, false)));
    for (let i = 0; i < a.length; i += 10) assert.ok(a[i + 2] < 30 || a[i + 2] > 33, 'nothing on the path');
    const b = cellKind(g, 2, 3, k, Array.from({ length: 25 }, (_, i) => siteAt(g, 16 + (i % 5) * 2, 24 + Math.floor(i / 5) * 2, false)));
    assert.deepEqual(a, b, 'dealt from a fixed hash');
  }
});

test('A1: the cover fills around the camera, thins with distance, and is off on the phone tier', () => {
  const cover = new GroundCover(meadow(), { enabled: true, reason: 'test' });
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(20, 1.7, 15);
  cam.updateMatrixWorld();
  for (let i = 0; i < 200; i++) cover.update(cam); // a millisecond a frame until every cell is dealt
  assert.ok(cover.instances.tuft > 500 && cover.instances.tall > 50 && cover.instances.flower > 10, JSON.stringify(cover.instances));
  cam.position.set(20, 400, 15);
  cam.updateMatrixWorld();
  cover.update(cam);
  assert.equal(cover.instances.tuft, 0, 'nothing from high up');
  assert.equal(coverSetting('', { tier: 'phone', reason: 'touch' }).enabled, false);
  assert.equal(coverSetting('?cover=1', { tier: 'phone', reason: 'touch' }).enabled, true);
  assert.equal(coverSetting('?cover=0', { tier: 'full', reason: 'desktop' }).enabled, false);
});

test('A1: what stands on the ground and every non-lawn area keep the cover off', () => {
  const w = new WorldView();
  const n = 16, h = new DataView(new ArrayBuffer((n + 1) ** 2 * 4));
  const ground = node({ id: 'g', kind: 'eden:ground', parent: 'w', tileSize: 16_000, tiles: [[0, 0, new Uint8Array(h.buffer), new Uint8Array(n * n)]] });
  const bench = node({ id: 'b', kind: 'eden:bench@1', parent: 'g', pos: [8_000_000, 0, 8_000_000], solids: [[0, 0, 1000, 400, 0, 0, 900, 0, 0]] });
  const path = node({ id: 'p', kind: 'core:footpath@1', parent: 'g', outline: [[0, 2000], [16000, 2000], [16000, 4000], [0, 4000]] });
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground, bench, path], []);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(8, 1.7, 12);
  cam.updateMatrixWorld();
  w.draw(0, cam);
  const blocked = (w.cover as unknown as { ground: CoverGround }).ground.blocked;
  assert.ok(blocked(8.5, 8.2), 'under the bench');
  assert.ok(blocked(5, 3), 'on the path');
  assert.ok(!blocked(3, 12), 'open meadow');
});
