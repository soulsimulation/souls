// Clip kit (#1871; 0.135 P6 on the new engine): in Eden 2026, admin's Soul Pia acts on the Eden House 4 easel's paint
// offer, walks into the living room and paints, the camera following it (Ctrl+K, Enter) the whole way.
import { cast, find, soul } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Pia', owner: 'admin' }] });
const easel = await find('Pia', 'eden-house-4-easel');
console.error(`kit: easel ${easel?.id ?? 'not found'}`);

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Pia', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Pia');
  await page.waitForTimeout(3000);                        // the camera settles on Pia
  mark('paint at the easel');
  // painting has no end of its own: sent without --wait, then watched in short waits
  const r = easel ? await soul('Pia').cli('act', `paint:${easel.id}`) : { ok: false };
  console.error(`kit: paint: ${JSON.stringify(r).slice(0, 400)}`);
  for (let i = 0; i < 8 && r.ok; i++) await soul('Pia').cli('wait', '6');
  mark(r.ok ? 'at the easel' : 'not painting');
  await page.waitForTimeout(8000);
}
