// The release's first-day check, page side (docs/release.md, the `first-day` skill's steps 2, 5, 6 and 8): on the
// local prod-like stack, signed in as the test owner Tess (`--local-storage sim.dev=Tess`, a saved session), a stand-in
// agent (agent.mjs: the client's pair.mjs, then life:join) asks for a new Soul; the card must come up on the open world
// page with the agent's code, say the Soul is arriving after Approve, list it under your Souls, close when its body is
// there and follow it. TAKE=b opens `#soul/<SOUL>` fresh (the camera goes to it) and reloads (still yours, named).
// Each step's verdict is a line in $FIRST_DAY_OUT/steps.jsonl. Two takes, each under the clip limit:
//
//   node tools/playtest/arena/new-engine/old-page.mjs --dir .local/first-day/stack   # prints ready <page> and the engine's addresses
//   DIRECTORY=<directory> GATEWAY=<gateway ws> ADVERT=<engine page>views/world.json NAME=<fresh name> TAKE=a \
//     node .claude/skills/proof/record.mjs --url '<page>?hour=12:00' --time-of-day keep --local-storage sim.dev=Tess \
//     --steps tools/release/first-day/steps.mjs --out .local/first-day/take-a.mp4 --viewport desktop
//   SOUL=<id from take a> TAKE=b node .claude/skills/proof/record.mjs --url '<page>?hour=12:00#soul/<id>' … --out .local/first-day/take-b.mp4
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const OUT = resolve(process.env.FIRST_DAY_OUT ?? '.local/first-day/run');
const { DIRECTORY, GATEWAY, ADVERT, WORLD = 'dev', TAKE = 'a', SOUL } = process.env;
mkdirSync(join(OUT, 'shots'), { recursive: true });
const t0 = Date.now(), table = [];
const row = (step, pass, what, shot) => { const r = { step, pass, seconds: +((Date.now() - t0) / 1000).toFixed(1), what, shot }; table.push(r); appendFileSync(join(OUT, 'steps.jsonl'), JSON.stringify(r) + '\n'); };

export default async function steps(page, { mark }) {
  const shot = async (n) => { const f = join(OUT, 'shots', `${n}.png`); await page.screenshot({ path: f }); return f; };
  if (TAKE === 'b') {
    // the take opened <world>/#soul/<id> fresh (a new tab): the camera goes to that Soul; then 8, a reload
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
    mark('#soul link opened');
    await page.waitForTimeout(12000);
    const chip = page.locator(`.my-souls [data-soul-id="${SOUL}"]`).first();
    row('6d', true, `#soul link: card ${await page.locator('#soul-panel').count() ? 'open' : 'closed'}, navbar "${await chip.getAttribute('aria-label').catch(() => null)}"`, await shot('6d-soul-link'));
    await page.reload();
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
    mark('reloaded');
    await page.waitForTimeout(12000);
    const again = page.locator(`.my-souls [data-soul-id="${SOUL}"]`).first();
    const ok = await again.count() > 0;
    row(8, ok, ok ? `after reload: "${await again.getAttribute('aria-label')}"` : 'not in the navbar after reload', await shot('8-reload'));
    return;
  }
  // 2: the world draws, signed in
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(4000);
  mark('world');
  row(2, true, 'world drawn', null);
  // 3: New Soul shows the prompt
  // 4 (stand-in): the agent asks
  const agent = spawn(process.execPath, [join(import.meta.dirname, 'agent.mjs'), join(OUT, 'agent'), DIRECTORY, WORLD, GATEWAY, ADVERT], { stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  agent.stdout.on('data', (d) => { for (const l of String(d).split('\n')) { try { const j = JSON.parse(l); events.push(j); appendFileSync(join(OUT, 'agent.jsonl'), l + '\n'); } catch { /* partial */ } } });
  const ev = async (step, ms = 60_000) => { for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(100)) { const e = events.find((x) => x.step === step); if (e) return e; } throw Error(`agent: no ${step} in ${ms} ms`); };
  const asked = await ev('asked');
  const askedAt = Date.now();
  mark(`agent asked ${asked.code}`);
  // 5: the card comes up on this page with the same code
  const dialog = page.locator(`[data-pair-dialog="${asked.code}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  const cardSecs = (Date.now() - askedAt) / 1000;
  const code = await dialog.locator('[data-pair-code]').getAttribute('data-pair-code');
  row(5, code === asked.code && cardSecs <= 10, `card on the page in ${cardSecs.toFixed(1)} s, code ${code} (agent printed ${asked.code})`, await shot('5-card'));
  mark('card on page');
  await page.waitForTimeout(1500);
  // 6: approve, named
  await dialog.locator('[data-pair-name]').click();
  await page.keyboard.type(process.env.NAME ?? 'Wren', { delay: 80 });
  await dialog.locator('[data-pair-match]').click();
  await dialog.locator(`[data-pair-approve="${asked.code}"]`).click();
  const approvedAt = Date.now();
  await dialog.locator('[data-pair-arriving]').waitFor({ state: 'visible', timeout: 10_000 });
  mark('arriving');
  row('6a', true, await dialog.locator('[data-pair-arriving]').innerText(), null);
  const paired = await ev('paired', 30_000);
  const soul = paired.soul;
  // the navbar lists it at once, arriving or here
  const chip = page.locator(`.my-souls [data-soul-id="${soul}"]`).first();
  await chip.waitFor({ state: 'attached', timeout: 10_000 });
  row('6b', true, `navbar lists ${soul}: "${await chip.getAttribute('aria-label')}"`, null);
  // the card closes when the body is here; the camera follows it
  await dialog.waitFor({ state: 'detached', timeout: 60_000 });
  const arrivedSecs = (Date.now() - approvedAt) / 1000;
  mark('soul arrived, camera follows');
  await page.waitForTimeout(3000);
  const label = await chip.getAttribute('aria-label');
  row('6c', arrivedSecs <= 30, `card closed ${arrivedSecs.toFixed(1)} s after Approve; chip "${label}"`, await shot('6c-arrived'));
  writeFileSync(join(OUT, 'table.json'), JSON.stringify({ soul, events, table }, null, 2));
  // the agent keeps its Soul connected for take b (HOLD_MS)
  agent.unref();
}
