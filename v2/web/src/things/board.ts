// Game boards show their pieces (N-V12, #3726): a board kind's `pieces` list (records {square, piece}; square
// rank*8 + file, 0 = a1, white's back rank 0) is drawn as pieces on its 8x8 squares, in the board's frame, and drawn
// again whenever the node's state changes (a move). Chess pieces are today's turned tokens
// (`mars/viewer/app/engine-view/chess.ts`, `catalog-chess.ts`): pawn 45 mm, the rest 65 mm, ivory and ebony; checkers
// are discs on the dark squares, ivory and red (the board's dark squares would hide ebony), a king two stacked. The page reads the field by the entry's name; the table below is checked against the
// entries in `content/kinds` by its test.
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { listOf, type StateDef } from '../kinds/state.ts';

const MM = 1e-3;
/** A board kind: its game, its `pieces` field as the entry declares it, and where its squares are (mm, its frame). */
export type Board = { game: 'chess' | 'checkers'; pieces: StateDef; top: number; pitch: number; centre: [number, number] };

/** The board kinds the page draws pieces on (`content/kinds/games/`). */
export const BOARDS: Record<string, Board> = {
  'eden:chess_table': {
    game: 'chess',
    pieces: { n: 31, type: 'list', of: { square: { type: 'int' }, piece: { type: 'int' } } } as StateDef,
    top: 724, pitch: 70, centre: [0, 0],
  },
  'eden:checkers_board': {
    game: 'checkers',
    pieces: { n: 31, type: 'list', of: { square: { type: 'int' }, piece: { type: 'int' } } } as StateDef,
    top: 724, pitch: 70, centre: [0, 0],
  },
};

/** A piece on the board: its square and code (chess 1 pawn … 6 king, checkers 1 man 2 king; +8 for the second side). */
export type Piece = { square: number; piece: number };
const CHESS = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as const;
const LIGHT = '#ebe5d2', DARK = '#34302a', RED = '#9e2f28';

/** The pieces a node holds, read by the entry's field name; invalid records are left out. */
export function piecesOf(n: Pick<NodeRec, 'fields'>, board: Board): Piece[] {
  const out: Piece[] = [];
  for (const r of listOf(n.fields, board.pieces)) {
    const square = Number(r.square), piece = Number(r.piece);
    if (Number.isInteger(square) && square >= 0 && square < 64 && (piece & 7) >= 1 && (piece & 7) <= (board.game === 'chess' ? 6 : 2) && piece <= 15) out.push({ square, piece });
  }
  return out;
}

/** A square's centre in the board's frame (m): files along x, ranks along z, white's back rank at -z. */
export function squareAt(board: Board, square: number): THREE.Vector3 {
  const file = square % 8, rank = Math.floor(square / 8);
  return new THREE.Vector3((board.centre[0] + (file - 3.5) * board.pitch) * MM, board.top * MM, (board.centre[1] + (rank - 3.5) * board.pitch) * MM);
}

