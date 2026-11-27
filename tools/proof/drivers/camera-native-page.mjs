// Real UI journey on the customer page; observe the exact navigation response, never restore consumed globals or poses.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const observations = new WeakMap();
export function suppliedNativeStream(html) {
  const configs = [...html.matchAll(/<script>window\.__simConfig=([^<]+)<\/script>/g)];
  if (configs.length !== 1) throw Error('native-document-config-missing-or-ambiguous');
  const stream = JSON.parse(configs[0][1]).v2Stream;
  if (typeof stream !== 'string' || !/^\/s\/[A-Za-z0-9._/-]+\/$/.test(stream) || stream.split('/').some(s => s === '.' || s === '..')) throw Error('native-document-stream-invalid');
  return stream;
}
export function displayedNativeTick(value) {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value));
}
export function beforeNavigation({ page, base }) {
  const state = { documents: [], responses: [] }; observations.set(page, state);
  const response = value => {
    const url = new URL(value.url()); if (url.origin !== new URL(base).origin) return;
    state.responses.push({ path: url.pathname, status: value.status() });
    if (value.request().isNavigationRequest() && value.frame() === page.mainFrame()) {
      const document = { url: value.url(), status: value.status() }; state.documents.push(document);
      document.body = value.text().then(html => ({ html }), error => ({ error: String(error) }));
    }
  };
  page.on('response', response); return () => page.off('response', response);
}
/** Use the rendered control route, with a fresh accessibility observation before every input. */
export async function nativeCameraMode(page, mode, snapshot) {
  if (!['manual', 'broadcast'].includes(mode)) throw Error('native-camera-mode-invalid');
  const direct = page.getByRole('button', { name: 'Camera modes and help', exact: true });
  await snapshot('camera-route');
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await snapshot('camera-menu');
    await page.getByRole('menu', { name: 'Menu', exact: true }).getByRole('menuitem', { name: /^Camera(?:\s|$)/ }).click();
  }
  await snapshot('camera-dialog');
  await page.getByRole('dialog', { name: 'Camera modes and help', exact: true })
    .getByRole('button', { name: mode === 'broadcast' ? 'Broadcast' : 'Free', exact: true }).click();
}
export default async function ({ page, paths, check, base, signal }) {
  const state = observations.get(page);
  check('native-exact-navigation-response', state?.documents.length === 1 && state.documents[0].status === 200 && state.documents[0].url === page.url());
  const document = await state.documents[0].body;
  check('native-document-body-retained', typeof document.html === 'string');
  const stream = suppliedNativeStream(document.html);
  writeFileSync(join(paths.dir, 'native-document.html'), document.html, { flag: 'wx' });
  const documentHash = createHash('sha256').update(document.html).digest('hex');
  await page.waitForFunction(() => !!document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const canvas = page.locator('canvas').first(), bounds = await canvas.boundingBox();
  check('native-customer-page-drawn', !!bounds && bounds.width > 100 && bounds.height > 100);
  const active = () => state.responses.some(r => r.path.startsWith(stream) && r.status >= 200 && r.status < 300);
  const until = Date.now() + 10000;
  while (!active() && Date.now() < until) { signal?.throwIfAborted(); await page.waitForTimeout(50); }
  check('native-stream-selected', active());
  check('native-displayed-tick', displayedNativeTick(await page.locator('.viewer-history').getAttribute('data-viewer-tick')));
  let input = 0;
  const snapshot = async name => writeFileSync(join(paths.dir, `accessibility-before-${++input}-${name}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  await snapshot('pointer-move'); await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5);
  await snapshot('pointer-down'); await page.mouse.down();
  await snapshot('pointer-drag'); await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .55, { steps: 12 });
  await snapshot('pointer-up'); await page.mouse.up();
  await snapshot('keyboard-w'); await page.keyboard.press('KeyW');
  await page.waitForFunction(() => document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode') === 'manual');
  check('real-input-manual-takeover', await page.locator('.viewer-history').getAttribute('data-viewer-mode') === 'manual');
  await page.screenshot({ path: join(paths.dir, 'native-manual.png') });
  await nativeCameraMode(page, 'broadcast', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode') === 'broadcast');
  check('real-input-broadcast', await page.locator('.viewer-history').getAttribute('data-viewer-mode') === 'broadcast');
  check('owned-origin-retained', new URL(page.url()).origin === new URL(base).origin);
  writeFileSync(join(paths.dir, 'native-input-facts.json'), JSON.stringify({ qualification: 'capture/input only', documentHash, stream, successfulNativeResponses: state.responses.filter(r => r.path.startsWith(stream) && r.status >= 200 && r.status < 300), viewport: page.viewportSize(), canvas: bounds, input: ['visible Camera control or Menu/Camera', 'Free button', 'pointer drag', 'keyboard W', 'Broadcast button'] }, null, 2), { flag: 'wx' });
  await page.waitForTimeout(1200);
}
