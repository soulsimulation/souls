// N-V12 (#3726): a game board shows its pieces from its `pieces` field, and a move redraws them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { fieldsOf } from '../kinds/state.ts';
import { BOARDS, BoardPieces, piecesOf, squareAt } from './board.ts';

type Entry = { kind: string; state: Record<string, { n: number; type: string; of?: Record<string, unknown> }>; looks: { shape: { shapes: { at: number[]; size: number[]; tint: string }[] } } };
const entry = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../../content/kinds', path), 'utf8')) as Entry;
const chess = entry('games/chess_table.json');
const N = chess.state.pieces.n;
const node = (pieces: [number, number][], kind = 'eden:chess_table@1'): NodeRec => ({
  id: 'table', kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null,
  fields: fieldsOf(new Map([[N, pieces.map(([s, p]) => new Map([[1, s], [2, p]]))]])),
});
const OPENING: [number, number][] = [
  ...[4, 2, 3, 5, 6, 3, 2, 4].map((p, f): [number, number] => [f, p]), ...Array.from({ length: 8 }, (_, f): [number, number] => [8 + f, 1]),
  ...Array.from({ length: 8 }, (_, f): [number, number] => [48 + f, 9]), ...[12, 10, 11, 13, 14, 11, 10, 12].map((p, f): [number, number] => [56 + f, p]),
];

test('the board table matches the chess table entry: its pieces field by name, and its squares', () => {
  const b = BOARDS[chess.kind];
  assert.equal(b.pieces.n, chess.state.pieces.n);
  assert.equal(b.pieces.type, 'list');
  assert.deepEqual(Object.keys(b.pieces.of!), Object.keys(chess.state.pieces.of!));
  // The look's light squares (`cream`, 4 mm tall on the top) sit on the squares where file + rank is odd, as a1 is dark.
  const cream = chess.looks.shape.shapes.filter((s) => s.tint === 'cream');
  assert.equal(cream.length, 32);
  for (const s of cream) {
    const file = Math.round(s.at[0] / b.pitch + 3.5), rank = Math.round(s.at[2] / b.pitch + 3.5), at = squareAt(b, rank * 8 + file);
    assert.equal((file + rank) % 2, 1);
    assert.ok(Math.abs(at.x * 1000 - s.at[0]) < 1e-6 && Math.abs(at.z * 1000 - s.at[2]) < 1e-6);
    assert.equal(s.size[0], b.pitch);
    assert.equal(b.top, s.at[1] + s.size[1] / 2);
  }
});

test('A1: a chess table draws its 32 pieces from its state, at their squares, in its frame', () => {
  const layer = new BoardPieces();
  const frame = new THREE.Matrix4().makeTranslation(10, 0, -3);
  layer.apply([node(OPENING)], [], () => frame);
  const board = layer.group.getObjectByName('board:table')!;
  assert.equal(board.children.length, 32);
  layer.group.updateMatrixWorld(true);
  const e1 = board.getObjectByName('w6@4')!, e8 = board.getObjectByName('b6@60')!;
  const p = new THREE.Vector3().setFromMatrixPosition(e1.matrixWorld);
  assert.ok(p.distanceTo(new THREE.Vector3(10 + 0.035, 0.724, -3 - 0.245)) < 1e-9);
  assert.ok(e8.getObjectByProperty('type', 'Mesh'));
  assert.notEqual((e1.children[0] as THREE.Mesh).material, (e8.children[0] as THREE.Mesh).material);
  assert.equal(piecesOf(node([[64, 1], [3, 7], [5, 0], [6, 2]]), BOARDS[chess.kind]).length, 1);
});

test('A2: a move redraws the pieces; an unchanged node redraws nothing; a removed board goes', () => {
  const layer = new BoardPieces(), frame = () => new THREE.Matrix4();
  layer.apply([node(OPENING)], [], frame);
  const board = layer.group.getObjectByName('board:table')!;
  const kept = board.children[0];
  layer.apply([node(OPENING)], [], frame);
  assert.equal(board.children[0], kept);
  const moved = OPENING.map(([s, p]): [number, number] => (s === 12 ? [28, p] : [s, p])); // e2-e4
  layer.apply([node(moved)], [], frame);
  assert.equal(board.children.length, 32);
  assert.ok(board.getObjectByName('w1@28'));
  assert.equal(board.getObjectByName('w1@12'), undefined);
  layer.apply([], ['table'], frame);
  assert.equal(layer.group.children.length, 0);
});

test('other kinds draw no pieces', () => {
  const layer = new BoardPieces();
  layer.apply([node(OPENING, 'eden:desk_lamp@1')], [], () => new THREE.Matrix4());
  assert.equal(layer.group.children.length, 0);
});
