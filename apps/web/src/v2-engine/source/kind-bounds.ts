// W2 (0.135): the size of each content kind that is a thing (`content/kinds`, `geometry.bounds_mm`; not an activity),
// by kind name. The build fills it (vite.config.ts `kindBounds`); outside the build (tests) it is empty.
export const KIND_BOUNDS: Record<string, number[]> = {};
