// The Mars College camp template's shade yard: exported with the Mars map, its copies are the carpentry kinds a crew
// builds with, each named and where the trial expects it; and the trial's steps keep the shade's order.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { runner, templateFacts } from '../rack-bay/rack-bay.mjs';
import { AT, LABELS, RAIL_OUT, buildFour, buildSix, takeDown } from './shade.mjs';

test('the template exports its shade yard in the carpentry kinds, each named, where the trial expects it', () => {
  const dir = mkdtempSync(join(REPO_ROOT, '.local', 'shade-yard-'));
  try {
    const f = JSON.parse(readFileSync(templateFacts({ out: dir }), 'utf8'));
    const kind = Object.fromEntries(f.kinds.map((k) => [k.ref, k.name]));
    const yard = f.things.filter((t) => /^mars:(shade_site|timber_bent|timber_rail|shade_cloth)$/.test(kind[t.ref]));
    assert.deepEqual(yard.map((t) => [t.name, kind[t.ref]]).sort(), [
      ['shade-cloth', 'mars:shade_cloth'], ['shade-site', 'mars:shade_site'], ['timber-bent-1', 'mars:timber_bent'],
      ['timber-bent-2', 'mars:timber_bent'], ['timber-rail-1', 'mars:timber_rail'], ['timber-rail-2', 'mars:timber_rail']]);
    const at = Object.fromEntries(yard.map((t) => [t.name, [t.world[0] / 1000, t.world[2] / 1000]]));
    assert.deepEqual(at['shade-site'], AT.site);
    assert.deepEqual([at['timber-bent-1'], at['timber-bent-2']], AT.bents);
    assert.deepEqual([at['timber-rail-1'], at['timber-rail-2']], AT.rails);
    assert.deepEqual(at['shade-cloth'], AT.cloth);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The commands a crew's steps send, in order, answered ok. */
async function lines(build, n) {
  const said = [];
  let k = 0;
  const seats = Object.fromEntries(LABELS.slice(0, n).map((l) => [l, { cli: async (...words) => {
    said.push([l, ...words]);
    return words[0] === 'carry' && words[1] === 'offer' ? { ok: true, crew: `crew${++k}` } : { ok: true };
  } }]));
  const ids = { site: 'site', bents: ['b1', 'b2'], rails: ['r1', 'r2'], cloth: 'cloth' };
  const bodies = Object.fromEntries(LABELS.map((l) => [l, `${l}-body`]));
  const r = runner(seats, () => {});
  await build(r, bodies, ids);
  return said;
}

test('four and six keep the shade order: both bents, then both rails, then the cloth by four or six', async () => {
  for (const [build, n] of [[buildFour, 4], [buildSix, 6]]) {
    const said = await lines(build, n);
    const at = (pred) => said.findIndex(pred);
    const put = (slot) => at((w) => w[1] === 'part' && w[2] === 'put' && w[5] === slot);
    assert.ok(Math.max(put('bent_a'), put('bent_b')) < Math.min(put('rail_l'), put('rail_r')), `${n}: rails after both bents`);
    assert.ok(Math.max(put('rail_l'), put('rail_r')) < put('cloth'), `${n}: the cloth after both rails`);
    const clothCrew = said.filter((w) => w[1] === 'carry' && w[2] === 'grip' && w[3] === 'cloth');
    assert.equal(new Set(clothCrew.map((w) => w[0])).size, n, `${n}: all ${n} carry the cloth`);
    const walked = said.filter((w) => w[1] === 'carry' && w[2] === 'to' && /^14\.6,15$/.test(w.slice(4).join(' ')));
    assert.deepEqual(walked.map((w) => w[0]), ['ada'], `${n}: only the front's carry to walks the cloth's crew`);
    assert.equal(new Set(said.map((w) => w[0])).size, n, `${n}: every Soul sends its own commands`);
  }
});

test('the take-down takes the cloth off first and holds the bents while the rails come out', async () => {
  const said = await lines(takeDown, 4);
  const i = (pred) => said.findIndex(pred);
  const unseat = (part) => i((w) => w[1] === 'part' && w[2] === 'unseat' && w[4] === part);
  const holds = said.filter((w) => w[1] === 'carry' && w[2] === 'offer' && w.includes('--on'));
  assert.ok(unseat('cloth') < Math.min(unseat('r1'), unseat('r2')), 'the cloth off before either rail');
  assert.ok(said.indexOf(holds[1]) < Math.min(unseat('r1'), unseat('r2')), 'both bents held before the rails come out');
  assert.ok(Math.max(unseat('r1'), unseat('r2')) < Math.min(unseat('b1'), unseat('b2')), 'the bents last');
  // A rail is unseated to its carriers' middle: both its ends stand outside the posts' line first, as far out as the
  // build set it in from (rail_l's posts 0.85 m west of the site's middle, AT.railIn 0.9 m further).
  assert.ok(Math.abs(AT.site[0] - 0.85 - RAIL_OUT - AT.railIn[0][0]) < 1e-9, 'as far out as the build sets a rail in from');
  for (const rail of ['r1', 'r2']) {
    const grips = said.slice(0, unseat(rail)).filter((w) => w[1] === 'carry' && w[2] === 'grip' && w[3] === rail);
    assert.deepEqual(grips.map((w) => [w[4], w[w.indexOf('--out') + 1]]).sort(), [['back', String(RAIL_OUT)], ['front', String(RAIL_OUT)]], `${rail}: its ends stand outside`);
  }
});
