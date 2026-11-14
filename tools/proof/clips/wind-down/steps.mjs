// Clip kit (#2295): the wind-down with short knobs (kit.json `bodyKnobs`: silent 15 s instead of an hour, the walk to
// sleep 15 s into Wander instead of 30 min, asleep within 30 s of Wander instead of 50 min). admin's Soul Ada reads for
// 10 s, then its agent stays silent (listening only): it stands, wanders off, shuffles to open ground and lies down.
// Then one act (a wave) and it stands. The camera follows Ada (Ctrl+K, Enter) the whole take (under the recorder's 90 s).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Ada', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), DIR = join(CLIP_WORK, 'soul-ada');
const eden = (args) => new Promise((res) => execFile(process.execPath, [EDEN, ...args], { cwd: DIR, encoding: 'utf8', timeout: 30_000 },
  (e, out, err) => { console.error(`kit: ${args.join(' ')} -> ${e ? 'failed ' + String(err).slice(0, 200) : 'ok'}`); res(String(out)); }));

export default async function steps(page, { mark }) {
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  await page.keyboard.type('Ada', { delay: 100 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await eden(['act', 'read:here', '{"seconds":10}', '--for', 'none']);
  mark('reading 10 s; the agent is silent from here');
  await page.waitForTimeout(15_000);
  mark('silent 15 s (short knob): Wander');
  await page.waitForTimeout(15_000);
  mark('walk out to sleep');
  await page.waitForTimeout(17_000);
  mark('asleep: one act now');
  await eden(['act', 'wave:here', '--for', 'none']);
  await page.waitForTimeout(8_000);
}
