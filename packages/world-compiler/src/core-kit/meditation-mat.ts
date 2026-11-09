import type { DefInput } from '../schemas.ts';

/** A timed quiet practice, not a claim about the participant's internal state. */
export const MEDITATION_MAT: DefInput = {
  schema: 'def/1', name: 'core-meditation-mat', version: 1,
  description: 'A woven mat for a thirty-second quiet seated practice. Walk onto it, sit on the ground for thirty seconds, then stand. The mat remembers its most recent completed practice; stopping early leaves that record unchanged.',
  tags: ['quiet-practice', 'mat', 'local-fixture'], form: 'point', synonyms: ['meditation mat', 'quiet practice'],
  make: { kind: 'gen', gen: 'kit/2', args: { shapes: [
    { kind: 'box', at: [0, 0.007, 0], size: [1.6, 0.014, 1.6], tint: 'cloth', collide: false },
    { kind: 'box', at: [0, 0.015, -0.7], size: [1.4, 0.003, 0.05], tint: 'trim', collide: false },
    { kind: 'box', at: [0, 0.015, 0.7], size: [1.4, 0.003, 0.05], tint: 'trim', collide: false }
  ] } } as DefInput['make'],
  palette: { cloth: '#537c78', trim: '#d4c79b' }, params: {}, components: {}, size: { box: [1.6, 0.018, 1.6] },
  state: { practiceSeconds: { type: 'number', min: 30, max: 30, default: 30 }, lastBy: { type: 'string', max: 100, default: '' }, lastReceipt: { type: 'string', max: 100, default: '' }, lastCompletedTick: { type: 'number', min: -1, max: 1e12, default: -1 } } as DefInput['state'],
  actions: [{ name: 'meditate', label: 'Meditate quietly for 30 seconds on the mat', params: {}, then: [{ op: 'set', field: 'practiceSeconds', value: 30 }] }]
};
