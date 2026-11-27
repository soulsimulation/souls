const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => { const k = clamp(x); return k * k * (3 - 2 * k); };

/** Same nearby-support policy as ground-foot-fit: the recorded root protects slabs above visual terrain. */
export function seatedSupportY(rootY: number, groundY?: number | null): number {
  return groundY != null && Number.isFinite(groundY) && Math.abs(groundY - rootY) <= .12 ? Math.max(rootY, groundY) : rootY;
}

/** A reachable seated foot can rest on support; an unreachable high seat keeps its authored dangling layout.
 * Fade before legTo's existing .995 extension limit, rather than locking a knee or changing a bone length. */
export function seatedFootWeight(hip: readonly number[], goal: readonly number[], length: number, phase: number): number {
  if (![...hip, ...goal, length, phase].every(Number.isFinite) || length <= 0) return 0;
  const reach = Math.hypot(goal[0] - hip[0], goal[1] - hip[1], goal[2] - hip[2]) / length;
  return clamp(phase) * smooth((.995 - reach) / .025);
}
