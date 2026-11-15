// Clip kit (#1265): the Mars tire ring, looking north to the mountains from 25 m. The page opens there (eye/at in the
// URL), the camera wheel-zooms in toward the ring, then holds still. Before the fix the mountains strobed every other
// frame once still things had frozen (the panorama was culled by its buffer's box on frames without a shadow pass).
const { CLIP_WORLD } = process.env;

export default async function steps(page, { mark }) {
  await page.goto(`${CLIP_WORLD}?dev=1&eye=-170,8,-79&at=-170,0.6,-104`);
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => window.__soulsEntity, null, { timeout: 90_000 });
  mark('at the ring');
  await page.waitForTimeout(6000);                        // still things settle and freeze
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  mark('zoom in');
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(250); }
  mark('hold still');
  await page.waitForTimeout(10_000);
}
