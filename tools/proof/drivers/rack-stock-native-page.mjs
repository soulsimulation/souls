// Stock visibility only: no Soul actions, carry/contact or assembly qualification.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCameraMode } from './camera-native-page.mjs';

export default async function ({ page, paths, check, expectHttp }) {
  expectHttp('/safety.md', 404, 'Optional standalone client documentation is not routed by the old-page front door.');
  const url = new URL(page.url());
  url.search = 'post=0&hour=12:00&eye=-2,2.8,23.4&at=-3.55,.05,20';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `accessibility-before-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  const bounds = await page.locator('canvas').first().boundingBox();
  check('stock-page-canvas', !!bounds && bounds.width > 100 && bounds.height > 100);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(paths.dir, 'rack-stock-before-input.png') });
  await snapshot('pointer-move'); await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5);
  await snapshot('pointer-down'); await page.mouse.down();
  await snapshot('pointer-drag'); await page.mouse.move(bounds.x + bounds.width * .52, bounds.y + bounds.height * .51, { steps: 12 });
  await snapshot('pointer-up'); await page.mouse.up();
  await snapshot('keyboard-w'); await page.keyboard.press('KeyW');
  check('real-input-manual-camera', await page.locator('.viewer-history').getAttribute('data-viewer-mode') === 'manual');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(paths.dir, 'rack-stock-after-input.png') });
}
