// Clip kit (#2283, PR #2292): in Eden 2026, admin's Soul Runa runs (`act walk:<an upstairs room> --run --wait`) from
// where it stands to a room up a stair, the camera following it (Ctrl+K, Enter) the whole way.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Runa', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), DIR = join(CLIP_WORK, 'soul-runa');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** The nearest offered walk to an upstairs room (`caps --search`, the local catalog, with each row's metres). */
function target() {
  for (let i = 0; i < 30; i++) {                          // a world just up may not give its catalog yet (503)
    const r = spawnSync(process.execPath, [EDEN, 'catalog'], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) break;
    spawnSync('sleep', ['2']);
  }
  for (const words of ['upstairs', 'roof']) {
    const r = spawnSync(process.execPath, [EDEN, 'caps', '--search', words, '--verb', 'walk', '--all', '--json'], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
    const offers = (parse(r.stdout)?.offers ?? []).filter((o) => /^walk:/.test(o.id ?? '')).sort((a, b) => (a.metres ?? 1e9) - (b.metres ?? 1e9));
    console.error(`kit: caps --search ${words}: ${JSON.stringify(offers.slice(0, 6))} ${r.status ? r.stderr.slice(0, 400) : ''}`);
    if (offers[0]) return offers[0].id;
  }
  throw Error('kit: no walk to an upstairs room is offered');
}
const TARGET = target();
console.error(`kit: target ${TARGET}`);

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => res({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) })));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Runa', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Runa');
  await page.waitForTimeout(4000);                        // the camera settles on Runa
  mark(`run to ${TARGET}`);
  const r = await eden(['act', TARGET, '--run', '--wait', '70', '--json'], 80_000);
  console.error(`kit: act exit ${r.code}: ${(r.out || r.err).slice(0, 1500)}`);
  mark(r.code === 0 ? 'arrived' : 'act ended');
  await page.waitForTimeout(4000);                        // Runa upstairs, at rest
}