type Shape = [THREE.BufferGeometry, number, number, number, number?];
/** One piece's meshes as today's: [geometry, x, y, z, tilt about x]. */
class Kit {
  private geos = new Map<string, THREE.BufferGeometry>();
  readonly light = new THREE.MeshStandardMaterial({ color: LIGHT, roughness: 0.55 });
  readonly dark = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.55 });
  readonly red = new THREE.MeshStandardMaterial({ color: RED, roughness: 0.55 });
  geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geos.get(key);
    if (!g) this.geos.set(key, (g = make()));
    return g;
  }
  chess(kind: (typeof CHESS)[number]): Shape[] {
    const h = kind === 'pawn' ? 0.045 : 0.065, s: Shape[] = [
      [this.geo('base', () => new THREE.CylinderGeometry(0.014, 0.0175, 0.008, 16)), 0, 0.004, 0],
      [this.geo(`stem:${kind}`, () => new THREE.CylinderGeometry(0.007, 0.012, h * 0.45, 12)), 0, 0.008 + h * 0.225, 0],
    ];
    if (kind === 'pawn' || kind === 'queen' || kind === 'bishop') {
      const r = kind === 'pawn' ? 0.009 : 0.01;
      s.push([this.geo(`head:${kind}`, () => new THREE.SphereGeometry(r, 12, 8)), 0, h - (kind === 'pawn' ? 0.009 : 0.01), 0]);
      if (kind === 'queen') for (let i = 0; i < 5; i++) {
        const a = (i * Math.PI * 2) / 5;
        s.push([this.geo('queen-crown', () => new THREE.SphereGeometry(0.0025, 6, 4)), Math.cos(a) * 0.007, h - 0.0025, Math.sin(a) * 0.007]);
      }
      if (kind === 'bishop') s.push([this.geo('bishop-tip', () => new THREE.ConeGeometry(0.003, 0.009, 8)), 0, h - 0.0045, 0]);
    } else if (kind === 'knight') {
      s.push([this.geo('knight-head', () => new THREE.BoxGeometry(0.011, 0.025, 0.012)), 0, h - 0.014, -0.002, -0.25]);
      s.push([this.geo('knight-muzzle', () => new THREE.BoxGeometry(0.011, 0.008, 0.009)), 0, h - 0.013, -0.009]);
    } else if (kind === 'rook') {
      s.push([this.geo('rook-crown', () => new THREE.CylinderGeometry(0.013, 0.01, 0.013, 12)), 0, h - 0.0065, 0]);
      for (const x of [-1, 1]) for (const z of [-1, 1]) s.push([this.geo('rook-tooth', () => new THREE.BoxGeometry(0.005, 0.005, 0.005)), x * 0.008, h - 0.0025, z * 0.008]);
    } else {
      s.push([this.geo('king-head', () => new THREE.SphereGeometry(0.007, 10, 8)), 0, h - 0.016, 0]);
      s.push([this.geo('king-cross-v', () => new THREE.BoxGeometry(0.003, 0.013, 0.003)), 0, h - 0.0065, 0]);
      s.push([this.geo('king-cross-h', () => new THREE.BoxGeometry(0.01, 0.003, 0.003)), 0, h - 0.007, 0]);
    }
    return s;
  }
  checkers(king: boolean): Shape[] {
    const disc = this.geo('disc', () => new THREE.CylinderGeometry(0.026, 0.026, 0.008, 24));
    return king ? [[disc, 0, 0.004, 0], [disc, 0, 0.0125, 0]] : [[disc, 0, 0.004, 0]];
  }
  dispose(): void {
    for (const g of this.geos.values()) g.dispose();
    this.light.dispose();
    this.dark.dispose();
    this.red.dispose();
  }
}

/** One group of pieces per board node, in the board's frame; redrawn when its pieces change. */
export class BoardPieces {
  readonly group = new THREE.Group();
  private kit = new Kit();
  private boards = new Map<string, { group: THREE.Group; key: string }>();
  constructor() {
    this.group.name = 'board-pieces';
  }
  /** Draws (or clears) the pieces of each board among `nodes`; `frame` is a node's frame in the world. */
  apply(nodes: NodeRec[], removed: string[], frame: (id: string) => THREE.Matrix4): void {
    for (const id of removed) this.remove(id);
    for (const n of nodes) {
      const board = BOARDS[n.kind.split('@')[0]];
      if (!board) continue;
      const pieces = piecesOf(n, board), key = JSON.stringify(pieces);
      let b = this.boards.get(n.id);
      if (!b) {
        b = { group: new THREE.Group(), key: '' };
        b.group.name = `board:${n.id}`;
        b.group.matrixAutoUpdate = false;
        this.boards.set(n.id, b);
        this.group.add(b.group);
      }
      b.group.matrix.copy(frame(n.id));
      b.group.matrixWorldNeedsUpdate = true;
      if (b.key === key) continue;
      b.key = key;
      b.group.clear();
      for (const p of pieces) b.group.add(this.piece(board, p));
    }
  }
  /** Moves a board that rides a course (#3603) with its frame. */
  move(id: string, matrix: THREE.Matrix4): void {
    const b = this.boards.get(id);
    if (b) (b.group.matrix.copy(matrix), (b.group.matrixWorldNeedsUpdate = true));
  }
  has(id: string): boolean {
    return this.boards.has(id);
  }
  private piece(board: Board, p: Piece): THREE.Group {
    const second = p.piece >= 8, code = p.piece & 7, g = new THREE.Group();
    const shapes = board.game === 'chess' ? this.kit.chess(CHESS[code]) : this.kit.checkers(code === 2);
    const material = !second ? this.kit.light : board.game === 'chess' ? this.kit.dark : this.kit.red;
    for (const [geo, x, y, z, tilt] of shapes) {
      const m = new THREE.Mesh(geo, material);
      m.position.set(x, y, z);
      if (tilt) m.rotation.x = tilt;
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    g.position.copy(squareAt(board, p.square));
    // Each side faces the other: a knight's head looks across the board (today's token faces -z).
    if (!second) g.rotation.y = Math.PI;
    g.name = `${second ? 'b' : 'w'}${p.piece & 7}@${p.square}`;
    g.userData.piece = p;
    return g;
  }
  private remove(id: string): void {
    const b = this.boards.get(id);
    if (!b) return;
    b.group.removeFromParent();
    this.boards.delete(id);
  }
  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    this.boards.clear();
    this.kit.dispose();
  }
}
