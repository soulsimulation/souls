// #1391/#1433: on phone widths the top-bar controls stay mounted but hidden behind one hamburger (html.phone-menu,
// apps/web/src/hud-menu.ts). A phone user reaches Profile and New Soul through it, so the harness does too.
export const PHONE_WIDTH = '(max-width: 700px)';
export const isPhoneMenu = (page) => page.evaluate((q) => matchMedia(q).matches, PHONE_WIDTH);

/** Signed-in account UI as this viewport shows it: the avatar on desktop; on a phone the hamburger, with the avatar
 * mounted behind it (the Profile row is checked when the menu opens, in clickNewSoulEntry). */
export async function waitAccountReady(page, timeout = 20_000) {
  if (!await isPhoneMenu(page)) return page.locator('summary.account-avatar').waitFor({state: 'visible', timeout});
  await page.locator('.hud-menu').waitFor({state: 'visible', timeout});
  await page.locator('summary.account-avatar').waitFor({state: 'attached', timeout});
}

// Keep the native owner dialog from obstructing this one normal New Soul click.
// It can open after account readiness and after any one-shot visibility check.
export async function clickNewSoulEntry(page, record = () => {}) {
  const godModal = page.locator('[data-god-modal][open]');
  await page.addLocatorHandler(godModal, async () => {
    record('god-dialog');
    await page.keyboard.press('Escape');
    await godModal.waitFor({state: 'hidden'});
  });
  try {
    let entry;
    if (await isPhoneMenu(page)) {
      // the phone path: open the hamburger; its Profile row shows the signed-in account; New Soul is its own row
      await page.locator('.hud-menu').click();
      await page.locator('#hud-menu-panel[data-open="true"] [data-menu="profile"]').waitFor({state: 'visible', timeout: 10_000});
      entry = page.locator('#hud-menu-panel[data-open="true"] [data-menu="new-soul"]');
    } else entry = page.locator('.bring-agent-open:visible').first();
    record('entry', await entry.evaluate(el => ({tag: el.tagName, href: el.getAttribute('href'), menu: el.getAttribute('data-menu'),
      currentURL: location.href, godOpen: !!document.querySelector('[data-god-modal][open]')})));
    await entry.click();
  } finally {
    await page.removeLocatorHandler(godModal);
  }
}
