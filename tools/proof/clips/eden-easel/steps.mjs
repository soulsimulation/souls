// Clip kit (#1871): in Eden 2026, admin's Soul Pia acts on the Eden House 4 easel's paint offer by its id (refused
// spot.no-room before: the easel faced the living room's south wall, so its standing point was inside the wall), walks into
// the living room and paints, the camera following it (Ctrl+K, Enter) the whole way.
import { execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Pia', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), DIR = join(CLIP_WORK, 'soul-pia');
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** The Eden House 4 easel's paint offer (`caps --search`, the local catalog). */
function target() {
  for (let i = 0; i < 30; i++) {                          // a world just up may not give its catalog yet (503)
    const r = spawnSync(process.execPath, [EDEN, 'catalog'], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0) break;
    spawnSync('sleep', ['2']);
  }
  const r = spawnSync(process.execPath, [EDEN, 'caps', '--search', 'eden house 4 easel', '--all', '--json'], { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
  const offers = (parse(r.stdout)?.offers ?? []).filter((o) => /^paint:/.test(o.id ?? ''));
  console.error(`kit: caps --search: ${JSON.stringify(offers.slice(0, 6))} ${r.status ? r.stderr.slice(0, 400) : ''}`);
  const easel = offers.find((o) => /eden house 4/i.test(JSON.stringify(o)));
  if (!easel) throw Error('kit: the Eden House 4 easel offers no paint');
  return easel.id;
}
const TARGET = target();
console.error(`kit: target ${TARGET}`);

const eden = (args, ms) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: ms },
  (e, out, err) => res({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) })));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Pia', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Pia');
  await page.waitForTimeout(3000);                        // the camera settles on Pia
  mark(`act ${TARGET}`);
  const r = await eden(['act', TARGET, '--json'], 30_000);
  console.error(`kit: act exit ${r.code}: ${(r.out || r.err).slice(0, 800)}`);
  // painting has no end of its own, so `act --wait` would hold the whole window: wait in short polls until Pia paints
  let painting = false;
  for (let i = 0; i < 12 && !painting && /"accepted": true/.test(r.out); i++) {
    const w = await eden(['wait', '6', '--json'], 15_000);
    painting = /"activity": "paint"/.test(w.out);
  }
  console.error(`kit: painting ${painting}`);
  mark(painting ? 'painting at the easel' : 'not painting');
  await page.waitForTimeout(8000);                        // Pia at the easel, painting
}
