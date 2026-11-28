/** Immutable observed held boundaries. These times are drawing observations, never native transfer phases. */
import type {SampledHuman} from './humans.ts';
import {heldProjections} from './held-projection.ts';
export const HELD_ARM_EASE=.4;
export type HeldArmOrigin={
  at:number; age:number; hands:readonly ('left'|'right')[]; sample:SampledHuman;
  history?:readonly {offset:number;age:number;hands:readonly ('left'|'right')[];sample:SampledHuman}[];
  context?:object;
  /** Internal collapsed pose for the isolated evaluator, never sampled from the previous painted frame. */
  drawn?:import('./humans.ts').DrawnOrigin;
};
/** Contents/tint changes do not manufacture another pickup. Native binding/local frame changes do. */
export function heldArmBinding(sample:Pick<SampledHuman,'heldEntries'|'nativeHands'>):string|undefined {
  if(!sample.heldEntries||!sample.nativeHands)return undefined;
  const projections=heldProjections(sample.heldEntries,sample.nativeHands);if(projections.length!==sample.heldEntries.entries.length)return undefined;
  return JSON.stringify(projections.map(({entry,hand})=>[entry.id,entry.kind,entry.parent,entry.slot,hand,entry.pos,entry.rot]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}
export function heldArmHands(...samples:Pick<SampledHuman,'heldEntries'|'nativeHands'>[]):('left'|'right')[]{
  return [...new Set(samples.flatMap(s=>heldProjections(s.heldEntries,s.nativeHands).map(p=>p.hand)))];
}
