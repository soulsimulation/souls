// Clip kit (first-day 27 Nov): admin's Soul Juniper is paired and its client runs, but nothing reads its messages (the
// agent is asleep). The card must not say "listening now" or "Thinking…": it says the agent is not listening and the
// message waits. Then the agent's turn reads it (pending) → Thinking…, answers it, opens a listener → "listening now",
// and the client is stopped → "isn't connected", a second message waits.
import { cast, soul } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Juniper', owner: 'admin' }] });

export default async function steps(page, { mark, panel }) {
  const j = soul('Juniper');
  const say = async (words) => {
    const box = page.getByLabel('Message your agent');
    await box.click(); await box.pressSequentially(words, { delay: 45 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: /^Open Juniper/ }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('[data-status="connected"]').click().catch(() => panel('no Connected chip'));
  mark('card: client connected, nobody listening');
  await page.waitForTimeout(3000);
  await say('Hi! Could you walk Juniper over to the well?');
  mark('sent while the agent is asleep');
  await page.waitForTimeout(14000);
  mark('still waiting after 14 s');
  const p = await j.cli('pending');
  panel(`pending: ${(p.open ?? []).length} open`);
  mark('the agent read it (pending)');
  await page.waitForTimeout(5000);
  const id = p.open?.[0]?.id;
  if (id) await j.cli('ack', id, 'On my way to the well.', '--close', 'done');
  mark('the agent answered');
  await page.waitForTimeout(4000);
  const listening = j.cli('listen').catch(() => null);
  await page.waitForTimeout(4000);
  mark('a listener open');
  await page.waitForTimeout(4000);
  await j.cli('quit');
  await listening;
  await page.waitForTimeout(4000);
  mark('client stopped');
  await say('Are you there?');
  await page.waitForTimeout(5000);
  mark('sent while not connected');
  await page.waitForTimeout(4000);
}
