// Clip kit (#1243): in Eden 2026, admin's Soul Ana walks (`act walk:<a kitchen stool> --wait`) from inside its house to a
// kitchen stool whose stand point has no standing room beside the counter. Before #1243 that walk's goal was the kitchen
// wall's outer face (campus-residence-1: a 12 m walk round to it); now it is standing room in the kitchen. The camera
// follows Ana (Ctrl+K, Enter); her position at the end is logged with the kitchen's outline.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Ana', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), DIR = join(CLIP_WORK, 'soul-ana');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const run = (args) => spawnSync(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
for (let i = 0; i < 30; i++) { if (run(['catalog']).status === 0) break; spawnSync('sleep', ['2']); }   // a world just up may 503

/** The first offered walk of these kitchen stools (each measured on #1243 with its stand's search outside the kitchen). */
const HOUSES = ['campus-residence-1', 'campus-residence-2', 'region-farm-hamlet-farmhouse', 'region-west-river-watermill', 'alpine-chalet-1'];
const r = run(['caps', '--search', 'kitchen stool', '--verb', 'walk', '--all', '--json']);
const offers = (parse(r.stdout)?.offers ?? []).filter((o) => /^walk:.*\/kitchen-stool$/.test(o.id ?? ''));
console.error(`kit: kitchen stools offered: ${JSON.stringify(offers.map((o) => [o.id, o.metres]).slice(0, 12))} ${r.status ? r.stderr.slice(0, 400) : ''}`);
const HOUSE = HOUSES.find((h) => offers.some((o) => o.id === `walk:${h}/kitchen-stool`));
if (!HOUSE) throw Error('kit: none of the measured kitchen stools is offered');
const STOOL = `walk:${HOUSE}/kitchen-stool`;
console.error(`kit: target ${STOOL}`);

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => res({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) })));
const said = (n, x) => console.error(`kit: ${n} exit ${x.code}: ${(x.out || x.err).slice(0, 1500)}`);

// before the page opens: Ana walks into the house (not filmed)
said(`Ana into ${HOUSE}`, await eden(['act', `walk:${HOUSE}`, '--wait', '170', '--json'], 180_000));
said('Ana here', await eden(['here', '--json'], 60_000));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ana', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark(`follow Ana, in ${HOUSE}`);
  await page.waitForTimeout(3000);
  mark(`walk to ${STOOL}`);
  const a = await eden(['act', STOOL, '--wait', '80', '--json'], 90_000);
  said('Ana to the stool', a);
  const i = a.out.indexOf('"endedAt"');   // where the walk ended (x, z), for the kitchen's outline
  console.error(`kit: ended ${i < 0 ? 'unknown' : a.out.slice(i, i + 200).replace(/\s+/g, ' ')}`);
  mark(a.code === 0 ? 'arrived' : 'act ended');
  said('Ana here', await eden(['here', '--json'], 60_000));
  await page.waitForTimeout(4000);
}
