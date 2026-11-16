// #2201 A2 (docs/design/auto-camera.md §2): a critically damped spring, stepped in closed form. With x the offset from
// the goal, v its velocity and ω = 2π/T, after dt: x' = (x + (v + ωx)·dt)·e^{−ω·dt}, v' = (v − ω(v + ωx)·dt)·e^{−ω·dt}.
// The step is exact for a goal held over dt, so 30, 60 and 120 Hz frames trace the same path, and the velocity carries
// over when the goal moves: the camera eases out of rest and into its goal, never with a step in speed. Pure arithmetic.

/** Position and velocity of one coordinate after `dt` seconds toward `goal`, with period `period` seconds. */
export function springStep(x: number, v: number, goal: number, period: number, dt: number): { x: number; v: number } {
  if (!(dt > 0) || !(period > 0)) return { x, v };
  const w = 2 * Math.PI / period, e = Math.exp(-w * dt), d = x - goal, carry = (v + w * d) * dt;
  return { x: goal + (d + carry) * e, v: (v - w * carry) * e };
}

/** The same for an angle: the goal is taken the short way round (within ±π of x). */
export function springAngle(x: number, v: number, goal: number, period: number, dt: number): { x: number; v: number } {
  const d = goal - x;
  return springStep(x, v, x + Math.atan2(Math.sin(d), Math.cos(d)), period, dt);
}
