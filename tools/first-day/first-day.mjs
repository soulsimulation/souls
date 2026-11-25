#!/usr/bin/env node
// First day: a naive person comes to Souls for the first time and has their own agent bring a Soul into Eden. The
// runner is the person: a real browser (uncut real-speed video, a screenshot before and after every step), and a naive
// agent (agent.mjs: a fresh `claude -p` in an empty folder outside this checkout, given only what a person types).
// Steps are the first-day playbook's 1-8 (.claude/skills/first-day/SKILL.md), then an explore phase of plain requests
// (script.mjs). Each step is judged by eye (judge.mjs: a vision model on the screenshots against what the person
// expected to see), with the page's own state as a second signal (checks.mjs). The report (report.mjs) is a pass/fail
// table, what was confusing in the agent's transcript, and findings written as ready-to-file task text.
//
//   node tools/first-day/first-day.mjs --local [--repo <checkout>] [--template worlds/templates/eden-2026.json]
//   node tools/first-day/first-day.mjs --local --attach <world page url> --directory <directory url>
//   node tools/first-day/first-day.mjs --site https://soul.game --profile <signed-in browser profile folder>
//     [--headed] [--model <agent model>] [--judge-model <model>] [--explore E1,E3 | --no-explore] [--out <dir>]
//
// --local starts the prod-like stack (tools/playtest/arena/new-engine/old-page.mjs, from --repo's checkout, which must
// be built) and approves as the local test person (the page's dev sign-in name). --site approves through an owner's
// already signed-in browser profile; it never types a credential, and stops when that profile is not signed in.
// Everything goes to .local/first-day/<UTC stamp>/ (report.md, report.json, shots/, video/, agent/).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { naiveFolder, say, contamination, pairingIn, turnSummary, personReply, stopAgentProcesses } from './agent.mjs';
import { openBrowser, watchConsole, pageState, waitLive, shot } from './page.mjs';
import { checkStep, arrivalChecks, mine } from './checks.mjs';
import { judgeAll } from './judge.mjs';
import { stepPassed, findingsOf, confusingOf, markdown } from './report.mjs';
import { PLAYBOOK, EXPLORE, SOUL_NAME, TEST_PERSON } from './script.mjs';

/** What a stopped run must still stop: the agent's session and daemon, and the stack (SIGINT, SIGTERM). */
const CLEANUP = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const def = (id) => ({ ...PLAYBOOK.find((s) => s.id === id) });

/** Starts the local stack from `repo` → {page, directory, stop} */
export function startStack({ repo, template, dir, log }) {
  mkdirSync(dir, { recursive: true });
  const p = spawn(process.execPath, [join(repo, 'tools/playtest/arena/new-engine/old-page.mjs'), '--template', template, '--dir', dir], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const keep = (d) => { text += d; appendFileSync(join(dir, 'stack.log'), d); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  const stop = async () => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } await sleep(3000); };
  return new Promise((ok, no) => {
    const t = setTimeout(() => { stop(); no(new Error(`the stack was not ready in 15 min: ${text.slice(-400)}`)); }, 15 * 60_000);
    const check = setInterval(() => {
      const page = /^ready (\S+)/m.exec(text)?.[1], directory = /directory (\S+)/.exec(text)?.[1];
      if (page && directory) { clearTimeout(t); clearInterval(check); log(`stack ready: ${page}`); ok({ page, directory, stop }); }
    }, 250);
    p.on('exit', (c) => { clearTimeout(t); clearInterval(check); no(new Error(`the stack ended (${c}): ${text.slice(-400)}`)); });
  });
}

