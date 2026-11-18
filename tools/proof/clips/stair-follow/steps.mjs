// Clip kit (#1530, PR #1544): in Eden 2026, two of admin's Souls stand at the foot of the Tower House stair. Ana climbs to
// the top; Ben starts up a moment later, close behind her. The camera follows Ben (Ctrl+K, Enter) the whole way: under
// climb-spacing/1 he waits behind Ana on the flight and is never settled off it. Each walk's receipt is logged.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const FOOT = 'walk:eden-tower-house', TOP = 'walk:eden-tower-house/part-top';
const eden = (name, args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: join(CLIP_WORK, `soul-${name.toLowerCase()}`), encoding: 'utf8', timeout: ms },
  (e, out, err) => res({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) })));
const said = (n, r) => console.error(`kit: ${n} exit ${r.code}: ${(r.out || r.err).slice(0, 1200)}`);

// before the page opens: both Souls walk to the stair's foot (not filmed)
said('Ana to the foot', await eden('Ana', ['act', FOOT, '--wait', '170', '--json'], 180_000));
said('Ben to the foot', await eden('Ben', ['act', FOOT, '--wait', '170', '--json'], 180_000));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ben', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Ben, at the stair foot');
  await page.waitForTimeout(3000);
  mark('Ana climbs');
  const ana = eden('Ana', ['act', TOP, '--wait', '110', '--json'], 120_000);
  await page.waitForTimeout(1500);
  mark('Ben climbs behind her');
  const ben = eden('Ben', ['act', TOP, '--wait', '110', '--json'], 120_000);
  const [a, b] = await Promise.all([ana, ben]);
  said('Ana', a); said('Ben', b);
  mark(`Ana ${a.code === 0 ? 'arrived' : 'ended'}, Ben ${b.code === 0 ? 'arrived' : 'ended'}`);
  await page.waitForTimeout(3000);
}
