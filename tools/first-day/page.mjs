// The person's browser: a real Chromium (headed, or headless with the GPU) recording uncut real-speed video, and what
// the page itself draws from, read for the explicit checks.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePlaywright, browsersPath, launchArgs } from '../playtest/lib/platform.mjs';

export const VIEWPORT = { width: 1280, height: 800 };

/** A browser and a context. `profile`: an owner's already signed-in profile folder (a persistent context). */
export async function openBrowser({ out, headed = false, profile = null, gpu = 'metal' }) {
  browsersPath();
  const pw = resolvePlaywright();
  if (!pw) throw new Error('no Playwright (install mars/viewer\'s dependencies: pnpm install --frozen-lockfile)');
  const { args } = launchArgs({ gpu });
  const video = join(out, 'video'); mkdirSync(video, { recursive: true });
  const opts = { viewport: VIEWPORT, recordVideo: { dir: video, size: VIEWPORT }, locale: 'en-US' };
  if (profile) {
    const context = await pw.chromium.launchPersistentContext(profile, { headless: !headed, args, ...opts });
    return { context, browser: null, close: () => context.close() };
  }
  const browser = await pw.chromium.launch({ headless: !headed, args });
  const context = await browser.newContext(opts);
  return { context, browser, close: async () => { await context.close(); await browser.close(); } };
}

/** Console errors and page errors, per page, as they come. */
export function watchConsole(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  return { errors, since: (n) => errors.slice(n) };
}

/** What the page draws from: its Souls (id, name, doing, position, heading, activity, held thing, seat), what was said,
 *  the camera, the navbar's Souls, the open card, the Live pill and the visible text. */
export function pageState(page) {
  return page.evaluate(() => {
    const v = window.__soulsV2, e = window.__soulsEntity ?? window.__simEntity;
    let frame = null; try { frame = e?.transportFrame?.() ?? null; } catch { /* not yet */ }
    const ents = frame?.entities ?? {};
    const souls = v?.souls ? [...v.souls.values()].map((s) => {
      const en = ents[s.entityId] ?? {};
      return { id: s.id, entityId: s.entityId, name: s.name, doing: s.doing, state: s.state, p: en.p ?? null, yaw: en.yaw ?? null, activity: en.activity ?? null,
        prop: en.state?.prop ?? null, seatHeight: en.state?.seatHeight ?? null };
    }) : [];
    const speech = (v?.speech ?? []).slice(-12).map((x) => ({ soul: x.from?.soulId ?? null, who: x.from?.name ?? null, text: x.text ?? null, tick: x.tick }));
    const cam = globalThis.__soulsCamera;
    const chip = document.querySelector('.viewer-camera-chip');
    const card = document.querySelector('article.soul-card');
    const q = (s) => document.querySelector(s);
    return {
      at: Date.now(), url: location.href, title: document.title,
      souls, speech,
      camera: cam ? { p: cam.p, pivot: cam.pivot } : null,
      chip: chip ? { camera: chip.dataset.camera ?? null, followSoul: chip.dataset.followSoul ?? null, text: chip.textContent?.trim() ?? '' } : null,
      navbar: [...document.querySelectorAll('.my-souls [aria-label^="Open "]')].map((b) => b.getAttribute('aria-label')),
      card: card ? { name: q('#soul-card-name')?.textContent?.trim() ?? null, status: q('.soul-meta .soul-status')?.textContent?.trim() ?? null,
        statusKey: q('.soul-meta .soul-status')?.dataset?.status ?? null, link: q('button.soul-link')?.dataset?.status ?? null, place: q('.soul-place')?.textContent?.trim() ?? null,
        owner: ['checking', 'connected', 'disconnected', 'approved-waiting', 'pairing'].includes(q('.soul-meta .soul-status')?.dataset?.status ?? '') } : null,
      live: q('[data-viewer-status]')?.textContent?.trim() ?? null,
      signedIn: !!q('summary.account-avatar'),
      text: (document.body?.innerText ?? '').slice(0, 5000),
    };
  }).catch((err) => ({ at: Date.now(), error: String(err.message ?? err).slice(0, 200), souls: [], speech: [], navbar: [], text: '' }));
}

/** Waits for the time pill to say Live. → seconds taken, or null when it never did within `sec`. */
export async function waitLive(page, sec = 15) {
  const t0 = Date.now();
  try { await page.waitForFunction(() => /^Live/.test(document.querySelector('[data-viewer-status]')?.textContent?.trim() ?? ''), null, { timeout: sec * 1000 }); return (Date.now() - t0) / 1000; } catch { return null; }
}

export async function shot(page, file) {
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}
