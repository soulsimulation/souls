// Clip kit (#2305): the page is hidden (visibilityState 'hidden' and its visibilitychange event, as a background tab
// gets them; a headless recorder has no second window to switch to), the viewer lets go of its world after the wait
// (shortened to 8 s by the kit's sim.hiddenReleaseMs), then the page is shown again and reconnects to the world as it is
// now. Every 2 s the debug panel logs how many viewer connections the world itself counts (its /healthz `clients`).
const { CLIP_WORLD } = process.env;

export default async function steps(page, { mark, panel }) {
  let stop = false;
  const watch = (async () => {
    while (!stop) {
      const h = await fetch(`${CLIP_WORLD}/healthz`).then((r) => r.json()).catch(() => null);
      panel?.(`world connections: ${h?.clients ?? '?'} (tick ${h?.tick ?? '?'})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  const show = (state) => page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await page.waitForTimeout(4000);
  await show('hidden'); mark('hidden'); panel?.('page hidden');
  await page.waitForTimeout(14_000);                      // 8 s wait, then the world let go
  await show('visible'); mark('shown'); panel?.('page shown');
  await page.waitForTimeout(10_000);                      // reconnected: the world as it is now
  stop = true; await watch;
}
