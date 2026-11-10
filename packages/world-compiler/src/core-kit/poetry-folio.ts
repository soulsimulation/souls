import type { DefInput } from '../schemas.ts';

// A finished poem is an artifact, rather than an erasable notice. The existing contact writer commits
// the words and textBy together; its empty-text gate closes at that same transaction.
export const POETRY_FOLIO: DefInput = {
  schema: 'def/1', name: 'core-poetry-folio', version: 1,
  description: 'A blank open poetry folio on a wooden display stand. Write one poem of up to three lines by hand. Once written, it is a finished work: anyone may read it, but it cannot be overwritten or erased.',
  tags: ['signage', 'sign-text', 'hand-writable', 'poetry', 'book'], form: 'point',
  synonyms: ['poetry folio', 'poem', 'folio'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0.005, shapes: [
    { kind: 'box', at: [0, 0.025, 0], size: [0.5, 0.05, 0.4], tint: 'wood' },
    { kind: 'box', at: [0, 0.57, -0.02], size: [0.07, 1.1, 0.07], tint: 'wood' },
    { kind: 'box', at: [0, 1.26, 0], size: [0.74, 0.52, 0.035], tint: 'cover' },
    { kind: 'box', at: [-0.174, 1.26, 0.026], size: [0.342, 0.48, 0.025], tint: 'paper' },
    { kind: 'box', at: [0.174, 1.26, 0.026], size: [0.342, 0.48, 0.025], tint: 'paper' },
    { kind: 'box', at: [0, 1.26, 0.037], size: [0.009, 0.48, 0.009], tint: 'cover' }
  ], faces: [{ at: [0, 1.26, 0.041], w: 0.65, h: 0.41, bg: '#f5efd9', ink: '#26334a', font: '600' }] } } as DefInput['make'],
  palette: { wood: '#75523d', cover: '#38595b', paper: '#f5efd9' }, params: {},
  state: { text: { type: 'string', max: 100, default: '' }, textBy: { type: 'string', max: 40, default: '' } } as DefInput['state'],
  components: { readable: { pages: 1 }, sign: { lines: [] } } as DefInput['components'],
  size: { box: [0.74, 1.52, 0.4] },
  actions: [{ name: 'write', label: 'Write a finished poem in the blank folio',
    params: { text: { type: 'string', max: 100, doc: 'your finished poem: up to 100 characters and three lines; it cannot be revised or erased' } },
    when: [{ field: 'text', is: '' }], then: [{ op: 'set', field: 'text', value: { param: 'text' } }] }]
} as DefInput;
