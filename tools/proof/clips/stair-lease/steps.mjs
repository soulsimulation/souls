// Clip kit (#2264, link-lease/1): in Eden 2026, two Souls climb the Tower House stair while two come down it, sent at
// the same moment. Before the take (at import) all five walk to the tower, Eve and Fin go up to its top, and Ida, who
// only watches, stands in the entrance room off the stair's foot. The camera follows Ida (Ctrl+K, Enter) and is pulled
// out, so it sits off the landing and no body fills the view: one direction holds the flight while the other end waits
// beside it, off its doorway, then the lease turns.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

const UP = ['Ana', 'Ben'], DOWN = ['Eve', 'Fin'], WATCH = 'Ida';
cast({ souls: [...UP, ...DOWN, WATCH].map((name) => ({ name, owner: name === WATCH ? 'admin' : name.toLowerCase() })) });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const TOWER = 'walk:eden-tower-house', TOP = 'walk:eden-tower-house/part-top', DOOR = 'walk:eden-tower-house/part-entrance';
const dir = (name) => join(CLIP_WORK, `soul-${name.toLowerCase()}`);
const act = (name, id, sec) => new Promise((res) => execFile(process.execPath, [EDEN, 'act', id, '--wait', String(sec), '--json'], { cwd: dir(name), encoding: 'utf8', timeout: (sec + 15) * 1000 },
  (e, out, err) => { const r = { name, id, code: e ? (e.code ?? 1) : 0, out: String(out).slice(0, 600), err: String(err).slice(0, 300) }; console.error(`kit: ${JSON.stringify(r)}`); res(r); }));

// before the take: everyone at the tower, the watcher in the entrance room, then the two who come down go up first
await Promise.all([...UP, ...DOWN, WATCH].map((n) => act(n, TOWER, 150)));
await act(WATCH, DOOR, 90);
await Promise.all(DOWN.map((n) => act(n, TOP, 150)));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type(WATCH, { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  // pull the camera out and up, off the landing: wheel out, then a drag that raises the view
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
  await page.mouse.down();
  await page.mouse.move(vp.width / 2, vp.height / 2 + 140, { steps: 12 });
  await page.mouse.up();
  mark('watching the Tower House stair from the entrance room');
  await page.waitForTimeout(2500);
  mark('Ana and Ben go up, Eve and Fin come down, all at once');
  const runs = [...UP.map((n) => act(n, TOP, 90)), ...DOWN.map((n) => act(n, DOOR, 90))];
  for (const r of runs) r.then((x) => mark(`${x.name} ${x.code === 0 ? 'arrived' : 'act ended'}`));
  await Promise.all(runs);
  await page.waitForTimeout(2000);
}
