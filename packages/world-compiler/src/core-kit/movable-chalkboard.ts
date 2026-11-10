import {WRITABLE_BOARDS} from './writable-boards.ts';
import type {DefInput} from '../schemas.ts';

// Opt-in revision: the same writable face and attributed state travel with the native fixture.
const board = structuredClone(WRITABLE_BOARDS.find(d => d.name === 'core-chalkboard' && d.version === 2)!);
export const MOVABLE_CHALKBOARD: DefInput = {...board, version: 3,
  description: 'A movable A-frame chalkboard. Write a short attributed message by hand, carry it upright with two hands to a chosen place, then read, rewrite or wipe it there.',
  tags: [...(board.tags ?? []), 'upright-carry'],
  components: {...board.components, carryable: {mass: 7, grips: 2}},
};
