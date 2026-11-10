import {HAND_WATER} from './hand-water.ts';
import type {DefInput} from '../schemas.ts';

// Opt-in transport only: the existing valve, spray and contact-time irrigation stay native.
const sprinkler = structuredClone(HAND_WATER.find(d => d.name === 'core-garden-sprinkler')!);
export const PORTABLE_SPRINKLER: DefInput = {...sprinkler, version: 2,
  description: 'A portable garden sprinkler. Carry it upright with both hands to a chosen clear place and set it down. Turning its valve on waters the planters in its forward arc within reach at hand contact; turning it off keeps their soil wet. Move the same sprinkler to tend another patch. It does not continuously simulate irrigation.',
  tags: [...(sprinkler.tags ?? []), 'upright-carry'],
  components: {...sprinkler.components, carryable: {mass: 3, grips: 2}},
};
