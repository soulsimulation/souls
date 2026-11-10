import type {DefInput} from '../schemas.ts';

const number = (max: number, initial = 0) => ({type: 'number' as const, min: 0, max, default: initial});
export const CRANK_LAMP: DefInput = {
  schema: 'def/1', name: 'core-crank-inspection-lamp', version: 1, form: 'point', category: 'object.tool',
  description: 'A portable hand-crank inspection lamp. Four completed seconds crank two coarse charge units, up to six. Activate after one second of native handwork: choose seconds as string5,10 or15, spending one charge per five seconds, then actual world light starts. It goes dark at the native tick deadline; stop early or restart never refunds spent charge. Empty hands, accessible supported tabletop required. Coarse charge batches, no scientific energy model or precise crank grip.',
  tags: ['tool', 'lighting', 'item', 'recorded-item', 'local-fixture'],
  make: {kind: 'gen', gen: 'kit/2', args: {round: 0, shapes: [
    {kind: 'box', at: [0, .11, 0], size: [.3, .22, .2], tint: 'body'},
    {kind: 'box', at: [0, .26, 0], size: [.22, .08, .16], tint: 'body'},
    {kind: 'box', at: [0, .32, 0], size: [.12, .04, .08], tint: 'grip'},
    {kind: 'box', at: [0, .26, .083], size: [.18, .055, .012], tint: 'lens', glow: 1, when: '@on'},
    {kind: 'box', at: [0, .26, .083], size: [.18, .055, .012], tint: 'grip', when: '!@on'},
    {kind: 'box', at: [.18, .13, 0], size: [.08, .025, .025], tint: 'grip'},
    {kind: 'box', at: [.21, .16, 0], size: [.025, .08, .025], tint: 'grip'},
    ...Array.from({length: 6}, (_, i) => ({kind: 'box', at: [-.1 + i * .04, .13, .105], size: [.025, .045, .012], tint: 'charge', when: `@charge>${i}`})),
  ]}} as DefInput['make'],
  palette: {body: '#315d5b', grip: '#242b2c', lens: '#fff1ba', charge: '#d4c778'},
  size: {box: [.46, .34, .23]},
  components: {carryable: {mass: .8, grips: 1}, light: {color: '#fff0bf', range: 4.5, on: true, at: [0, .27, .17]}},
  state: {on: {type: 'bool', default: false}, charge: number(6), cranks: number(1e6), activations: number(1e6),
    usedCharge: number(3e6), lastSeconds: number(15), litUntilTick: number(1e12), routineSeconds: number(4, 4),
    lastBy: {type: 'string', max: 80, default: ''}, lastReceipt: {type: 'string', max: 100, default: ''},
    lastCompletedTick: {type: 'number', min: -1, max: 1e12, default: -1}},
  actions: [
    {name: 'crank', label: 'Crank two stored light charges (4 seconds)', params: {}, then: [{op: 'set', field: 'routineSeconds', value: 4}]},
    {name: 'illuminate', label: 'Spend charge on a chosen world-light interval', params: {seconds: {type: 'string', max: 2, default: '5', doc: 'String5,10 or15; one charge per five native seconds. Starts only after completed one-second activation, after approach.'}}, then: [{op: 'set', field: 'routineSeconds', value: 4}]},
    {name: 'extinguish', label: 'Stop this lamp early without refund (1 second)', params: {}, then: [{op: 'set', field: 'routineSeconds', value: 4}]},
  ] as DefInput['actions'],
};
export const LAMP_TABLE: DefInput = {
  schema: 'def/1', name: 'core-crank-lamp-table', version: 1, form: 'point',
  description: 'A fixed ordinary work surface for the separately portable hand-crank inspection lamp.',
  tags: ['table', 'furniture', 'local-fixture'],
  make: {kind: 'gen', gen: 'kit/2', args: {round: 0, shapes: [
    {kind: 'box', at: [0, .965, 0], size: [.9, .03, .8], tint: 'wood'},
    {kind: 'box', at: [0, .475, 0], size: [.2, .95, .4], tint: 'wood'},
  ]}} as DefInput['make'], palette: {wood: '#78614b'}, size: {box: [.9, .98, .8]},
  components: {surface: {height: .98}},
  slots: [{id: 'out', kind: 'surface', p: [0, .99, 0], yaw: 0, height: .99, capacity: 1, accepts: {maxSize: [.55, .4, .4], maxMass: 2}}],
};
export default [CRANK_LAMP, LAMP_TABLE];
