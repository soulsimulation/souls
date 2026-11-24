// W2 (0.135): the size of each content kind that is a thing (`content/kinds`, `geometry.bounds_mm`; not an activity),
// by kind name. The build fills it (vite.config.ts `kindBounds`); outside the build (tests) it is empty.
export const KIND_BOUNDS: Record<string, number[]> = {};
// The content kinds with their own shape (`looks.shape`), as whole entries by kind name, in one data file the build writes
// beside the bundle (vite.config.ts `kindBounds`); null outside the build.
export const KIND_LOOKS_URL: string | null = null;
