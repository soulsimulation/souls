// A native carry's facing. The take (takes.ts) asks; the page's carry feed answers. Its own small module so neither
// imports the other: the take's code stays in its chunk.
/** The heading (radians, atan2(dz, dx)) the world has body `entity` turned to at world time t µs while it holds a
 *  carried load, else null. */
type CarryHeading = (entity: string, t: number) => number | null;
let source: CarryHeading | null = null;
/** Set by the page's carry feed; null (the default): no body holds a native carry. */
export const setCarryHeading = (f: CarryHeading | null) => { source = f; };
export const carryHeading: CarryHeading = (entity, t) => (source ? source(entity, t) : null);
