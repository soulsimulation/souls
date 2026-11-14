// Clip kit (#2294): Ada reads where she stands for 15 s (a held activity: a start and an end tick), then stands up by
// herself on its end tick, with no further act from her agent.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Ada', owner: 'admin' }] });
const { CLIP_CHECKOUT = '.', CLIP_WORK = '.' } = process.env;
const eden = (...args) => spawnSync(process.execPath, [join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs'), ...args], { cwd: join(CLIP_WORK, 'soul-ada'), encoding: 'utf8', timeout: 60_000 });

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ada', { delay: 140 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Ada');
  await page.waitForTimeout(4000);
  const r = eden('act', 'read:here', '{"seconds":15}');
  console.log('[held-read] act', r.status, (r.stdout || r.stderr).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400));
  mark('read 15 s');
  await page.waitForTimeout(21_000);                     // reading, then standing up by herself at the end tick
  mark('stood up');
  await page.waitForTimeout(3000);
}
