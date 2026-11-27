// One actual native two-carrier lifecycle. Resources belong to runOwnedAttempt; controls are ordinary UI/CLI input.
// The scene (from attempt 7): the camp's loose rack beam on open ground, lifted by its two ends, carried south along its
// own length and then east round a corner, and set down. The front's `carry to` walks the whole crew (the world keeps
// each carrier's place), so one command starts a leg and the driver waits out its walk. A rack frame is not the scene:
// the world carries a frame standing, its native hand contacts at its foot's middle, out of its carriers' reach.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, fsyncSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PAIR, pairArgs, lastJson, seatOf, seatEnv } from '../../playtest/arena/new-engine/seat.mjs';
import { contactTools } from '../../playtest/carry-contact/oracle.mjs';
import { entityId } from '../../../apps/web/src/v2-engine/entity-id.ts';
import { layerDraws } from '../../../apps/web/src/v2-engine/layer-draws.ts';
import { nativeCameraMode } from './camera-native-page.mjs';
const SCENE = { load: 'rack-beam-4', kind: 'mars:rack_beam', entry: 'content/kinds/construction/rack_beam.json',
  view: 'post=0&hour=12:00&eye=3.5,3.2,26.5&at=-2,.9,22.3', liftMs: 2500, legs: [['-3.1,23.5', 4500], ['-0.5,23.5', 3500]] };
