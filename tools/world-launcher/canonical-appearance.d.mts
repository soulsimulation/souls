import type {Appearance} from '../../apps/web/src/v2-engine/canonical-appearance.ts';
export type AppearanceInput = {world:string;stream:string;facts:string;kinds:string;entries:readonly(string|Uint8Array)[];editKinds:(text:string)=>string};
export function canonicalAppearance(input:AppearanceInput):Appearance;
export function publishCanonicalAppearance(input:{world:string;stream:string;directory:string;pkg:string;out:string;factsFile?:string}):Promise<{file:string;sha256:string;world:string;stream:string}>;
