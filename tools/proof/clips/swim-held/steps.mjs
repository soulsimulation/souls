// Clip kit (lane L3: #1952, #2032, #1288 wait bounds): in Eden 2026, Bo swims out into the west lake and treads there.
// Ann takes the same swim and is held behind him (swim.occupied). The camera follows Ann (Ctrl+K, Enter): under
// wait-bound/2 her swim ends route.blocked about a minute after her last headway, naming Bo, and she is left treading
// where she is. Each act's receipt is logged.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Bo', owner: 'admin' }, { name: 'Ann', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const SWIM = 'swim:land-west-lake';
const eden = (name, args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: join(CLIP_WORK, `soul-${name.toLowerCase()}`), encoding: 'utf8', timeout: ms },
  (e, out, err) => res({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) })));
const said = (n, r) => console.error(`kit: ${n} exit ${r.code}: ${(r.out || r.err).slice(0, 1200)}`);

// before the page opens: Bo swims out and treads (not filmed)
said('Bo swims out', await eden('Bo', ['act', SWIM, '--wait', '170', '--json'], 180_000));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ann', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Ann');
  await page.waitForTimeout(2000);
  mark('Ann takes the same swim as Bo');
  const ann = await eden('Ann', ['act', SWIM, '--wait', '170', '--json'], 180_000);
  said('Ann', ann);
  const end = /"phase":\s*"(\w+)"/.exec(ann.out)?.[1] ?? 'unknown', code = /"code":\s*"([\w.]+)"/.exec(ann.out)?.[1] ?? '';
  mark(`Ann's swim ${end} ${code}`.trim());
  await page.waitForTimeout(4000);
}
