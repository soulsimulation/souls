import type { DefInput } from '../schemas.ts';
export const BEAD_COLOURS = ['red', 'blue', 'amber'] as const;
const slots = Array.from({ length: 6 }, (_, i) => `slot${i + 1}`);
/** One integral portable strand tray: unused beads remain visible in its stock pockets. */
export const BEAD_STRAND: DefInput = {
  schema: 'def/1', name: 'core-bead-strand', version: 1,
  description: 'A portable bead-strand artwork on an integral tray. Choose a colour for each of six ordered cord positions. Two beads of each colour are supplied. Three completed seconds threads or unthreads one bead; unthreading returns it to the stock pocket. Put on a clear fixed work table and empty hands first. Inspect beadStrand facts for sequence, finite stock and maker. The native brush is an approximate handwork proxy; no needle custody, wearing or loose bead physics.',
  tags: ['art', 'portable'], synonyms: ['bead strand', 'threading tray'], params: {},
  palette: { wood: '#876b49', cord: '#e8d7a6', red: '#b33c39', blue: '#315eaa', amber: '#d59a27' },
  size: { box: [.58, .08, .4] },
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
    { kind: 'box', at: [0, .02, 0], size: [.58, .04, .4], tint: 'wood' },
    { kind: 'box', at: [0, .049, .08], size: [.52, .012, .012], tint: 'cord' },
    ...slots.flatMap((slot, i) => BEAD_COLOURS.map(colour => ({ kind: 'box', at: [-.225 + i * .09, .061, .08], size: [.064, .03, .064], tint: colour, when: `@${slot}=${colour}` }))),
    ...BEAD_COLOURS.flatMap((colour, i) => [1, 2].map(n => ({ kind: 'box', at: [-.19 + i * .19, .061, -.13 + (n - 1) * .08], size: [.064, .03, .064], tint: colour, when: `@${colour}Stock>=${n}` }))),
  ] } } as DefInput['make'],
  state: { ...Object.fromEntries(slots.map(slot => [slot, { type: 'enum', values: ['empty', ...BEAD_COLOURS], default: 'empty' }])),
    ...Object.fromEntries(BEAD_COLOURS.map(c => [`${c}Stock`, { type: 'int', min: 0, max: 2, default: 2 }])),
    maker: { type: 'string', max: 80, default: '' }, lastReceipt: { type: 'string', max: 100, default: '' }, lastCompletedTick: { type: 'number', min: -1, max: 1e12, default: -1 }, workSeconds: { type: 'number', min: 3, max: 3, default: 3 } },
  components: { carryable: { mass: .6, grips: 2 } }, slots: [],
  actions: slots.flatMap(slot => [...BEAD_COLOURS.map(c => ({ name: `thread-${slot}-${c}`, label: `Thread ${c} bead into position ${slot.slice(4)} (3 seconds)`, params: {}, when: [{ field: slot, is: 'empty' }], then: [{ op: 'set', field: 'workSeconds', value: 3 }] })), { name: `unthread-${slot}`, label: `Unthread position ${slot.slice(4)} and recover bead (3 seconds)`, params: {}, when: [{ field: slot, not: 'empty' }], then: [{ op: 'set', field: 'workSeconds', value: 3 }] }]) as DefInput['actions'],
};
