// N-V12 (#3726): a game board shows its pieces from its `pieces` field, and a move redraws them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('every board row matches its entry where content has it: the pieces field by number and record names, and the squares of its look', () => {
  const root = join(import.meta.dirname, '../../../../content/kinds/games');
  let checked = 0;
  for (const [kind, b] of Object.entries(BOARDS)) {
    const file = join(root, `${kind.split(':')[1]}.json`);
    if (!existsSync(file)) continue; // eden:checkers_board arrives with #3713's checkers PR (#3926)
    const e = JSON.parse(readFileSync(file, 'utf8')) as Entry;
    assert.equal(e.kind, kind);
    assert.equal(b.pieces.n, e.state.pieces.n);
    assert.deepEqual(Object.keys(b.pieces.of!), Object.keys(e.state.pieces.of!));
    // Every 70 mm square of the look (4 mm tall on the top) sits on a square's centre at the board's top.
    const squares = e.looks.shape.shapes.filter((s) => s.size[0] === b.pitch && s.size[2] === b.pitch && s.size[1] === 4);
    assert.equal(squares.length, 32);
    for (const s of squares) {
      const file = Math.round((s.at[0] - b.centre[0]) / b.pitch + 3.5), rank = Math.round((s.at[2] - b.centre[1]) / b.pitch + 3.5);
      const at = squareAt(b, rank * 8 + file);
      assert.ok(Math.abs(at.x * 1000 - s.at[0]) < 1e-6 && Math.abs(at.z * 1000 - s.at[2]) < 1e-6 && b.top === s.at[1] + s.size[1] / 2, kind);
    }
    checked++;
  }
  assert.ok(checked >= 1);
});

test('a checkers board draws men and kings on its squares, the second side in red', () => {
  const layer = new BoardPieces();
  layer.apply([node([[0, 1], [9, 2], [63, 9], [54, 10]], 'eden:checkers_board@1')], [], () => new THREE.Matrix4());
  const board = layer.group.getObjectByName('board:table')!;
  assert.equal(board.children.length, 4);
  assert.equal(board.getObjectByName('w1@0')!.children.length, 1);
  assert.equal(board.getObjectByName('w2@9')!.children.length, 2);
  assert.equal(((board.getObjectByName('b2@54')!.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString(), '9e2f28');
  assert.equal(piecesOf(node([[1, 3]], 'eden:checkers_board@1'), BOARDS['eden:checkers_board']).length, 0);
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
