// Clip kit (#1223): two notebook stands placed in front of the camera by the world's god, each with written lines. The
// public one shows its lines; the private one is drawn closed ("Private"). Then the god makes the public one private
// and the viewer closes it live, from the world-diff that no longer carries its words.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cast } from '../_shared/cast.mjs';

cast({ god: 'admin' });
const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const GOD = join(CLIP_CHECKOUT, 'tools/god-skill/eden-god.mjs');
function act(ops) {
  const r = spawnSync(process.execPath, [GOD, 'act', JSON.stringify({ ops })], { cwd: join(CLIP_WORK, 'god'), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw Error(`act failed (${r.status}): ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout;
}
const cam = (page) => page.evaluate(() => globalThis.__soulsCamera ?? null);

export default async function steps(page, { mark }) {
  await page.waitForFunction(() => !!globalThis.__soulsCamera, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const box = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(box.width / 2, box.height / 2);
  for (let i = 0; i < 40; i++) {                          // zoom in on the pivot until the eye is a few metres off
    const c = await cam(page); const d = Math.hypot(c.p[0] - c.pivot[0], c.p[1] - c.pivot[1], c.p[2] - c.pivot[2]);
    if (d < 4.5) break;
    await page.mouse.wheel(0, -240); await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  const c = await cam(page), [px, , pz] = c.pivot, yaw = Math.atan2(c.p[0] - px, c.p[2] - pz);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw), at = (k) => [+(px + rx * k).toFixed(2), +(pz + rz * k).toFixed(2)];
  act([
    { op: 'place', def: 'core/notebook-stand@1', name: 'open-notebook', p: at(-0.9), r: yaw },
    { op: 'place', def: 'core/notebook-stand@1', name: 'diary', p: at(0.9), r: yaw, owner: 'soul:Ana', access: 'private' },
  ]);
  mark('placed: open notebook (left), private diary (right)');
  await page.waitForTimeout(1500);
  const ids = JSON.parse(await page.evaluate(async () => {
    const base = location.pathname.replace(/\/$/, ''), snap = await (await fetch(base + '/v1/world/snapshot')).json();
    return JSON.stringify(Object.fromEntries(snap.entities.filter((e) => e.name === 'open-notebook' || e.name === 'diary').map((e) => [e.name, e.id])));
  }));
  act([
    { op: 'set', id: ids['open-notebook'], state: { text: 'The kite is back — Ben\nCame by at noon — Mira', textBy: 's_ben,s_mira' } },
    { op: 'set', id: ids.diary, state: { text: 'I am afraid of the dark — Ana', textBy: 's_ana' } },
  ]);
  mark('both written: the open one shows its lines, the private one stays closed');
  await page.waitForTimeout(7000);
  act([{ op: 'set', id: ids['open-notebook'], owner: 'soul:Ben', access: 'private' }]);
  mark('god makes the open notebook private');
  await page.waitForTimeout(7000);
  const leaked = await page.evaluate(async () => (await (await fetch(location.pathname.replace(/\/$/, '') + '/v1/world/snapshot')).text()).includes('afraid of the dark'));
  mark(leaked ? 'snapshot still has the words' : 'snapshot has no private words');
  await page.waitForTimeout(2000);
}
