import {HAND_FIRE} from './hand-fire.ts';
import type {DefInput} from '../schemas.ts';

// Opt-in revision: native transport retains the existing candle, wick contact and light.
const stand = structuredClone(HAND_FIRE.find(d => d.name === 'core-candle-stand')!);
export const MOVABLE_CANDLE_STAND: DefInput = {...stand, version: 2,
  description: 'A movable floor candle stand. Carry it upright with both hands to a chosen clear place, then light or put out its candle by hand at the wick. Its placement and on/off state persist together.',
  tags: [...(stand.tags ?? []), 'upright-carry'],
  components: {...stand.components, carryable: {mass: 5, grips: 2}},
};
