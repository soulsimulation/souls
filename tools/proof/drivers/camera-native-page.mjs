// Real UI journey on the customer page; test hooks only observe readiness/mode, never supply actor/camera poses.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setCameraMode } from '../../browser/world-controls.mjs';
export default async function ({ page, paths, check, base }) {
  await page.waitForFunction(() => !!document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const canvas = page.locator('canvas').first(), bounds = await canvas.boundingBox();
  check('native-customer-page-drawn', !!bounds && bounds.width > 100 && bounds.height > 100);
  check('native-stream-selected', await page.evaluate(() => typeof globalThis.__simConfig?.v2Stream === 'string'));
  await setCameraMode(page, 'manual');
  await page.keyboard.press('Escape');
  await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .55, { steps: 12 }); await page.mouse.up();
  await page.keyboard.press('KeyW');
  check('real-input-manual-takeover', await page.locator('.viewer-history').getAttribute('data-viewer-mode') === 'manual');
  await page.screenshot({ path: join(paths.dir, 'native-manual.png') });
  await setCameraMode(page, 'broadcast'); await page.keyboard.press('Escape');
  check('real-input-broadcast', await page.locator('.viewer-history').getAttribute('data-viewer-mode') === 'broadcast');
  check('owned-origin-retained', new URL(page.url()).origin === new URL(base).origin);
  writeFileSync(join(paths.dir, 'native-input-facts.json'), JSON.stringify({ qualification: 'capture/input only', viewport: page.viewportSize(), canvas: bounds, input: ['mode-button click', 'pointer drag', 'keyboard W', 'Broadcast click'] }, null, 2), { flag: 'wx' });
  await page.waitForTimeout(1200);
}
