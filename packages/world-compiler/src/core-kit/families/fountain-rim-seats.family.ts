// A Soul sits on the rim of a fountain. core-fountain@1 (civic.json) keeps its bytes; @2 is the same fountain with six
// seats on its basin's rim, one outside each of @1's six stand points (`edge-n`), facing out. Each seat's height and
// distance from the middle come from the model's own basin (its first lathe): the middle of the rim's top, between
// the outer wall's top and the inner lip. SEATDEF: a seat's height is the model's; the rim is far below a body's
// standing reach.
import civic from '../civic.json' with { type: 'json' };
import type { DefInput } from '../../schemas.ts';

const v1 = civic.find((d) => d.name === 'core-fountain')! as unknown as DefInput;
type Slot = NonNullable<DefInput['slots']>[number];
const shapes = (v1.make as unknown as { args: { shapes: { kind: string; profile?: [number, number][] }[] } }).args.shapes;

/** The rim's top in the basin's profile (`[radius, height]` m): its two highest points off the axis, the outer wall's
 *  top and the inner lip. A seat sits at their middle. */
export function rimOf(profile: readonly (readonly [number, number])[]): { r: number; y: number } {
  const [a, b] = profile.filter(([r]) => r > 0).sort((p, q) => q[1] - p[1]);
  return { r: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
}

export const RIM = rimOf(shapes.find((s) => s.kind === 'lathe')!.profile!);
const round = (v: number) => Math.round(v * 1000) / 1000;

/** One seat on the rim for each of @1's stand points, on the same bearing, facing out (+z turned by `yaw`). */
const rim: Slot[] = (v1.slots ?? []).filter((s) => s.kind === 'stand').map((s, i) => {
  const bearing = Math.atan2(s.p[0], s.p[2]);
  return { id: `rim-${i + 1}`, kind: 'seat', p: [round(RIM.r * Math.sin(bearing)), RIM.y, round(RIM.r * Math.cos(bearing))], yaw: bearing, height: RIM.y, accepts: { tags: ['body'] }, capacity: 1 };
});

export const FOUNTAIN_2: DefInput = {
  ...structuredClone(v1), version: 2,
  description: 'A round stone fountain (4 m) with a two-tier bowl and water; a gathering spot. Six can sit on its rim, facing out.',
  tags: [...(v1.tags ?? []), 'seat'],
  slots: [...rim, ...structuredClone(v1.slots ?? [])],
};

export default [FOUNTAIN_2];
