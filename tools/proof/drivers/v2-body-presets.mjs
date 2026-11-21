// Fixed local functional slots: real native CLI changes, public drawing and the existing history controls.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
let owned;
const fail = name => { throw Error('body-proof.' + name); };
const secret = text => /sacct_[A-Za-z0-9_-]+|soul-[a-f0-9]{32}-\d+\.[a-f0-9]{64}/.test(text);
const delay = (ms, signal) => new Promise((ok, reject) => { const stop = () => { clearTimeout(timer); reject(signal.reason); }; const timer = setTimeout(() => { signal.removeEventListener('abort', stop); ok(); }, ms); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop(); });
async function command(args) {
  const s = owned; s.signal.throwIfAborted();
  const result = await new Promise(ok => {
    const child = execFile(process.execPath, [join(s.recipe.checkout, 'v2/client/src/cli/souls.mjs'), ...args], { cwd: s.recipe.checkout,
      env: { ...process.env, BRAIN_MODE: 'fake', SOULS_HOME: s.recipe.home, SOULS_REPLICA_PKG: s.recipe.pkg }, signal: s.signal, timeout: 5000, maxBuffer: 1 << 20 },
    (error, stdout, stderr) => ok({ error: error ? { name: error.name, code: error.code, killed: error.killed ?? false } : null, stdout, stderr, exit: child.exitCode, signal: child.signalCode, pid: child.pid }));
    s.recipe.registerCommand(child); s.commands.add(child); child.once('close', () => s.commands.delete(child));
  });
  if (secret(result.stdout) || secret(result.stderr)) { writeFileSync(join(s.paths.dir, `command-${++s.ordinal}.json`), JSON.stringify({ code: 'credential-output', stdoutHash: createHash('sha256').update(result.stdout).digest('hex'), stderrHash: createHash('sha256').update(result.stderr).digest('hex') }), { flag: 'wx', mode: 0o600 }); fail('credential-output'); }
  writeFileSync(join(s.paths.dir, `command-${++s.ordinal}.json`), JSON.stringify({ args, ...result }), { flag: 'wx', mode: 0o600 });
  if (result.error || result.exit !== 0 || result.signal) fail('command-termination');
  const answer = JSON.parse(result.stdout); if (answer.ok !== true) fail('command-refused'); return answer;
}
async function receipt(sequence) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await command(['wait', '0']);
    const answer = result.events?.find(e => e.kind === 'answer' && e.sequence === sequence && e.answer !== 3);
    if (answer) return answer;
    await delay(20, owned.signal);
  }
  fail('receipt-timeout');
}
export async function prepare({ paths, recipe, signal, arm }) {
  if (recipe?.kind !== 'v2-bodies' || !['live', 'replay'].includes(arm)) fail('recipe');
  owned = { paths, recipe, signal, commands: new Set(), ordinal: 0, observations: 0 };
  recipe.startAgent();
  const socket = join(recipe.home, 'souls', recipe.soul, 'runtime/daemon.sock'), until = Date.now() + 8000;
  while (!existsSync(socket)) { if (Date.now() >= until) fail('agent-ready'); await delay(20, signal); }
  let status;
  do { status = await command(['status']); if (status.connected && !status.syncing) break; if (Date.now() >= until) fail('agent-sync'); await delay(20, signal); } while (true);
  const sent = await command(['act', 'life:join']), answer = await receipt(sent.sequence); if (answer.answer !== 1) fail('ordinary-join');
  const catalogue = JSON.parse(readFileSync(recipe.catalogue, 'utf8')); if (catalogue.bodies.length !== 20) fail('twenty-presets');
  owned.catalogue = catalogue.bodies.map(row => {
    const entry = JSON.parse(readFileSync(join(dirname(recipe.catalogue), row.entry), 'utf8'));
    let textured = false;
    if (entry.format !== 'baked') { const bytes = readFileSync(join(dirname(recipe.catalogue), entry.full)); const metadata = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()); textured = !!metadata.images?.length; }
    return { ...row, model: entry.format === 'baked' ? 'creature:' + row.preset : entry.kind, textured };
  });
  return { namedBirth: owned.catalogue.find(row => row.preset === 'pip') };
}
export async function beforeNavigation() {
  return async () => { const results = await Promise.allSettled([...owned.commands].map(c => new Promise((ok, reject) => { const timer = setTimeout(() => { c.kill('SIGKILL'); reject(Error('body-proof.command-cleanup')); }, 2000); c.once('close', () => { clearTimeout(timer); ok(); }); c.kill('SIGTERM'); }))); if (results.some(r => r.status === 'rejected')) fail('command-cleanup'); };
}
async function snapshot(page) { writeFileSync(join(owned.paths.dir, `accessibility-before-${++owned.observations}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx', mode: 0o600 }); }
async function drawn(page, hash, within = 8000) {
  await page.waitForFunction(expected => {
    const v = globalThis.v2, c = v?.world?.crowdBodies, crowd = c?.crowd;
    if (!crowd) return false;
    for (const [id, i] of c.index) { const node = v.world.nodes.get(id), loaded = crowd.bodyLoads.get(expected); if (node?.body !== expected || c.requested[i] !== expected || crowd.ready[i] !== 1 || loaded?.state !== 'ready') continue;
      const model = crowd.models[crowd.model[i]], draw = crowd.draws[crowd.model[i]][crowd.lod[i]];
      if (draw.parts.some(mesh => mesh.visible && mesh.count > 0) && v.renderer.info.render.calls > 0 && model) return true;
    } return false;
  }, hash, { timeout: within });
  return page.evaluate(expected => { const v = globalThis.v2, c = v.world.crowdBodies, crowd = c.crowd; const [id, i] = [...c.index].find(([id]) => v.world.nodes.get(id)?.body === expected); const model = crowd.models[crowd.model[i]];
    return { id, hash: v.world.nodes.get(id).body, model: model.name, materials: model.sourceMaterials?.length ?? 0, maps: model.sourceMaterials?.filter(m => m.map).length ?? 0, bones: model.bones, rendered: v.renderer.info.render.calls }; }, hash);
}
async function wear(page, row, check) {
  const before = Date.now(), sent = await command(['wear', row.preset]);
  const state = await drawn(page, row.hash, Math.max(1, 2000 - (Date.now() - before))); const elapsed = Date.now() - before;
  const answer = await receipt(sent.sequence);
  check('live-' + row.preset, answer.answer === 1 && state.hash === row.hash && state.model === row.model && state.materials > 0 && (!row.textured || state.maps > 0) && elapsed <= 2000, JSON.stringify({ elapsedMs: elapsed, model: state.model, materials: state.materials, maps: state.maps }));
  await page.screenshot({ path: join(owned.paths.dir, `model-${row.preset}.png`) }); return state;
}
export default async function ({ page, base, arm, fixture, check, expectHttp }) {
  await page.waitForFunction(() => [...(globalThis.v2?.world?.nodes?.values() ?? [])].some(n => n.kind.split('@')[0] === 'souls:body'), null, { timeout: 10000 });
  const body = await page.evaluate(() => [...globalThis.v2.world.nodes.values()].find(n => n.kind.split('@')[0] === 'souls:body').id);
  const follow = new URL(page.url()); follow.searchParams.set('follow', body); await page.goto(follow.href);
  const born = await drawn(page, fixture.namedBirth.hash); check('named-pip-birth-is-actual-rendered-model', born.id === body && born.model === fixture.namedBirth.model);
  await snapshot(page); const bounds = await page.locator('#view').boundingBox(); if (!bounds) fail('canvas'); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(0, -100);
  check('visible-camera-input', await page.evaluate(() => globalThis.v2.director.mode === 'follow'));
  if (arm === 'live') { for (const row of owned.catalogue) await wear(page, row, check); return; }
  const old = owned.catalogue.find(row => row.preset === 'pip'), next = owned.catalogue.find(row => row.preset === 'ghost');
  await drawn(page, old.hash);
  const oldSecond = Math.ceil((await command(['status'])).worldUs / 1e6) + 1;
  const liveAt = async second => page.waitForFunction(target => {
    const time = /^world time\s+(\d+):([0-5]\d)$/m.exec(document.getElementById('status')?.textContent ?? '');
    return time !== null && Number(time[1]) * 60 + Number(time[2]) >= target;
  }, second, { timeout: 6000 });
  await liveAt(oldSecond);
  await wear(page, next, check);
  const nextSecond = Math.ceil((await command(['status'])).worldUs / 1e6) + 1;
  if (nextSecond <= oldSecond || nextSecond - oldSecond > 8) fail('history-moment-distance');
  await liveAt(nextSecond);
  // The world publishes its open history window every 5 s; wait two of those so the wear is in the published bundle.
  await delay(11000, owned.signal);
  // At the live edge the history worker asks for the next day's index to find the next bundle's start; none exists yet.
  for (const day of new Set([oldSecond, nextSecond].map(second => Math.floor(second / 86400) + 1)))
    expectHttp(`/s/h/${owned.recipe.world}/${owned.recipe.lineage}/bundles/${String(day).padStart(8, '0')}/index`, 404, 'next day index at the live edge');
  const history = new URL(page.url()); history.hash = new URLSearchParams({ w: owned.recipe.world, l: owned.recipe.lineage, t: String(nextSecond * 1e6) }).toString();
  await page.goto(history.href); await page.reload(); await page.waitForFunction(() => typeof globalThis.v2?.history?.opened.hash === 'string', null, { timeout: 8000 }); await drawn(page, next.hash); await snapshot(page); await page.getByRole('button', { name: 'pause', exact: true }).click(); check('history-new-hash', (await drawn(page, next.hash)).hash === next.hash);
  for (let i = 0; i < nextSecond - oldSecond; i++) { await snapshot(page); await page.getByRole('slider').focus(); await Promise.all([page.waitForEvent('domcontentloaded'), page.getByRole('slider').press('ArrowLeft')]); }
  await drawn(page, old.hash); check('history-old-hash-via-real-slider', (await drawn(page, old.hash)).hash === old.hash);
  await snapshot(page); await page.getByRole('button', { name: 'back to live', exact: true }).click(); await drawn(page, next.hash); check('ordinary-back-to-live', true);
  const sent = await command(['wear', 'not-an-admitted-body']), refusal = await receipt(sent.sequence); check('named-refusal-retains-rendered-hash', refusal.answer === 2 && refusal.reason === 'body-unknown' && (await drawn(page, next.hash)).hash === next.hash);
  // Native prepared proof separately covers size-would-not-fit in its original 800 mm corridor.
  check('owned-origin-retained', new URL(page.url()).origin === new URL(base).origin);
}
