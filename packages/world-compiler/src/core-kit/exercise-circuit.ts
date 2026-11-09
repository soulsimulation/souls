import type { DefInput } from '../schemas.ts';

/** The existing native poses own movement, clearance and each phase's duration. */
export const EXERCISE_CIRCUIT: DefInput = {
  schema: 'def/1', name: 'core-exercise-circuit', version: 1,
  description: 'A painted ground marker for a solo twenty-second warm-up: stretch for five seconds, do jumping jacks for ten seconds, stretch for five seconds, then stand. Each whole completed circuit adds one durable round; stopping early leaves the count unchanged. Use clear ground and empty hands.',
  tags: ['exercise', 'local-fixture'], form: 'point', synonyms: ['warm-up circuit', 'solo exercise'],
  make: { kind: 'gen', gen: 'kit/2', args: { shapes: [
    { kind: 'box', at: [0, 0.003, 0], size: [1.6, 0.006, 1.6], tint: 'base', collide: false },
    ...[-0.5, 0, 0.5].map(x => ({ kind: 'box', at: [x, 0.008, -0.6], size: [0.3, 0.004, 0.08], tint: 'mark', collide: false }))
  ] } } as DefInput['make'],
  palette: { base: '#b86f42', mark: '#f1d48b' }, params: {}, components: {}, size: { box: [1.6, 0.05, 1.6] },
  state: { routineSeconds: { type: 'number', min: 20, max: 20, default: 20 }, completedRounds: { type: 'number', min: 0, max: 1e9, default: 0 }, lastBy: { type: 'string', max: 100, default: '' }, lastReceipt: { type: 'string', max: 100, default: '' }, lastCompletedTick: { type: 'number', min: -1, max: 1e12, default: -1 } } as DefInput['state'],
  actions: [{ name: 'exercise', label: 'Complete a 20-second solo stretch and jumping-jack circuit', params: {}, then: [{ op: 'set', field: 'routineSeconds', value: 20 }] }]
};
