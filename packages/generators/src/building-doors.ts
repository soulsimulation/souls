// #2383 doors everywhere: the real door things a door-fitted building revision (make.args.doorThings) takes, one per bare
// doorway (fittedDoorway: every outside door on the ground floor), placed in the doorway's centre on the wall line, its front facing the
// way the wall's outward normal does (core/door@2 swings out), stretched to the opening. Pure: the same params, args and
// pose give the same doors, so a template rewrite and a live-world migration place the same things.
import { buildingLayout, buildingPhysics } from './building.ts';

/** core/door@2's frame is 1.16 m wide and 2.33 m tall at stretch 1; its stretch params are bounded to these. */
const FRAME_W = 1.16, FRAME_H = 2.33, SX: [number, number] = [0.8, 1.8], SY: [number, number] = [0.9, 1.3];
const clamp = (v: number, [a, b]: [number, number]) => Math.min(b, Math.max(a, v));
const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;

export type DoorFit = { opening: string; exterior: boolean; p: [number, number]; r: number; sx: number; sy: number };

/** The doors for a building with these params and def args, placed at `p` (x, z) turned by `r` (yaw, radians). Empty
 *  for a revision that leaves no doorway bare. */
export function buildingDoorFits(params: Record<string, unknown>, args: Record<string, unknown>, pose: { p: [number, number]; r?: number }): DoorFit[] {
  const L = buildingLayout(params, args), baked = buildingPhysics(params, args).openings ?? [];
  const yaw = pose.r ?? 0, c = Math.cos(yaw), s = Math.sin(yaw), out: DoorFit[] = [];
  L.openings.forEach((o, i) => {
    if (o.leaf !== false) return;
    const b = baked[i]!, [x, z] = b.at;
    let r = yaw + b.yaw; while (r > Math.PI + 1e-6) r -= 2 * Math.PI; while (r <= -Math.PI + 1e-6) r += 2 * Math.PI; r = r3(r);
    out.push({ opening: b.id, exterior: o.exterior, p: [r3(pose.p[0] + x * c + z * s), r3(pose.p[1] - x * s + z * c)], r, sx: r2(clamp((b.width - 0.03) / FRAME_W, SX)), sy: r2(clamp(b.height / FRAME_H, SY)) });
  });
  return out;
}

/** The building's ground-floor rooms as world polygons (x, z), for these params and def args at `pose`. */
export function buildingGroundRooms(params: Record<string, unknown>, args: Record<string, unknown>, pose: { p: [number, number]; r?: number }): [number, number][][] {
  const yaw = pose.r ?? 0, c = Math.cos(yaw), s = Math.sin(yaw);
  return (buildingPhysics(params, args).rooms ?? []).filter((r) => r.floor === 0)
    .map((r) => r.polygon.map(([x, z]): [number, number] => [pose.p[0] + x * c + z * s, pose.p[1] - x * s + z * c]));
}