const states = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = id => id.replace(/-(\d+)$/, '.$1');
const save = (state, file, value) => writeFileSync(join(state.paths.dir, file), JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2), { flag: 'wx', mode: 0o600 });
const delay = (ms, signal) => new Promise((ok, no) => {
  const abort = () => { clearTimeout(timer); no(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); ok(); }, ms);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
async function cli(state, who, ...words) {
  state.signal.throwIfAborted();
  const seat = state.seats[who];
  const result = await new Promise((ok, no) => {
    const child = execFile(process.execPath, [join(state.recipe.checkout, 'v2/client/src/cli/souls.mjs'), ...words, '--soul', seat.soul],
      { cwd: seat.folder, env: seatEnv(seat.home, state.recipe.pkg), signal: state.signal, timeout: words[0] === 'carry' && words[1] === 'grip' ? 45000 : words[0] === 'carry' && words[1] === 'to' ? 25000 : 15000, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => { const result = { who, words, stdout, stderr, code: child.exitCode, signal: child.signalCode }; save(state, `command-carry-${++state.ordinal}.json`, result); if (error) no(error); else { try { ok(JSON.parse(stdout)); } catch (e) { no(e); } } });
    state.recipe.registerCommand(child);
  });
  if (result.ok !== true) throw Error(`carry-proof.command-refused: ${who} ${words.join(' ')}`);
  return result;
}
// Same ordinary pair/approve interface as pairSeat, with every finite subprocess registered before waiting.
async function pair(state, who) {
  const folder = join(state.paths.data, 'seats', who), home = join(folder, '.souls'); mkdirSync(folder, { recursive: true });
  let text = '', asked;
  const asking = new Promise((ok, no) => {
    const child = execFile(process.execPath, [PAIR, ...pairArgs(state.recipe.world, who)],
      { cwd: folder, env: seatEnv(home, state.recipe.pkg), signal: state.signal, timeout: 20000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => { save(state, `command-carry-pair-${who}.json`, { code: child.exitCode, signal: child.signalCode, stdout, stderr }); error ? no(error) : ok(lastJson(stdout)); });
    state.recipe.registerCommand(child);
    child.stdout.on('data', chunk => { text += chunk; asked ??= text.split('\n').map(lastJson).find(row => row?.step === 'approve'); });
  });
  // Attach the rejection handler immediately while the approval word arrives.
  const settled = asking.then(answer => ({ answer }), error => ({ error }));
  const until = Date.now() + 10000;
  while (!asked) { state.signal.throwIfAborted(); if (Date.now() > until) throw Error('carry-proof.pair-code'); await delay(20, state.signal); }
  const approval = await fetch(new URL('/v1/pair/approve', state.recipe.world.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: who }), signal: state.signal });
  if (approval.status !== 200) throw Error('carry-proof.pair-approval');
  const result = await settled; if (result.error) throw result.error;
  if (result.answer?.ok !== true || !result.answer.soul) throw Error('carry-proof.pair-result');
  const soul = result.answer.soul, post = (path, body) => fetch(new URL(path, state.recipe.world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, test_person: who }), signal: state.signal });
  const mine = (await (await post('/v1/account/souls', {})).json()).souls ?? [];
  const key = mine.find(s => s.soul.replace(/^soul-/, '') === soul.replace(/^s_/, ''))?.soul ?? soul;
  if ((await post('/v1/account/souls/profile', { soul: key, name: who === 'ada' ? 'Ada' : 'Bo' })).status !== 200) throw Error('carry-proof.name');
  return seatOf({ label: who, folder, home, soul, env: seatEnv(home, state.recipe.pkg), log: join(folder, 'commands.jsonl') });
}
export async function prepare({ paths, recipe, signal }) {
  if (recipe?.kind !== 'native-page' || !recipe.world || !recipe.registerClient) throw Error('carry-proof.recipe');
  const state = { paths, recipe, signal, seats: {}, bodies: {}, ordinal: 0, loaded: {}, pending: [], pageErrors: [] };
  states.set(paths.dir, state);
  await Promise.all(['ada', 'bo'].map(async who => {
    signal.throwIfAborted();
    const seat = await pair(state, who);
    state.seats[who] = seat;
    const fd = openSync(join(paths.dir, `client-${who}.log`), 'wx', 0o600);
    let daemon;
    try { daemon = spawn(process.execPath, [join(recipe.checkout, 'v2/client/src/daemon/daemon.mjs'), '--home', seat.home, '--soul', seat.soul, '--pkg', recipe.pkg, '--ready-fd', '3'],
      { cwd: seat.folder, env: seatEnv(seat.home, recipe.pkg), detached: true, stdio: ['ignore', fd, fd, 'pipe'] }); }
    finally { closeSync(fd); }
    recipe.registerClient(daemon);
    await new Promise((ok, no) => { const timer = setTimeout(() => no(Error('carry-proof.client-ready')), 10000); daemon.stdio[3].once('data', data => { clearTimeout(timer); String(data).trim() === 'ready' ? ok() : no(Error('carry-proof.client-ready')); }); daemon.once('error', no); daemon.once('exit', () => no(Error('carry-proof.client-exited'))); });
    await cli(state, who, 'act', 'life:join', '--wait');
    const until = Date.now() + 10000;
    while (!state.bodies[who]) { state.bodies[who] = (await cli(state, who, 'status')).body; if (Date.now() > until) throw Error('carry-proof.body-admission'); if (!state.bodies[who]) await delay(50, signal); }
  }));
  // Each carrier comes to its end along the load's own line (first 2.2 m out, then in): the page draws a body facing
  // the way it last walked, and the world does not turn a carrier to its load (attempt 8: Ada lifted with her back to it).
  state.grips = Promise.all([['ada', 'front'], ['bo', 'back']].map(async ([who, end]) => { await cli(state, who, 'carry', 'grip', SCENE.load, end, '--from', '2.2'); await cli(state, who, 'carry', 'grip', SCENE.load, end); })).then(() => ({ ok: true }), error => ({ error: String(error.stack ?? error) }));
  return { dir: paths.dir };
}
async function offer(state) {
  const grips = await state.grips; if (!grips.ok) throw Error(grips.error);
  state.crew = (await cli(state, 'ada', 'carry', 'offer', state.bodies.bo)).crew;
  if (!state.crew) throw Error('carry-proof.crew');
  await cli(state, 'bo', 'carry', 'accept', state.crew);
  const query = await cli(state, 'ada', 'query', JSON.stringify([{ find: SCENE.load }]));
  state.load = (query.answers ?? []).flatMap(a => a.found ?? []).find(n => n.name === SCENE.load && n.kind.split('@')[0] === SCENE.kind);
  if (!state.load) throw Error('carry-proof.load');
}
/** What the observer has counted so far, kept as each part of the journey ends, so a failing part is known by name. */
async function phase(state, page, name) {
  const seen = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: { ...o.counts }, maxima: structuredClone(o.maxima), total: o.total } : null; });
  if (seen) (state.phases ??= []).push({ phase: name, ...seen });
}
/** The front's ordinary `carry to` for each leg, its walk waited out, with one still as the leg ends. */
async function walk(state, page, paths, signal) {
  for (const [i, [to, ms]] of SCENE.legs.entries()) {
    await cli(state, 'ada', 'carry', 'to', state.crew, to);
    await delay(ms, signal);
    await page.screenshot({ path: join(paths.dir, `carry-leg-${i + 1}.png`) });
    await phase(state, page, 'leg-' + (i + 1));
  }
}
const diagnostic = (state, stage, detail = {}) => {
  appendFileSync(join(state.paths.dir, 'carry-install-diagnostic.jsonl'), JSON.stringify({ stage, at: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
};
const limited = (work, ms, name) => { let timer; return Promise.race([Promise.resolve().then(work), new Promise((_, no) => { timer = setTimeout(() => no(Error('carry-proof.' + name)), ms); })]).finally(() => clearTimeout(timer)); };
async function failureExecution(state, page) {
  const cdp = state.cdp;
  if (!cdp) return;
  try {
    const value = await limited(() => cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,ready:document.readyState,install:window.__carryInstallState,observer:!!window.__carryContactObserver,frame:window.__soulsEntity?.renderer?.info?.render?.frame})', returnByValue: true, timeout: 500 }), 750, 'failure-state-timeout');
    diagnostic(state, 'failure-runtime-state', { value });
  } catch (error) { diagnostic(state, 'failure-runtime-state-error', { error: String(error) }); }
  try {
    const paused = new Promise(ok => cdp.once('Debugger.paused', e => ok(e.callFrames.map(f => ({ name: f.functionName, url: f.url, location: f.location })))));
    await limited(() => cdp.send('Debugger.pause'), 500, 'failure-pause-timeout');
    diagnostic(state, 'failure-execution-stack', { frames: await limited(() => paused, 500, 'failure-stack-timeout') });
  } catch (error) { diagnostic(state, 'failure-execution-stack-error', { error: String(error) }); }
  finally { await limited(() => cdp.send('Debugger.resume'), 500, 'failure-resume-timeout').catch(error => diagnostic(state, 'failure-resume-error', { error: String(error) })); }
}
/** One served file's bytes, hashed. A body that never arrives (attempt 7: a response of the navigation the driver's own
 *  goto replaced never finished, and the wait for it used the whole journey) is a cancelled load after `ms`, which the
 *  asset check passes only if the same path was read whole from another response. */
export const readAsset = (state, path, response, ms = 8000) => limited(() => response.body(), ms, 'asset-body-timeout')
  .then(bytes => { state.loaded[path] = hash(bytes); }, error => { (state.cancelledLoads ??= []).push({ path, error: String(error) }); });
export async function installContactObserver(page, config, { record, onFailure = async () => {}, timeoutMs = 10000 } = {}) {
  record('evaluate-begin', { config, pageURL: page.url() });
  try {
    const result = await limited(() => page.evaluate(contactTools, config), timeoutMs, 'observer-install-timeout');
    record('evaluate-return', { result });
    if (result?.installed !== true) throw Error('carry-proof.observer-not-installed');
    return result;
  } catch (error) { record('evaluate-error', { error: String(error) }); await onFailure(); throw error; }
}
export async function beforeNavigation({ page, paths, signal }) {
  const state = states.get(paths.dir); if (!state) throw Error('carry-proof.preparation');
  const pageError = error => state.pageErrors.push(String(error.stack ?? error));
  const consoleStage = message => { const text = message.text(); if (text.startsWith('carry-install-stage ')) diagnostic(state, 'page-stage', { value: JSON.parse(text.slice(20)) }); };
  page.on('console', consoleStage);
  state.cdp = await page.context().newCDPSession(page);
  state.cdp.on('Debugger.scriptParsed', e => { if (e.url && (state.scriptCount = (state.scriptCount ?? 0) + 1) <= 500) diagnostic(state, 'script-parsed', { url: e.url, executionContextId: e.executionContextId, isModule: e.isModule }); });
  await state.cdp.send('Debugger.enable');
  diagnostic(state, 'diagnostic-ready');
  const response = response => {
    const full = new URL(response.url()), path = full.pathname; if (!/\.(js|wasm)$/.test(path)) return;
    diagnostic(state, 'module-response', { url: full.href, origin: full.origin, status: response.status(), resourceType: response.request().resourceType() });
    state.pending.push(readAsset(state, path, response));
  };
  page.on('pageerror', pageError); page.on('response', response);
  return async () => {
    try {
      await Promise.all(state.pending);
      if (!page.isClosed()) {
        const observer = await page.evaluate(() => { const o = window.__carryContactObserver; if (!o) return null; o.stop(); const { stop, ...data } = o; return data; });
        save(state, 'carry-observer.json', observer);
      }
      save(state, 'carry-loaded.json', state.loaded); save(state, 'carry-page-errors.json', state.pageErrors);
    } finally { page.off('pageerror', pageError); page.off('response', response); page.off('console', consoleStage); await state.cdp?.detach().catch(() => {}); states.delete(paths.dir); }
  };
}
export function wholeRunFailure(observer, pageErrors) {
  return !observer || !!pageErrors.length || !!observer.failures?.length || !!observer.failedWitnesses?.length || Object.keys(observer.counts ?? {}).some(k => !['passed-native-pair', 'native-release-observation', 'native-inactive-observation'].includes(k));
}
async function verifyAssets(state, check) {
  await Promise.all(state.pending);
  const manifest = JSON.parse(readFileSync(join(state.paths.dir, 'native-page-provenance.json')));
  check('no-missing-cancelled-assets', (state.cancelledLoads ?? []).every(f => state.loaded[f.path]), JSON.stringify(state.cancelledLoads ?? []));
  for (const [path, actual] of Object.entries(state.loaded)) {
    const replica = /\/v2\/replica\/[^/]+\/(replica\.js|replica_bg\.wasm)$/.exec(path);
    const expected = replica ? manifest.trees['v2/target/wasm-load/pkg'][replica[1]] : manifest.trees['apps/web/dist'][path.slice(path.lastIndexOf('/assets/') + 1)];
    check('served-artifact-' + path, actual === expected, 'Loaded page/replica bytes match their separate pinned artifact trees.');
  }
  return manifest;
}
export function validateSetupApproval(ready, approval, signal, now = Date.now()) {
  signal.throwIfAborted();
  if (now >= ready.deadline) throw Error('carry-proof.setup-review-timeout');
  if (approval?.approved !== true || approval.nonce !== ready.nonce || approval.screenshotSHA256 !== ready.screenshotSHA256)
    throw Error('carry-proof.setup-review-mismatch');
  return true;
}
export async function setupGate(state, page, signal) {
  const paths = state.paths, screenshot = join(paths.dir, 'setup.png');
  await page.screenshot({ path: screenshot });
  signal.throwIfAborted();
  const provenance = JSON.parse(readFileSync(join(paths.dir, 'native-page-provenance.json')));
  const ready = { schema: 'carry-setup-ready/1', nonce: randomUUID(), screenshot: 'setup.png', screenshotSHA256: hash(readFileSync(screenshot)),
    source: { product: provenance.sourceHead, artifactSHA256: provenance.artifactPin.hash,
      driverSHA256: hash(readFileSync(new URL(import.meta.url))), oracleSHA256: hash(readFileSync(new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url))) },
    deadline: Date.now() + 25000 };
  const temporary = join(paths.dir, 'setup-ready-' + ready.nonce + '.tmp');
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(ready, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(paths.dir, 'setup-ready.json'));
  const directory = openSync(paths.dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  console.log('SETUP_READY ' + paths.dir);
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= ready.deadline) throw Error('carry-proof.setup-review-timeout');
    const approval = join(paths.dir, 'setup-approval.json');
    if (existsSync(approval)) { validateSetupApproval(ready, JSON.parse(readFileSync(approval)), signal); return; }
    await delay(100, signal);
  }
}
export default async function ({ page, paths, signal, fixture, check, expectHttp, arm }) {
  const state = states.get(fixture.dir), root = state.recipe.checkout;
  // This is a published optional client document route, not a waived asset/stream/measurement failure.
  expectHttp('/safety.md', 404, 'Optional standalone client documentation is not routed by the old-page front door.');
  const snapshot = async label => writeFileSync(join(paths.dir, `accessibility-before-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  const url = new URL(page.url()); url.search = SCENE.view;
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__soulsEntity?.gameFrame().souls.length >= 2 && !document.querySelector('.viewer-arrival') && document.querySelector('.viewer-history[data-viewer-ready="true"]'), null, { timeout: 30000 });
  await nativeCameraMode(page, 'manual', snapshot);
  await offer(state);
  if (arm === 'baseline') {
    const manifest = await verifyAssets(state, check);
    save(state, 'baseline-contact-limits.json', { source: manifest.sourceHead, contactStatus: 'UNPROVED', reason: 'Pre-carry source has no native contact observer feed; this arm records the same ordinary actions, not an active-contact pass.' });
    await setupGate(state, page, signal);
    check('baseline-no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    await cli(state, 'ada', 'carry', 'lift', state.crew, SCENE.load);
    await delay(SCENE.liftMs, signal);
    await page.screenshot({ path: join(paths.dir, 'first-lift.png') });
    await walk(state, page, paths, signal);
    await cli(state, 'ada', 'carry', 'set-down', state.crew);
    await delay(3000, signal);
    await Promise.all(['ada', 'bo'].map(who => cli(state, who, 'carry', 'leave', state.crew)));
    check('baseline-ordinary-lifecycle-only', state.pageErrors.length === 0, 'Native CLI accepted the matched baseline actions; no native-pair or load-clock certification is claimed.');
    return;
  }
  check('candidate-arm', arm === 'candidate');
  await page.waitForFunction(({ load, crew }) => window.__soulsCarry?.evidence?.[load] && window.__soulsCarry.contactStates.some(s => s.crew === crew && s.field === 'absent' && s.members?.length === 2), { load: native(state.load.id), crew: native(state.crew) }, { timeout: 15000 });
  const scene = await page.evaluate(() => ({ frame: window.__soulsEntity.gameFrame(), carry: window.__soulsCarry, viewport: { width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints } }));
  const node = scene.carry.evidence[native(state.load.id)].frames[0].record;
  const entryFile = join(root, SCENE.entry), bytes = readFileSync(entryFile), entry = JSON.parse(bytes);
  const binding = { crew: native(state.crew), load: { native: native(state.load.id), entity: layerDraws(node) && node.origin ? node.origin : entityId(node.id), kind: state.load.kind, entrySha256: hash(bytes) },
    bodies: Object.entries(state.seats).map(([who, seat]) => { const shown = scene.frame.souls.filter(s => s.id === seat.soul); if (shown.length !== 1) throw Error('carry-proof.body-mapping'); return { native: native(state.bodies[who]), soul: seat.soul, entity: shown[0].entityId }; }) };
  const manifest = await verifyAssets(state, check);
  check('desktop-input', scene.viewport.touch === 0 && scene.viewport.width === 1440 && scene.viewport.height === 1000);
  const kitURL = Object.keys(state.loaded).find(path => /\/people-kit-[^/]+\.js$/.test(path)); check('production-kit-loaded', !!kitURL);
  await installContactObserver(page, { kitURL, binding, entry, source: manifest.sourceHead }, { record: (stage, detail) => diagnostic(state, stage, detail), onFailure: () => failureExecution(state, page) });
  save(state, 'carry-binding.json', binding); save(state, 'carry-scene.json', scene);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  await page.evaluate(() => { window.__carryContactObserver.active = true; });
  const abort = new AbortController(), journeySignal = AbortSignal.any([signal, abort.signal]);
  state.signal = journeySignal;
  let checking = false;
  const monitor = setInterval(async () => {
    if (checking || abort.signal.aborted) return; checking = true;
    try { const o = await page.evaluate(() => { const o = window.__carryContactObserver; return o && { counts: o.counts, failures: o.failures, failedWitnesses: o.failedWitnesses }; }); // A failing frame fails the run at its end; the journey goes on, so one attempt shows every part that fails.
      if (wholeRunFailure(o, state.pageErrors) && !state.firstFailure) { state.firstFailure = { at: new Date().toISOString(), counts: o?.counts ?? null, pageErrors: state.pageErrors.length }; await page.screenshot({ path: join(paths.dir, 'first-failure.png') }); } }
    catch (error) { abort.abort(error); } finally { checking = false; }
  }, 50);
  const wait = async (predicate, ms) => { const until = Date.now() + ms; while (!await page.evaluate(predicate)) { journeySignal.throwIfAborted(); if (Date.now() > until) throw Error('carry-proof.draw-timeout'); await delay(50, journeySignal); } journeySignal.throwIfAborted(); };
  try {
    await cli(state, 'ada', 'carry', 'lift', state.crew, SCENE.load);
    await wait(() => { const c = window.__carryContactObserver.counts; return c['passed-native-pair'] > 0 || c['failed-native-pair'] > 0; }, 10000);
    await delay(SCENE.liftMs, journeySignal);
    await page.screenshot({ path: join(paths.dir, 'first-lift.png') }); console.log('FIRST_CONTACT ' + paths.dir);
    await phase(state, page, 'lift');
    // Two short legs keep both carriers whole in the reviewed view; loading, seating and larger crews remain separate.
    await walk(state, page, paths, journeySignal);
    await cli(state, 'ada', 'carry', 'set-down', state.crew);
    await wait(() => window.__carryContactObserver.samples.some(s => s.result.releaseComplete), 10000);
    await page.screenshot({ path: join(paths.dir, 'set-down.png') });
    await phase(state, page, 'set-down');
    await Promise.all(['ada', 'bo'].map(who => cli(state, who, 'carry', 'leave', state.crew)));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return { counts: o.counts, failures: o.failures, failedWitnesses: o.failedWitnesses }; });
    check('complete-contact-lifecycle', !wholeRunFailure(observer, state.pageErrors), JSON.stringify(observer));
    check('native-active-contacts-observed', observer.counts['passed-native-pair'] > 0);
  } finally { clearInterval(monitor); state.signal = signal; save(state, 'carry-phases.json', { firstFailure: state.firstFailure ?? null, phases: state.phases ?? [] }); }
}