export async function firstDay(opts) {
  const { target, out, repo = REPO_ROOT, headed = false, model = null, judgeModel = null, explore = EXPLORE, log = (m) => process.stderr.write(`[first-day] ${m}\n`) } = opts;
  const shots = join(out, 'shots'), agentOut = join(out, 'agent');
  for (const d of [shots, agentOut, join(out, 'state')]) mkdirSync(d, { recursive: true });
  const rep = { target: target.site ? target.site : 'local', stamp: opts.stamp, startedAt: new Date().toISOString(), build: opts.build ?? null, steps: [], turns: [], findings: [], videos: [], agent: { transcript: join(agentOut, 'transcript.jsonl') } };
  const steps = rep.steps;
  let stack = null, browser = null, agentDir = null, sessionId = null, soul = null;
  const transcript = (e) => appendFileSync(rep.agent.transcript, JSON.stringify(e) + '\n');
  const turn = async (step, text, extra = {}) => {
    log(`${step}: person says "${text.slice(0, 80)}"`);
    let child = null; const kill = () => child?.kill('SIGTERM'); CLEANUP.add(kill);
    const r = await say({ cwd: agentDir, text, sessionId, model, maxSec: extra.maxSec ?? 420, onSpawn: (p) => { child = p; }, onEvent: (e, all) => { transcript({ step, ...e }); return extra.onEvent?.(e, all); } });
    CLEANUP.delete(kill);
    sessionId = r.sessionId ?? sessionId;
    const summary = turnSummary(r);
    rep.turns.push({ step, said: text, summary });
    log(`${step}: agent ${summary.seconds} s, ${summary.tools} tools, ${summary.denials.length + summary.blocked.length} refused; "${summary.final.slice(0, 120).replace(/\n/g, ' ')}"`);
    return { ...r, summary };
  };
  const capture = async (page, id, tag) => shot(page, join(shots, `${id}-${tag}.png`));

  try {
    // the world and the person's browser
    let worldPage, directory = null;
    if (target.site) worldPage = null;
    else if (target.attach) { worldPage = target.attach; directory = target.directory; }
    else { stack = await startStack({ repo, template: opts.template, dir: join(out, 'stack'), log }); CLEANUP.add(stack.stop); worldPage = stack.page; directory = stack.directory; }
    browser = await openBrowser({ out, headed, profile: target.profile ?? null });
    const page = await browser.context.newPage(), con = watchConsole(page);
    const home = target.site ? new URL('/', target.site).href : new URL('/', worldPage).href;

    // S1 home page
    let s = def('S1'), n = con.errors.length, t0 = Date.now();
    const r1 = await page.goto(home, { waitUntil: 'load', timeout: 30_000 }).catch((e) => ({ status: () => `error ${e.message.slice(0, 80)}` }));
    await sleep(1500);
    s.seconds = Math.round((Date.now() - t0) / 100) / 10;
    s.shots = [await capture(page, 'S1', 'after')];
    let st = await pageState(page);
    const worldLink = await page.locator('a[href*="/w/"]').first().getAttribute('href', { timeout: 3000 }).catch(() => null);
    s.checks = [...checkStep(s, { after: st, consoleErrors: con.since(n) }),
      { check: 'loads', ok: r1?.status?.() === 200, detail: `status ${r1?.status?.()}`, severity: 'blocker' },
      { check: 'in-time', ok: s.seconds <= s.limitSec, detail: `${s.seconds} s`, severity: 'major' },
      { check: 'links-a-world', ok: !!worldLink, detail: worldLink ?? 'no link to a world on the home page', severity: 'blocker' }];
    s.consoleErrors = con.since(n); steps.push(s);

    // S2 open Eden: the person clicks the world on the home page
    s = def('S2'); n = con.errors.length; t0 = Date.now();
    if (worldLink) await page.locator('a[href*="/w/"]').first().click().catch(() => {});
    else await page.goto(worldPage ?? home);
    if (!worldPage) worldPage = page.url().replace(/#.*$/, '');
    if (worldLink && target.attach && !page.url().startsWith(worldPage.replace(/\/$/, ''))) s.notes = [`the home page's first world link went to ${page.url()}, not the world under test`];
    const live = await waitLive(page, s.limitSec);
    await sleep(3000);
    s.seconds = live ?? `>${s.limitSec}`;
    s.shots = [await capture(page, 'S2', 'after')];
    st = await pageState(page);
    const baseline = new Set(st.souls.map((x) => x.id));
    s.checks = [...checkStep(s, { after: st, consoleErrors: con.since(n) }), { check: 'live', ok: live != null, detail: live != null ? `Live in ${live.toFixed(1)} s` : `the pill says "${st.live}"`, severity: 'blocker' },
      { check: 'souls-in-world', ok: st.souls.length > 0, detail: `${st.souls.length} Souls in the page's picture`, severity: 'major' }];
    s.consoleErrors = con.since(n); steps.push(s);
    worldPage = page.url().replace(/#.*$/, '');

    // S3a New Soul signed out (a site run is signed in already: its signed-out look is a separate fresh browser)
    s = def('S3a'); n = con.errors.length;
    let outPage = page, outBrowser = null;
    if (target.site) { outBrowser = await openBrowser({ out: join(out, 'signed-out'), headed }); outPage = await outBrowser.context.newPage(); await outPage.goto(worldPage); await waitLive(outPage, 20); }
    const newSoul = outPage.locator('button.bring-agent-open, [data-menu="new-soul"]').first();
    const hasButton = await newSoul.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasButton) await newSoul.click().catch(() => {});
    await sleep(1500);
    s.shots = [await capture(outPage, 'S3a', 'after')];
    const outText = await outPage.locator('section.bring-agent, [role=dialog]').first().innerText({ timeout: 3000 }).catch(() => '');
    s.checks = [{ check: 'new-soul-button', ok: hasButton, detail: hasButton ? 'visible' : 'no New Soul button', severity: 'blocker' },
      { check: 'no-dead-end', ok: /sign in|instructions\.md|prompt/i.test(outText), detail: outText ? outText.slice(0, 200) : 'nothing opened', severity: 'major' }];
    s.consoleErrors = con.since(n); steps.push(s);
    await outPage.keyboard.press('Escape').catch(() => {});
    await outPage.locator('button.bring-agent-close').click({ timeout: 1000 }).catch(() => {});
    if (outBrowser) { rep.videos.push(await outPage.video()?.path()); await outBrowser.close(); }

    // sign in: locally the page's dev sign-in as the test person; on the site the profile must be signed in already
    st = await pageState(page);
    if (!st.signedIn) {
      if (target.site) { rep.aborted = `the browser profile is not signed in to ${target.site}: sign the test person in to that profile once, then run again`; return finish(); }
      page.once('dialog', (d) => d.accept(TEST_PERSON).catch(() => {}));
      await page.locator('button.account-sign-in').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForSelector('summary.account-avatar', { timeout: 15_000 }).catch(() => {});
      await waitLive(page, 20);
    }

    // S3b New Soul signed in: the prompt to copy
    s = def('S3b'); n = con.errors.length; t0 = Date.now();
    await page.locator('button.bring-agent-open, [data-menu="new-soul"]').first().click({ timeout: 5000 }).catch(() => {});
    const prompt = (await page.locator('p.bring-agent-prompt').first().innerText({ timeout: 10_000 }).catch(() => '')).trim();
    await page.locator('section.bring-agent button.primary').first().click({ timeout: 2000 }).catch(() => {});
    s.seconds = Math.round((Date.now() - t0) / 100) / 10;
    s.shots = [await capture(page, 'S3b', 'after')];
    st = await pageState(page);
    s.checks = [{ check: 'signed-in', ok: st.signedIn, detail: st.signedIn ? 'the account menu shows' : 'still signed out', severity: 'blocker' },
      { check: 'prompt-shown', ok: !!prompt, detail: prompt || 'no prompt', severity: 'blocker' },
      { check: 'prompt-plain', ok: /instructions\.md/.test(prompt) && prompt.length < 400, detail: `${prompt.length} characters`, severity: 'minor' }];
    s.consoleErrors = con.since(n); steps.push(s);
    s.prompt = prompt;
    await page.locator('button.bring-agent-close').click({ timeout: 1000 }).catch(() => {});
    if (!prompt) { rep.aborted = 'the page gave no prompt to give the agent'; return finish(); }

    // S4 the naive agent, from the prompt alone; S5 is watched on the open page from the moment it shows a code
    agentDir = naiveFolder(repo);
    CLEANUP.add(() => stopAgentProcesses(agentDir));
    rep.agent.folder = agentDir;
    s = def('S4'); s.judged = false; t0 = Date.now();
    let pairing = null, contaminated = null, cardSeen = null, cardWatch = null;
    const watchCard = (code) => (async () => {
      const at = Date.now();
      for (; Date.now() - at < 10_000; await sleep(500)) {
        const seen = await page.evaluate((c) => (document.body.innerText.includes(c) ? 'code' : null), code).catch(() => null);
        if (seen) return { sec: (Date.now() - at) / 1000 };
      }
      return null;
    })();
    const onEvent = (e, all) => {
      if (all.length === 1) {
        const why = [...new Set([resolve(repo), REPO_ROOT].flatMap((r) => contamination(e, { repo: r })))];
        if (why.length) { contaminated = why; return 'stop'; }
      }
      if (!pairing) { pairing = pairingIn(all); if (pairing) { pairing.sec = (Date.now() - t0) / 1000; log(`S4: the agent shows code ${pairing.code}`); cardWatch = watchCard(pairing.code); } }
    };
    let said = prompt, ruleAdded = false;
    for (let i = 0; i < 6 && !pairing && !contaminated; i++) {
      const r = await turn('S4', said, { onEvent });
      if (contaminated || pairing) break;
      const reply = personReply(r.final, { name: SOUL_NAME, ruleAdded });
      if (reply.addRule) { mkdirSync(join(agentDir, '.claude'), { recursive: true }); writeFileSync(join(agentDir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(node eden.mjs:*)'] } }, null, 2)); ruleAdded = true; }
      said = reply.text;
    }
    if (contaminated) { rep.aborted = `the naive agent's session was contaminated: ${contaminated.join('; ')}`; s.ok = false; s.seen = rep.aborted; steps.push(s); return finish(); }
    s.seconds = Math.round((Date.now() - t0) / 1000);
    s.ok = !!pairing;
    const s4turns = rep.turns.filter((t) => t.step === 'S4');
    s.seen = pairing ? `the agent showed code ${pairing.code}${pairing.link ? ' and a link' : ''} after ${s4turns.length} turn(s)` : `no code after ${s4turns.length} turns; its last words: ${s4turns.at(-1)?.summary.final.slice(0, 300)}`;
    s.checks = [{ check: 'reached-approval', ok: !!pairing, detail: s.seen, severity: 'blocker' },
      { check: 'no-safety-refusal', ok: !s4turns.some((t) => t.summary.denials.length || t.summary.blocked.length), detail: s4turns.flatMap((t) => [...t.summary.denials, ...t.summary.blocked]).map((d) => d.input ?? d.command).join(' | ') || 'none', severity: 'major' },
      { check: 'person-ran-nothing', ok: ruleAdded === false, detail: ruleAdded ? 'the person had to add a permission rule' : 'no command or setting by the person', severity: 'minor' }];
    s.shots = [await capture(page, 'S4', 'after')];
    steps.push(s);
    if (!pairing) return finish();

    // S5 the approval card on the open page
    s = def('S5');
    cardSeen = await cardWatch;
    s.shots = [await capture(page, 'S5', 'after')];
    s.checks = [{ check: 'card-on-page', ok: !!cardSeen, detail: cardSeen ? `the code showed on the page in ${cardSeen.sec.toFixed(1)} s` : `the code ${pairing.code} did not appear on the open Eden page within 10 s`, severity: 'major' }];
    steps.push(s);

    // S6 approve: on the page's card, else the agent's link, else (locally) as the test person at the directory
    s = def('S6'); s.notes = []; n = con.errors.length;
    let approvedBy = null;
    if (cardSeen) {
      const b = page.getByRole('button', { name: /approve/i }).first();
      if (await b.isVisible().catch(() => false)) { await page.getByRole('checkbox').first().check().catch(() => {}); await b.click().catch(() => {}); approvedBy = 'the card on the page'; }
    }
    if (!approvedBy && pairing.link) {
      const p2 = await browser.context.newPage();
      const resp = await p2.goto(pairing.link, { timeout: 20_000 }).catch((e) => ({ status: () => `error ${e.message.slice(0, 60)}` }));
      await sleep(1500);
      steps.push({ id: 'S5b', title: 'The pairing link', expect: 'The link the agent printed opens an approval card, signed in, showing the same code.', shots: [await capture(p2, 'S5b', 'after')], severity: 'major',
        checks: [{ check: 'link-opens', ok: resp?.status?.() === 200, detail: `status ${resp?.status?.()}`, severity: 'major' }] });
      if (!target.site && await p2.locator('#who').isVisible().catch(() => false)) { await p2.fill('#person', TEST_PERSON).catch(() => {}); await p2.locator('#who button').first().click().catch(() => {}); }
      const shown = await p2.locator('#code').innerText({ timeout: 8000 }).catch(() => '');
      if (shown) {
        if (shown.trim() !== pairing.code) s.notes.push(`the link's card shows ${shown.trim()}, the agent printed ${pairing.code}`);
        await p2.locator('#match').check().catch(() => {});
        await p2.locator('#approve').click().catch(() => {});
        const res = await p2.locator('#said').innerText({ timeout: 10_000 }).catch(() => '');
        if (/approved/i.test(res)) approvedBy = 'the link\'s card';
        else s.notes.push(`the link's card said: ${res || 'nothing'}`);
      }
      rep.videos.push(await p2.video()?.path());
      await p2.close();
    }
    if (!approvedBy && !target.site && directory) {
      const a = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, confirm: true, test_person: TEST_PERSON }) }).catch(() => null);
      if (a?.status === 200) { approvedBy = 'the directory as the local test person (no card worked)'; s.notes.push('approved behind the page: neither the page nor the link let the person approve'); }
      else s.notes.push(`the directory refused the approval: ${a?.status} ${await a?.text().catch(() => '')}`);
    }
    rep.approvedBy = approvedBy;
    t0 = Date.now();
    const told = approvedBy ? turn('S6', 'I approved it.') : null;
    let arrived = null, trail = [];
    for (; approvedBy && Date.now() - t0 < s.limitSec * 1000; await sleep(1000)) {
      st = await pageState(page); trail.push(st);
      const fresh = st.souls.find((x) => !baseline.has(x.id) && (!x.name || x.name.toLowerCase() === SOUL_NAME.toLowerCase())) ?? st.souls.find((x) => !baseline.has(x.id));
      if (fresh && !arrived) { arrived = (Date.now() - t0) / 1000; soul = { id: fresh.id, name: fresh.name }; log(`S6: ${fresh.name} (${fresh.id}) is in the picture after ${arrived} s`); }
      if (soul && arrivalChecks(st, soul).every((c) => c.ok)) break;
    }
    s.seconds = arrived ?? `>${s.limitSec}`;
    s.shots = [await capture(page, 'S6', 'after')];
    st = await pageState(page);
    s.checks = approvedBy ? arrivalChecks(st, soul ?? { name: SOUL_NAME }) : [{ check: 'approved', ok: false, detail: s.notes.join('; ') || 'no way to approve', severity: 'blocker' }];
    s.checks.push({ check: 'approve-on-page-or-link', ok: !!approvedBy && !/directory/.test(approvedBy), detail: approvedBy ?? 'not approved', severity: 'blocker' });
    s.consoleErrors = con.since(n); steps.push(s);
    if (told) await told;
    if (soul && !soul.name) soul.name = mine(await pageState(page), soul)?.name ?? null;

    if (soul) {
      // S6b its link in a new tab
      s = def('S6b');
      const p3 = await browser.context.newPage(), c3 = watchConsole(p3);
      t0 = Date.now();
      await p3.goto(`${worldPage}#soul/${encodeURIComponent(soul.id)}`).catch(() => {});
      await waitLive(p3, 20);
      let on = null;
      for (; Date.now() - t0 < s.limitSec * 1000 + 20_000; await sleep(1000)) { const x = await pageState(p3); if (arrivalChecks(x, soul).find((c) => c.check === 'camera-on-soul')?.ok) { on = x; break; } }
      s.seconds = on ? Math.round((Date.now() - t0) / 100) / 10 : `>${s.limitSec}`;
      await sleep(5000);   // the arrival light fades before the person looks
      s.shots = [await capture(p3, 'S6b', 'after')];
      const x3 = on ?? await pageState(p3);
      s.checks = [arrivalChecks(x3, soul).find((c) => c.check === 'camera-on-soul'), { check: 'card-open', ok: x3.card?.name === soul.name, detail: x3.card ? `card: ${x3.card.name}` : 'no card', severity: 'major' }];
      s.consoleErrors = c3.errors.slice(); steps.push(s);
      rep.videos.push(await p3.video()?.path());
      await p3.close();

      // the person keeps the camera on their Soul, as the card's Follow does
      await page.evaluate((id) => { location.hash = `soul/${encodeURIComponent(id)}`; }, soul.id).catch(() => {});
      await sleep(1500);
      const follow = page.locator('button.soul-follow').first();
      if (await follow.isVisible().catch(() => false)) { if ((await follow.getAttribute('aria-pressed')) !== 'true') await follow.click().catch(() => {}); }
      else {
        // no Follow on the card: the page's own follow link keeps the camera on the Soul for the screenshots
        rep.followNote = 'the person\'s own card offered no Follow button; the runner used the page\'s ?follow=1#soul/<id> link';
        steps.find((x) => x.id === 'S6')?.checks.push({ check: 'follow-offered', ok: false, detail: 'the card of the person\'s own Soul has no Follow button', severity: 'major' });
        await page.goto(`${worldPage}${worldPage.includes('?') ? '&' : '?'}follow=1#soul/${encodeURIComponent(soul.id)}`).catch(() => {});
        await waitLive(page, 20); await sleep(5000);
      }

      // S7 and the explore phase: one plain ask at a time, watched on the page
      const ask = async (d) => {
        const sd = { ...d, shots: [], notes: [] }; n = con.errors.length;
        const before = await pageState(page);
        sd.shots.push(await capture(page, d.id, 'before'));
        const t = Date.now();
        const running = turn(d.id, d.ask, { maxSec: 300 });
        let done = null, reacted = null, mid = false, lastMove = Date.now(), last = mine(before, soul);
        running.then(() => { done = Date.now(); });
        const trailX = [];
        const minSec = d.watchSec ?? 15;
        for (;;) {
          await sleep(1000);
          const x = await pageState(page); trailX.push(x);
          const m = mine(x, soul), elapsed = (Date.now() - t) / 1000;
          const changed = m && last && ((m.p && last.p && Math.hypot(m.p[0] - last.p[0], m.p[2] - last.p[2]) > 0.3) || m.doing !== last.doing || m.activity !== last.activity || m.prop !== last.prop);
          const spoke = x.speech.some((w) => w.soul === soul.id && !before.speech.some((b) => b.tick === w.tick && b.soul === w.soul));
          if ((changed || spoke) && reacted == null) reacted = elapsed;
          if (changed) lastMove = Date.now();
          if (!mid && reacted != null && elapsed - reacted > 4) { sd.shots.push(await capture(page, d.id, 'mid')); mid = true; }
          last = m ?? last;
          const still = (Date.now() - lastMove) / 1000;
          if (done && elapsed >= minSec && (still >= 5 || Date.now() - done > 60_000)) break;
          if (elapsed > 360) { sd.notes.push('still moving after 6 minutes'); break; }
        }
        await running;
        sd.shots.push(await capture(page, d.id, 'after'));
        const after = await pageState(page);
        sd.seconds = reacted != null ? Math.round(reacted * 10) / 10 : 'no visible reaction';
        sd.checks = [...checkStep(d, { before, after, trail: trailX, soul, consoleErrors: con.since(n) }),
          { check: 'reacted-in-time', ok: reacted != null && reacted <= (d.limitSec ?? 15), detail: reacted != null ? `first visible change after ${reacted.toFixed(1)} s` : 'nothing visible changed', severity: 'major' }];
        sd.consoleErrors = con.since(n);
        sd.agentSaid = rep.turns.at(-1)?.summary.final.slice(0, 400);
        writeFileSync(join(out, 'state', `${d.id}.json`), JSON.stringify({ before, after, trail: trailX.map((x) => ({ at: x.at, me: mine(x, soul), speech: x.speech.filter((w) => w.soul === soul.id), live: x.live, chip: x.chip, ticks: x.ticks })) }));
        steps.push(sd);
      };
      for (const id of ['S7a', 'S7b', 'S7c']) await ask(def(id));

      // S8 reload and come back
      s = def('S8'); n = con.errors.length;
      const pre = mine(await pageState(page), soul);
      t0 = Date.now();
      await page.reload().catch(() => {});
      await waitLive(page, s.limitSec);
      await page.evaluate((id) => { location.hash = `soul/${encodeURIComponent(id)}`; }, soul.id).catch(() => {});
      await sleep(4000);
      st = await pageState(page);
      const back = mine(st, soul);
      s.seconds = Math.round((Date.now() - t0) / 100) / 10;
      s.shots = [await capture(page, 'S8', 'after')];
      const moved = back?.p && pre?.p ? Math.hypot(back.p[0] - pre.p[0], back.p[2] - pre.p[2]) : null;
      s.checks = [{ check: 'still-there', ok: !!back?.p, detail: back?.p ? 'in the picture' : 'not in the picture after the reload', severity: 'blocker' },
        { check: 'still-named', ok: back?.name === soul.name, detail: `named ${back?.name ?? 'nothing'}`, severity: 'major' },
        { check: 'still-yours', ok: !!st.card?.owner || st.navbar.some((l) => l.includes(soul.name)), detail: st.card ? `card status: ${st.card.status ?? 'none'}` : 'no card', severity: 'major' },
        { check: 'same-place', ok: moved != null && moved < 3, detail: moved != null ? `${moved.toFixed(1)} m from where it was` : 'no position', severity: 'major' }];
      s.consoleErrors = con.since(n); steps.push(s);

      for (const d of explore) await ask(d);
    } else {
      for (const id of ['S6b', 'S7a', 'S7b', 'S7c', 'S8']) steps.push({ ...def(id), skipped: 'no Soul of the person\'s arrived in the world', checks: [] });
      for (const d of explore) steps.push({ ...d, skipped: 'no Soul of the person\'s arrived in the world', checks: [] });
    }
    rep.videos.push(await page.video()?.path());
    return finish();
  } finally {
    await browser?.close().catch(() => {});
    if (agentDir) log(`stopped ${stopAgentProcesses(agentDir)} agent process(es)`);
    await stack?.stop();
  }

  async function finish() {
    rep.endedAt = new Date().toISOString();
    rep.soul = soul;
    const toJudge = steps.filter((x) => x.judged !== false && !x.skipped && x.shots?.length);
    log(`judging ${toJudge.length} steps by eye`);
    const verdicts = await judgeAll(toJudge.map((x) => ({ title: x.title, ask: x.ask, expect: x.expect, images: x.shots })), { cwd: shots, model: judgeModel });
    toJudge.forEach((x, i) => Object.assign(x, verdicts[i]));
    for (const x of steps) x.pass = stepPassed(x);
    rep.passed = steps.filter((x) => x.pass).length;
    const repro = (x) => `${x.ask ? `Pair a fresh agent from Eden's New Soul prompt, then tell it "${x.ask}" and watch the Soul on the page.` : `Walk the first day to step ${x.id} (${x.title}) on a fresh Eden.`} Rerun: node tools/first-day/first-day.mjs --local${x.id.startsWith('E') ? ` --explore ${x.id}` : ' --no-explore'}`;
    rep.findings = findingsOf(steps, { repro });
    rep.confusing = confusingOf(rep.turns);
    try { rep.videos = readdirSync(join(out, 'video')).map((f) => join(out, 'video', f)); } catch { rep.videos = []; }
    writeFileSync(join(out, 'report.json'), JSON.stringify(rep, null, 1));
    writeFileSync(join(out, 'report.md'), markdown(rep, { root: out }));
    log(`report: ${join(out, 'report.md')}`);
    return rep;
  }
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k, d = null) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; }, has = (k) => a.includes(`--${k}`);
  if (!has('local') && !has('site')) { console.error('first-day: --local or --site <url>'); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const out = resolve(opt('out', join(REPO_ROOT, '.local/first-day', stamp)));
  const pick = opt('explore');
  const explore = has('no-explore') ? [] : pick ? EXPLORE.filter((e) => pick.split(',').includes(e.id)) : EXPLORE;
  const repo = resolve(opt('repo', REPO_ROOT));
  const target = has('site') ? { site: opt('site'), profile: opt('profile') } : { attach: opt('attach'), directory: opt('directory') };
  if (target.site && !target.profile) { console.error('first-day: --site needs --profile <an owner\'s signed-in browser profile folder>'); process.exit(2); }
  if (target.attach && !target.directory) { console.error('first-day: --attach needs --directory <url> (to approve as the local test person)'); process.exit(2); }
  let build = null;
  try { build = (await import('node:child_process')).execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { for (const f of CLEANUP) { try { await f(); } catch { /* next */ } } process.exit(130); });
  const rep = await firstDay({ target, out, repo, stamp, build, headed: has('headed'), model: opt('model'), judgeModel: opt('judge-model'), explore, template: opt('template', 'worlds/templates/eden-2026.json') });
  console.log(JSON.stringify({ report: join(out, 'report.md'), passed: rep.passed, steps: rep.steps.length, findings: rep.findings.length, aborted: rep.aborted ?? null }));
  process.exit(rep.aborted ? 1 : 0);
}
