// #2263 (stair lease, task 1; docs/design/stair-traffic.md): on the Eden 2026 template, every end of every Tower House
// flight has at least two holding spots, each with standing room, out of the flight's way and of every flight that
// shares its floor. Read-only: the nav computes them, nothing in the engine reads them yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {clearanceAt, segmentClearance} from '../../../mars/viewer/engine/spatial/grid.ts';
import {singleFile} from '../../../mars/viewer/engine/spatial/holding.ts';
import {linkApproach, PLAN_MARGIN} from '../../../mars/viewer/engine/spatial/path.ts';
import {HUMAN_PROFILE, type Link} from '../../../mars/viewer/engine/spatial/types.ts';
import type {Spatial} from '../../../mars/viewer/engine/spatial/service.ts';
import type {Vec2} from '../../../mars/viewer/engine/core/math.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';
const R = HUMAN_PROFILE.radius, BODY = 2 * R, d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// The flight as a body on `level` meets it, built here from the link's own fields (not holding.ts): that floor's entry and
// approach points and the steps from a step below the floor to head height above it.
const flightOn = (link: Link, level: number): Vec2[] => {
  const y = link.from.level === level ? link.from.y : link.to.y;
  const steps = link.path.filter(s => s[1] >= y - 0.3 && s[1] <= y + HUMAN_PROFILE.height).map((s): Vec2 => [s[0], s[2]]);
  return [...(link.from.level === level ? [linkApproach(link, true).approach, link.from.p] : []), ...steps, ...(link.to.level === level ? [link.to.p, linkApproach(link, false).approach] : [])];
};
const lineDist = (pts: Vec2[], q: Vec2) => Math.min(...pts.slice(1).map((b, i) => {
  const a = pts[i], dx = b[0] - a[0], dz = b[1] - a[1], n = dx * dx + dz * dz, t = n ? Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / n)) : 0;
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz);
}));

test('#2263 Eden 2026: every Tower House flight end has two holding spots clear of the flight', {timeout: 300_000, skip: NO_EDEN}, async t => {
  const w = await bootEden();
  t.after(() => w.close());
  const tower = [...(w.god as unknown as {model: {entities: Map<string, {id: string; name?: string}>}}).model.entities.values()].find(e => e.name === 'eden-tower-house');
  assert.ok(tower, 'the template has the Tower House');
  const rt = (w.host.engine as unknown as {rt: {world: never; services: {spatial: Spatial}}}).rt, sp = rt.services.spatial;
  sp.sync(rt.world);
  const links = ((sp as unknown as {pages?: {all: {links: Link[]}}}).pages?.all ?? sp.scene).links;
  const flights = links.filter(l => l.id.startsWith(`${tower.id}#`));
  assert.equal(flights.length, 3, `three flights: ${flights.map(l => l.id).join(', ')}`);
  for (const link of flights) {
    assert.ok(singleFile(link), `${link.id} is single-file (${link.width} m)`);
    for (const ascending of [true, false]) {
      const end = `${link.id} ${ascending ? 'bottom' : 'top'}`, {entry, approach} = linkApproach(link, ascending);
      const spots = sp.holdingSpots(link, ascending), g = sp.levelAt(entry.level, approach)!;
      assert.ok(spots.length >= 2, `${end}: ${JSON.stringify(spots)}`);
      const sharing = flights.filter(f => f.from.level === entry.level || f.to.level === entry.level);
      for (const s of spots) {
        assert.ok(clearanceAt(g, s) >= R + PLAN_MARGIN, `${end}: standing room at ${s}`);
        assert.ok(d(s, approach) >= BODY && d(s, entry.p) >= BODY, `${end}: a body width from the approach and entry points at ${s}`);
        for (const f of sharing) { const line = flightOn(f, entry.level); assert.ok(line.length > 2); assert.ok(lineDist(line, s) >= f.width / 2 + R, `${end}: clear of ${f.id} at ${s}`); }
        assert.ok(segmentClearance(g, s, approach) >= R, `${end}: a clear walk to the approach point from ${s}`);
      }
      assert.deepEqual(sp.holdingSpots(link, ascending), spots, `${end}: the same answer again`);
    }
  }
});
