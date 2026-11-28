// FOR-FABLE 16: the stair flight the page draws is the flight the world walks. The world's stair (`geometry.stairs`) runs
// from its foot on the ground to its head at the deck's standing place, and the drawn flight (`looks.shape`, through
// `kindDef`, as the page draws a creator's kind) rises along the same line, at the same transform: the deck bay's
// `stair` slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kindDef } from './creator-kinds.ts';

const kind = (name: string) => readFileSync(new URL(`../../../../content/kinds/construction/${name}.json`, import.meta.url));
const json = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
type Box = { kind: string; at: number[]; size: number[]; roll?: number; tint?: string };

/** A kit box's corners, mm, rolled about its own z (the kit's YXZ Euler with yaw and pitch 0). */
const corners = (s: Box) => {
  const [cx, cy, cz] = s.at.map((v) => v * 1000), [w, h, d] = s.size.map((v) => v * 1000), r = s.roll ?? 0;
  const out: number[][] = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2])
    out.push([cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r), cz + z]);
  return out;
};

test('the drawn stair flight rises along the world\'s stair, from the ground to the deck\'s standing place', () => {
  const flight = json(kind('stair_flight')), bay = json(kind('deck_bay')), sheet = json(kind('plywood_sheet'));
  const [stair] = flight.geometry.stairs as { from_mm: number[]; to_mm: number[]; bottom_mm: number; top_mm: number; width_mm: number }[];
  const slot = bay.slots.stair.at_mm as number[];
  // The world: the flight's foot and head in the bay's frame (the slot turns nothing: FOR-FABLE 10).
  const foot = [slot[0] + stair.from_mm[0], slot[1] + stair.bottom_mm, slot[2] + stair.from_mm[1]];
  const head = [slot[0] + stair.to_mm[0], slot[1] + stair.top_mm, slot[2] + stair.to_mm[1]];
  // The deck's standing place: the sheets' floor, their slot's height plus the sheet's floor top; its west edge.
  const deckTop = bay.slots.s1.at_mm[1] + sheet.geometry.floors[0].top_mm;
  const deckWest = bay.slots.s1.at_mm[0] - sheet.geometry.bounds_mm[0] / 2;
  console.log(`world: foot ${foot.join(', ')} mm, head ${head.join(', ')} mm; the deck's standing place ${deckTop} mm up, its west edge at x ${deckWest}`);
  // The page's drawn flight, at the same transform.
  const drawn = kindDef('mars:stair_flight@0123456789ab', kind('stair_flight'))!;
  const shapes = (drawn.def.make as unknown as { args: { shapes: Box[] } }).args.shapes;
  const treads = shapes.filter((s) => s.tint === 'tread'), stringers = shapes.filter((s) => s.tint !== 'tread');
  const at = (p: number[]) => [slot[0] + p[0], slot[1] + p[1], slot[2] + p[2]].map(Math.round);
  const tops = treads.map((s) => [s.at[0] * 1000, s.at[1] * 1000 + (s.size[1] * 1000) / 2]);
  const all = shapes.flatMap(corners);
  const lo = [0, 1, 2].map((i) => Math.min(...all.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...all.map((c) => c[i])));
  console.log(`drawn: ${treads.length} treads, tops ${tops.map(([x, y]) => `${at([x, y, 0]).slice(0, 2).join('@')}`).join(' ')} (x@y mm, bay frame); bounds ${at(lo).join(', ')} to ${at(hi).join(', ')} mm`);
  for (const s of stringers) {
    const c = corners(s), top = c.filter((p) => p[1] === Math.max(...c.map((q) => q[1])))[0];
    console.log(`drawn stringer: at ${at(s.at.map((v) => v * 1000)).join(', ')} mm, ${Math.round(s.size[0] * 1000)} mm long, turned ${(((s.roll ?? 0) * 180) / Math.PI).toFixed(1)} degrees; highest corner ${at(top).join(', ')}`);
  }

  // The world's stair meets the deck: its head at the deck's standing place, at its west edge.
  assert.equal(head[1], deckTop, 'the stair\'s head is at the deck\'s height');
  assert.ok(Math.abs(head[0] - deckWest) <= 1, `the stair's head at the deck's west edge: ${head[0]} vs ${deckWest}`);
  assert.equal(foot[1], 0, 'its foot on the ground');
  // Each drawn tread's top is on the world's line where it is, within 20 mm, and the drawn flight spans the world's.
  const line = (x: number) => stair.bottom_mm + ((x - stair.from_mm[0]) / (stair.to_mm[0] - stair.from_mm[0])) * (stair.top_mm - stair.bottom_mm);
  for (const [x, y] of tops) assert.ok(Math.abs(y - line(x)) <= 20, `a tread at x ${x} mm, its top ${Math.round(y)} mm; the world's stair there ${Math.round(line(x))} mm`);
  assert.ok(hi[1] <= stair.top_mm + 20, `drawn up to ${Math.round(hi[1])} mm; the world's head ${stair.top_mm} mm`);
  // The stringers rise with it: each one's top edge runs from the world's foot to its head, within 20 mm.
  for (const s of stringers) {
    const top = corners(s).filter((_, k) => k % 4 >= 2 && k % 2 === 0).map(([x, y]) => [x, y]).sort((a, b) => a[0] - b[0]);
    const ends = [[stair.from_mm[0], stair.bottom_mm], [stair.to_mm[0], stair.top_mm]];
    for (const [k, [x, y]] of top.entries()) {
      const [wx, wy] = ends[k];
      assert.ok(Math.hypot(x - wx, y - wy) <= 20, `a stringer's top edge ends at ${Math.round(x)}@${Math.round(y)}; the world's ${wx}@${wy}`);
    }
  }
});
