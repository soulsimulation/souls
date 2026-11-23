// The effects' clock (0.131 parity C8, #3679): world seconds, wrapped to ten minutes so the shaders' floats keep their
// precision (one pattern jump per 10 min, as today's fire). Set once a frame from the page's world time, so a seek or
// a replay draws the same flames, steam and water as playing to that moment does.
export const FX_TIME = { value: 0 };
export function tickFx(worldSeconds: number): void {
  FX_TIME.value = ((worldSeconds % 600) + 600) % 600;
}
