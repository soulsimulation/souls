import type { DefInput } from '../schemas.ts';

/** A composition consists of native item identities resting on individually chosen, fixed cells. */
export const MOSAIC_DEFS: DefInput[] = [
  { schema: 'def/1', name: 'core-mosaic-tile', version: 1,
    description: 'A colored ceramic mosaic tile. Pick it up, then choose a named mosaic cell with put-on. Pick it up again to rearrange your composition. Tiles do not support other objects.',
    tags: ['art', 'mosaic-tile', 'item', 'recorded-item', 'local-fixture'], form: 'point', layer: 'decor',
    make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
      { kind: 'box', at: [0, 0.025, 0], size: [0.12, 0.05, 0.12], tint: 'pigment' }
    ] } }, palette: { pigment: '#d55b46' }, params: { pigment: { type: 'color', default: '#d55b46', doc: 'ceramic glaze color' } },
    components: { carryable: { mass: 0.04, grips: 1 } }, size: { box: [0.12, 0.05, 0.12] }, synonyms: ['mosaic piece', 'colored tile']
  } as DefInput,
  { schema: 'def/1', name: 'core-mosaic-cell', version: 1,
    description: 'One fixed, named cell of a mosaic board. While carrying a tile, choose this cell with put-on; its one surface holds one piece. Other cells stay independently selectable.',
    tags: ['art', 'mosaic-cell', 'surface', 'local-fixture'], form: 'point', layer: 'decor',
    make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
      { kind: 'box', at: [0, 0.01, 0], size: [0.15, 0.02, 0.15], tint: 'cell' }
    ] } }, palette: { cell: '#333c48' }, params: {}, components: { surface: { height: 0.02 } },
    slots: [{ id: 'tile', kind: 'surface', p: [0, 0.02, 0], yaw: 0, accepts: { tags: ['mosaic-tile'], maxSize: [0.13, 0.06, 0.13] }, capacity: 1 }],
    size: { box: [0.15, 0.05, 0.15] }, synonyms: ['mosaic square']
  } as DefInput,
  { schema: 'def/1', name: 'core-mosaic-board', version: 1,
    description: 'A fixed nine-cell mosaic worktable. Compose a picture from separate colored tiles: choose cell-a1 through cell-c3 directly with put-on while carrying a tile. Retrieve and rearrange pieces at any time. The composition is the lasting arrangement, not a preset pattern.',
    tags: ['art', 'mosaic', 'furniture', 'local-fixture'], form: 'point',
    make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
      { kind: 'box', at: [0, 0.81, 0], size: [0.56, 0.06, 0.56], tint: 'wood' },
      ...[-0.22, 0.22].flatMap(x => [-0.22, 0.22].map(z => ({ kind: 'box', at: [x, 0.39, z], size: [0.055, 0.78, 0.055], tint: 'wood' })))
    ] } }, palette: { wood: '#a68761' }, params: {},
    contents: ['a', 'b', 'c'].flatMap((row, z) => [1, 2, 3].map((col, x) => ({ id: `cell-${row}${col}`, def: 'core/mosaic-cell@1', p: [(x - 1) * 0.16, 0.84, (z - 1) * 0.16] }))),
    size: { box: [0.56, 0.91, 0.56] }, synonyms: ['mosaic table', 'mosaic frame']
  } as DefInput
];
