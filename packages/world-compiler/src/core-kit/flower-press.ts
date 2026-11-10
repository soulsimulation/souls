import type { DefInput } from '../schemas.ts';

// A hinged botanical press: the material stays in this entity, with its preserved form in native state.
const leaf = { role: 'door', pivot: [-0.25, 0, 0.0375] };
export const FLOWER_PRESS: DefInput = {
  schema: 'def/1', name: 'core-flower-press', version: 1,
  description: 'A fixed botanical press with a hinged compression leaf and one flower already laid on its backing paper. Close the leaf by its handle to press the flower; reopen it to reveal the lasting flattened artwork. Read its status label to learn whether the botanical artwork has been preserved. The pressed state is preserved. No drying time or removable output is implied.',
  tags: ['art', 'botanical-press', 'hand-operated', 'hand-cabinet', 'local-fixture'], form: 'point',
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
    { kind: 'box', at: [0, 0.035, 0], size: [0.66, 0.07, 0.4], tint: 'wood' },
    { kind: 'box', at: [-0.28, 0.7, 0], size: [0.055, 1.4, 0.1], tint: 'wood' },
    { kind: 'box', at: [0.28, 0.7, 0], size: [0.055, 1.4, 0.1], tint: 'wood' },
    { kind: 'box', at: [0, 0.62, 0], size: [0.55, 0.08, 0.04], tint: 'wood' },
    { kind: 'box', at: [0, 0.62, 0.025], size: [0.3, 0.06, 0.008], tint: 'paper' },
    { kind: 'box', at: [0, 1.05, -0.025], size: [0.51, 0.64, 0.04], tint: 'wood' },
    { kind: 'box', at: [0, 1.05, 0], size: [0.46, 0.57, 0.008], tint: 'paper' },
    { kind: 'box', at: [0, 1.05, 0.0375], size: [0.5, 0.63, 0.035], tint: 'cover', ...leaf },
    { kind: 'sphere', at: [0.21, 1.05, 0.08], r: 0.024, segments: 6, tint: 'brass', ...leaf },
    // Same authored botanical material before and after pressure, represented by its durable state.
    { kind: 'box', at: [0, 0.98, 0.026], size: [0.012, 0.32, 0.025], tint: 'stem', when: '!@pressed' },
    { kind: 'box', at: [0, 0.98, 0.01], size: [0.012, 0.32, 0.006], tint: 'stem', when: '@pressed' },
    ...Array.from({ length: 5 }, (_, i) => {
      const a = i * Math.PI * 2 / 5;
      return [
        { kind: 'cyl', at: [Math.sin(a) * 0.065, 1.16 + Math.cos(a) * 0.065, 0.035], r: 0.055, h: 0.04, pitch: Math.PI / 2, segments: 5, tint: 'petal', when: '!@pressed' },
        { kind: 'cyl', at: [Math.sin(a) * 0.075, 1.16 + Math.cos(a) * 0.075, 0.012], r: 0.06, h: 0.004, pitch: Math.PI / 2, segments: 5, tint: 'petal', when: '@pressed' }
      ];
    }).flat(),
    { kind: 'cyl', at: [0, 1.16, 0.05], r: 0.035, h: 0.04, pitch: Math.PI / 2, segments: 5, tint: 'eye', when: '!@pressed' },
    { kind: 'cyl', at: [0, 1.16, 0.017], r: 0.038, h: 0.004, pitch: Math.PI / 2, segments: 5, tint: 'eye', when: '@pressed' }
  ] } } as DefInput['make'],
  palette: { wood: '#8c6849', cover: '#a37b54', paper: '#f2e5ca', stem: '#507645', petal: '#a566a0', eye: '#d4ad49', brass: '#b49a56' },
  params: {}, components: { workstation: { kind: 'flower-press' }, sign: { lines: ['Raw flower in the press.'] } }, state: { open: { type: 'bool', default: true }, pressed: { type: 'bool', default: false }, text: { type: 'string', max: 120, default: '' } },
  size: { box: [0.66, 1.4, 0.4] },
  actions: [
    { name: 'close', label: 'Close the press and preserve the flower', when: [{ field: 'open', is: true }], then: [{ op: 'set', field: 'open', value: false }, { op: 'set', field: 'pressed', value: true }, { op: 'set', field: 'text', value: 'Pressed botanical artwork preserved in this press.' }] },
    { name: 'open', label: 'Open the press to view the flower', when: [{ field: 'open', is: false }], then: [{ op: 'set', field: 'open', value: true }] }
  ], synonyms: ['botanical press', 'pressed flower artwork']
} as DefInput;
