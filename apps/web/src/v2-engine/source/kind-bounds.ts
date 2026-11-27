// W2 (0.135): the size of each content kind that is a thing (`content/kinds`, `geometry.bounds_mm`; not an activity),
// by kind name. The build fills it (vite.config.ts `kindBounds`); outside the build (tests) it is empty.
export const KIND_BOUNDS: Record<string, number[]> = {};
// The content kinds with their own shape (`looks.shape`), as whole entries by kind name, in one data file the build writes
// beside the bundle (vite.config.ts `kindBounds`); null outside the build.
export const KIND_LOOKS_URL: string | null = null;
// Each content kind's state fields a look can read (bool, int, enum: `{lit: [28, 'bool']}`), by kind name, in one data
// file the build writes beside the bundle, for world-state.ts (`setKindFields`): what a thing's fields say of it, named
// by its entry. Null outside the build.
export const KIND_STATE_URL: string | null = null;

/** Entry slot numbers are one-based, in declaration order. A missing posture declares a standing place; it is not
 *  a seat. Public stream slot coordinates take precedence over these entry coordinates when present. */
export type BodySlot = { row: number[]; posture: 'stand' | 'sit' | 'lie' };
export const KIND_SLOTS: Record<string, BodySlot[]> = {};
