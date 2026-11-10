import furniture from './furniture.json' with {type: 'json'};
import type {DefInput} from '../schemas.ts';

// Opt-in transport; the original fixed table and its authored surface stay unchanged.
const table = structuredClone(furniture.find(d => d.name === 'core-table')!) as unknown as DefInput;
export const CAMP_TABLE: DefInput = {...table, version: 2,
  description: 'A campsite table carried upright with both hands while empty. Place it at a chosen clear campsite, then put real bowls, lanterns or other fitting items on its surface and take them back. Unload the table before moving it again.',
  tags: [...(table.tags ?? []), 'upright-carry', 'camping'],
  components: {...table.components, carryable: {mass: 15, grips: 2}},
};
