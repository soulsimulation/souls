import {REPAIR_DEFS} from './repair.ts';
import type {DefInput} from '../schemas.ts';

// Opt-in revision: native transport preserves the repairable slat and usable seats.
const bench = structuredClone(REPAIR_DEFS.find(d => d.name === 'core-bench')!);
export const CAMP_BENCH: DefInput = {...bench, version: 3,
  description: 'A movable two-person bench for a campsite. Carry it upright with both hands to clear ground; mend a cracked slat with a hammer there, then sit on the same bench. Damage, repair record and placement persist.',
  tags: [...(bench.tags ?? []), 'upright-carry', 'camping'],
  components: {...bench.components, carryable: {mass: 24, grips: 2}},
};
