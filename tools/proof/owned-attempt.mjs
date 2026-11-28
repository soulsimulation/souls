// Custom-journey lifecycle enforcement. Operational records are private; none of this output is publishable by default.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startWorld } from '../god-skill/dev-world.mjs';
import { startV2AccountFixture } from './v2-account-fixture.mjs';
import { startV2BodyFixture } from './v2-body-fixture.mjs';
import { startNativePageFixture } from './native-page-fixture.mjs';
import { prepareCaptureViewport } from './capture-viewport.mjs';
import { checkPort, portFree } from '../../e2e/local-smoke.mjs';
import { config } from '../../e2e/config.mjs';
import { assertImportedAttemptBudget, assertContinuationAuthority } from './imported-attempt-budget.mjs';
import { launchArgs } from '../playtest/lib/platform.mjs';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROCESS_USED = Symbol.for('souls.owned-proof-attempt.production-used');
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const writeNew = (file, value) => writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const requireThat = (ok, why) => { if (!ok) throw new Error(`proof.${why}`); };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const loadedToolHead = git(TOOL_ROOT, 'rev-parse', 'HEAD');
const loadedFiles = ['tools/proof/owned-attempt.mjs', 'tools/proof/imported-attempt-budget.mjs', 'tools/proof/v2-account-fixture.mjs', 'tools/proof/v2-body-fixture.mjs', 'tools/god-skill/dev-world.mjs', 'e2e/config.mjs', 'e2e/local-smoke.mjs', 'tools/playtest/lib/platform.mjs', 'tools/proof/native-page-fixture.mjs', 'tools/proof/capture-viewport.mjs', 'tools/playtest/arena/new-engine/old-page.mjs', 'tools/playtest/arena/new-engine/world.mjs'].map(path => ({ path, hash: digest(readFileSync(join(TOOL_ROOT, path))) }));
const source = root => { requireThat(!git(root, 'status', '--porcelain'), 'source-dirty'); return { root: resolve(root), head: git(root, 'rev-parse', 'HEAD') }; };
const within = (root, path) => { const p = relative(root, resolve(path)); return p && p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
const sameSource = (a, b) => !!a && !!b && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort()) && Object.keys(a).every(k => a[k].head === b[k].head && a[k].root === b[k].root);
function expectedHttp(event, report, base) {
  if (event.kind !== 'http') return false;
  const url = new URL(event.url), origin = new URL(base).origin;
  return url.origin === origin && !url.search && !url.hash && report.expectedHttp.some(e => url.pathname === e.path && event.status === e.status);
}
// An aborted owned-origin GET is expected only when its URL got a declared expected response, or it was in flight when the
// driver itself called page.goto or page.reload. Every other request failure still fails the attempt.
function expectedAbort(event, report, base) {
  if (event.kind !== 'requestfailed' || event.method !== 'GET' || event.error !== 'net::ERR_ABORTED') return false;
  const url = new URL(event.url);
  if (url.origin !== new URL(base).origin || url.search || url.hash) return false;
  return event.inFlightAtDriverNavigation === true || report.network.some(e => e.url === event.url && expectedHttp(e, report, base));
}
const expectedNetwork = (event, report, base) => expectedHttp(event, report, base) || expectedAbort(event, report, base);
function expectedResourceError(event, report, base) {
  if (event.kind !== 'error' || event.text !== 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)' || !event.location?.url) return false;
  return report.network.some(response => response.status === 503 && response.url === event.location.url && expectedHttp(response, report, base));
}
function unexpectedConsole(report, base) {
  return report.console.some(event => event.kind === 'pageerror' || (event.kind === 'error' && !expectedResourceError(event, report, base)));
}
async function bounded(work, signal, ms, phase, onTimeout) {
  let timer, abort;
  try {
    const stopped = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('proof.interrupted'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { const error = new Error(`proof.${phase}-timeout`); onTimeout?.(error); reject(error); }, ms);
    });
    return await Promise.race([Promise.resolve().then(work), stopped]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

function changed(fix, snapshots, inspectChange) {
  requireThat(fix?.scope?.trim() && fix.paths?.length && fix.from && fix.to && fix.from !== fix.to, 'material-change-required');
  const found = Object.values(snapshots).find(s => s.head === fix.to && s.root === resolve(fix.root));
  requireThat(found, 'change-source-mismatch');
  const actual = inspectChange(found.root, fix.from, fix.to);
  requireThat(actual.some(Boolean) && fix.paths.every(p => p?.trim() && !isAbsolute(p) && !p.startsWith('../') && actual.includes(p)), 'change-paths-mismatch');
}
function reviewThird(review, attempts, owner, current, repair, now, lineChanged) {
  const previous = attempts.slice(-2);
  requireThat(review?.evidenceOnly === true && review.reviewer && review.reviewer !== owner, 'independent-review-required');
  requireThat(review.decision === 'TRY', 'review-escalate-or-missing');
  requireThat(Date.parse(review.at) > Date.parse(previous.at(-1).endedAt) && Date.parse(review.at) <= now + 1000, 'review-stale');
  requireThat(JSON.stringify(review.evidence) === JSON.stringify(previous.map(a => a.reportHash)), 'review-evidence-mismatch');
  requireThat(sameSource(review.source, current), 'review-source-mismatch');
  requireThat(review.hypothesis?.trim() && previous.every(a => review.hypothesis !== a.hypothesis), 'different-hypothesis-required');
  requireThat(review.change?.path && Number.isSafeInteger(review.change.line) && review.change.line > 0 && repair.paths.includes(review.change.path), 'review-file-line-required');
  const path = resolve(repair.root, review.change.path);
  requireThat(within(repair.root, path) && readFileSync(path, 'utf8').split('\n').length >= review.change.line, 'review-file-line-invalid');
  requireThat(lineChanged(repair.root, repair.from, repair.to, review.change.path, review.change.line), 'review-line-not-changed');
}
function verifyRecords(state) {
  for (const attempt of state.attempts) {
    requireThat(digest(readFileSync(attempt.report)) === attempt.reportHash, 'attempt-record-changed');
    const report = json(attempt.report);
    for (const e of report.evidence) requireThat(digest(readFileSync(e.file)) === e.hash, 'evidence-changed');
  }
}
export async function stopOwnedChild(child, { processGroup = false } = {}) {
  if (processGroup && child?.pid) {
    const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw e; } };
    const kill = sig => { try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const gone = async ms => { const until = Date.now() + ms; while (alive() && Date.now() < until) await new Promise(r => setTimeout(r, 25)); return !alive(); };
    if (!alive()) return;
    kill('SIGTERM');
    if (!await gone(5000)) { kill('SIGKILL'); requireThat(await gone(2000), 'owned-group-did-not-exit'); }
    return;
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const wait = ms => new Promise((resolve, reject) => {
    const finish = value => { clearTimeout(timer); child.removeListener('exit', exit); child.removeListener('error', error); resolve(value); };
    const exit = () => finish(true), error = e => { finish(false); reject(e); }, timer = setTimeout(() => finish(false), ms);
    child.once('exit', exit); child.once('error', error);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
  const kill = sig => { if (processGroup && child.pid) { try { process.kill(-child.pid, sig); return; } catch {} } child.kill(sig); };
  kill('SIGTERM');
  if (!await wait(5000)) {
    kill('SIGKILL');
    requireThat(await wait(2000), 'owned-child-did-not-exit');
  }
}
async function openBrowser(o, paths, base) {
  requireThat(o.browserCache && existsSync(o.browserCache), 'explicit-browser-cache-required');
  requireThat(o.browserExecutable && within(resolve(o.browserCache), resolve(o.browserExecutable)) && existsSync(o.browserExecutable), 'explicit-browser-executable-required');
  // Resolve only the explicitly selected checkout dependency; never inspect default package/browser stores.
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(o.browserCache);
  const pw = createRequire(join(o.playwrightRoot ?? o.sourceRoot, 'mars/viewer/package.json'))('@playwright/test');
  const context = await pw.chromium.launchPersistentContext(paths.profile, { executablePath: o.browserExecutable,
    // The owner controller must finish evidence/ledger/world cleanup; Playwright's default SIGINT handler exits early.
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    timeout: o.phaseTimeoutMs ?? 30000,
    headless: o.headless ?? true, args: launchArgs({ gpu: o.gpu ?? 'metal' }).args,
    viewport: o.viewport ?? { width: 1920, height: 1080 }, deviceScaleFactor: 1,
    ...(o.world.kind === 'native-page' ? {} : { recordVideo: { dir: paths.video, size: o.viewport ?? { width: 1920, height: 1080 } } }),
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(o.browserCache) } });
  let recording = false;
  const owned = { base, close: async () => { try { if (recording) await owned.page.screencast.stop(); } finally { await context.close(); } } };
  // Transfer ownership as soon as Chromium exists, before page creation or capture calibration can fail.
  o.onOpened?.(owned);
  owned.page = context.pages()[0] ?? await context.newPage();
  if (o.world.kind !== 'native-page') return owned;
  const capture = await prepareCaptureViewport(owned.page, { size: o.viewport ?? { width: 1920, height: 1080 }, directory: join(paths.dir, 'capture'), signal: o.signal });
  await owned.page.screencast.start({ path: join(paths.video, 'native-page.webm'), size: o.viewport ?? { width: 1920, height: 1080 } }); recording = true;
  owned.provenance = { executableHash: digest(readFileSync(o.browserExecutable)), browser: context.browser()?.version() ?? null, playwright: createRequire(join(o.playwrightRoot ?? o.sourceRoot, 'mars/viewer/package.json'))('@playwright/test/package.json').version, viewport: o.viewport, capture };
  return owned;
}

const production = { source, changed: (root, from, to) => git(root, 'diff', '--name-only', from, to).split('\n'),
  lineChanged: (root, from, to, path, line) => [...git(root, 'diff', '--unified=0', from, to, '--', path).matchAll(/^@@ .*\+(\d+)(?:,(\d+))? @@/gm)].some(m => line >= Number(m[1]) && line < Number(m[1]) + Number(m[2] ?? 1)),
  boot: o => o.kind === 'native-page' ? startNativePageFixture(o) : o.kind === 'v2-bodies' ? startV2BodyFixture(o) : o.kind === 'v2-account' ? startV2AccountFixture(o) : (requireThat(o.kind === undefined, 'unknown-fixture-kind'), startWorld(o)), browser: openBrowser, stop: stopOwnedChild, portFree, now: () => Date.now(), test: false };

/** The journey's cap, and its video's: 90 s, or 600 s for a survey cycle (an id starting `survey-`), which records where
 * a long build stands rather than passing or failing one step. 600 s: the bay's lower build through its joists is one
 * continuous take of about 5 to 6 minutes (attempt 22). */
export const journeyCap = o => typeof o.cycle?.id === 'string' && o.cycle.id.startsWith('survey-') ? 600000 : 90000;

/** Exactly one invocation = one fresh owned lifecycle. A failed slot cannot be replaced by another sample id.
 * cycle.plan is fixed in advance, e.g. baseline1,baseline2,candidate1,candidate2. Each slot's repair loop is capped3.
 * A material corrective cycle must be explicit; changing HEAD never starts one. No URL parameter is accepted. */
export const runOwnedAttempt = options => run(options, production);

/** Injection is deliberately unqualified; test reports can never be presented as browser proof. */
export const createTestRunner = overrides => options => run(options, { ...production, lineChanged: () => true, ...overrides, test: true });

async function run(o, d) {
  requireThat(o.world?.kind === undefined || (o.world.kind === 'v2-account' || o.world.kind === 'v2-bodies' || o.world.kind === 'native-page'), 'unknown-fixture-kind');
  requireThat(o.owner?.trim() && o.cycle?.id && o.cycle.plan?.length && o.ledger, 'plan-and-agent-identity-required');
  requireThat(!('url' in o) && !('runDir' in o) && !('dataDir' in o) && !('profileDir' in o), 'existing-resource-override');
  for (const [value, max] of [[o.phaseTimeoutMs ?? 30000, 30000], [o.cleanupTimeoutMs ?? 8000, 8000], [o.journeyTimeoutMs ?? 90000, journeyCap(o)], [o.navigationTimeoutMs ?? 30000, 30000], [o.world?.timeoutMs ?? 180000, 180000]]) requireThat(Number.isSafeInteger(value) && value > 0 && value <= max, 'timeout-out-of-bounds');
  if (o.world.kind === 'v2-bodies') requireThat((o.world.timeoutMs ?? 30000) <= 30000, 'body-boot-timeout-out-of-bounds');
  if (!d.test) requireThat(!o.journey && o.driver?.root && o.driver?.path, 'committed-driver-required');
  const ledger = resolve(o.ledger), toolRoot = resolve(o.toolRoot ?? TOOL_ROOT), lock = ledger + '.lock';
  if (!d.test) requireThat(toolRoot === TOOL_ROOT, 'tool-checkout-mismatch');
  requireThat(within(toolRoot, ledger), 'ledger-outside-tool-checkout');
  if (!d.test) requireThat(git(toolRoot, 'check-ignore', ledger), 'ledger-must-be-ignored');
  mkdirSync(dirname(ledger), { recursive: true });
  mkdirSync(lock); // exclusive; stale ownership is never stolen automatically
  writeNew(join(lock, 'owner.json'), { owner: o.owner, at: new Date(d.now()).toISOString() });
  const children = [], transients = new Set(), processGroups = new Set();
  const native = o.world.kind === 'v2-account' || o.world.kind === 'v2-bodies' || o.world.kind === 'native-page';
  const healthy = () => children.every(c => transients.has(c) ? c.signalCode === null && (c.exitCode === null || c.exitCode === 0) : c.exitCode === null && c.signalCode === null);
  let state, report, paths, browser, child, childError, worldDeath, observationStop, closing = false, cleanupFailed = false, finalized = false, timedOut = false, browserCleanupStarted = false;
  const controller = new AbortController(), onAbort = () => controller.abort(o.signal?.reason ?? new Error('proof.interrupted'));
  const timeout = error => { timedOut = true; controller.abort(error); };
  const onSignal = () => controller.abort(new Error('proof.interrupted'));
  o.signal?.addEventListener('abort', onAbort, { once: true }); if (o.signal?.aborted) onAbort();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGHUP', onSignal);
  const save = () => { const tmp = ledger + '.' + randomUUID(); writeNew(tmp, state); renameSync(tmp, ledger); };
  try {
    const current = { product: d.source(o.sourceRoot), tool: d.source(toolRoot) };
    let driver = { default: o.journey };
    if (!d.test) {
      requireThat(current.tool.head === loadedToolHead && loadedFiles.every(f => digest(execFileSync('git', ['-C', toolRoot, 'show', `${loadedToolHead}:${f.path}`])) === f.hash), 'loaded-tool-source-mismatch');
      requireThat(!globalThis[PROCESS_USED], 'fresh-node-process-required');
      globalThis[PROCESS_USED] = true;
    }
    if (o.driver) {
      current.driver = d.source(o.driver.root);
      const file = resolve(o.driver.root, o.driver.path);
      requireThat(within(o.driver.root, file) && !isAbsolute(o.driver.path) && git(o.driver.root, 'ls-files', '--error-unmatch', '--', o.driver.path), 'driver-not-tracked');
      driver = await bounded(() => import(pathToFileURL(file).href + '?source=' + current.driver.head), controller.signal, o.phaseTimeoutMs ?? 30000, 'driver-import', timeout);
      requireThat(typeof driver.default === 'function', 'driver-function-required');
    }
    state = existsSync(ledger) ? json(ledger) : { version: 1, owner: o.owner, historicalCaptures: o.history?.count ?? 0, historicalEvidence: o.history?.evidence ?? [], captures: 0, attempts: [], cycles: [] };
    const importIdentity = o.importedBudget ? { historyFile: resolve(o.importedBudget.historyFile), historyHash: o.importedBudget.historyHash } : null;
    let imported, continuation, effectiveReview = o.review ?? null;
    if (state.importedBudget) requireThat(digest(state.importedBudget) === digest(importIdentity), 'imported-budget-required-and-pinned');
    if (o.importedBudget) {
      // Authoritative check is under this ledger's exclusive lock; an outside preflight can be stale.
      imported = assertImportedAttemptBudget({ ...o.importedBudget, ledgerFile: ledger, owner: o.owner,
        plan: o.cycle.plan, arm: o.arm, repeat: o.repeat,
        currentHeads: { product: current.product.head, tool: current.tool.head, driver: current.driver?.head },
        continuationAuthority: o.continuationAuthority, cycle: o.cycle, current, source: d.source, now: d.now() });
      continuation = imported.continuation;
      requireThat(digest(imported.history) === digest(o.history), 'imported-history-mismatch');
      state.importedBudget = importIdentity;
    } else continuation = assertContinuationAuthority({ continuationAuthority: o.continuationAuthority,
      ledgerFile: ledger, owner: o.owner, cycle: o.cycle, current, arm: o.arm, repeat: o.repeat, source: d.source, now: d.now() });
    requireThat(state.owner === o.owner, 'owner-mismatch');
    requireThat(Number.isSafeInteger(state.historicalCaptures) && state.historicalCaptures >= 0, 'historical-count-invalid');
    if (!d.test && state.historicalCaptures) requireThat(state.historicalEvidence.length, 'historical-evidence-required');
    for (const e of state.historicalEvidence) requireThat(digest(readFileSync(e.file)) === e.hash, 'historical-evidence-changed');
    verifyRecords(state);
    let cycle = state.cycles.at(-1);
    requireThat(!cycle?.inFlight, 'unfinished-attempt');
    requireThat(digest({ count: state.historicalCaptures, evidence: state.historicalEvidence }) === digest(o.history ?? { count: 0, evidence: [] }), 'historical-record-changed');
    if (cycle?.id !== o.cycle.id) {
      changed(o.cycle.fix, current, d.changed);
      if (cycle) {
        const recorded = { product: Object.values(cycle.armSources), tool: [cycle.toolSource], driver: [cycle.driverSource] };
        const direct = Object.values(recorded).flat().filter(Boolean).some(s => s.root === resolve(o.cycle.fix.root) && s.head === o.cycle.fix.from);
        const relocated = continuation?.relocations.some(r => {
          const kind = r.kind ?? 'product';
          return recorded[kind]?.some(s => s && sameSource({ [kind]: s }, { [kind]: r.from }))
            && r.from.head === o.cycle.fix.from && r.to.root === resolve(o.cycle.fix.root) && r.to.head === o.cycle.fix.to
            && sameSource({ [kind]: r.to }, { [kind]: current[kind] });
        });
        requireThat(direct || relocated, 'cycle-change-from-mismatch');
      }
      requireThat(!state.cycles.some(c => c.id === o.cycle.id), 'cycle-id-reused');
      requireThat(new Set(o.cycle.plan.map(s => `${s.arm}:${s.repeat}`)).size === o.cycle.plan.length, 'duplicate-measurement-slot');
      requireThat(o.cycle.plan.every(s => o.cycle.arms?.[s.arm]?.head && isAbsolute(o.cycle.arms[s.arm].root) && Number.isSafeInteger(s.repeat) && s.repeat > 0), 'planned-source-required');
      cycle = { ...structuredClone(o.cycle), cursor: 0, chain: 0, armSources: structuredClone(o.cycle.arms), toolSource: current.tool,
        ...(o.driver ? { driverSource: current.driver, driverPath: o.driver.path } : {}) }; state.cycles.push(cycle);
    } else requireThat(digest(cycle.plan) === digest(o.cycle.plan) && digest(cycle.arms) === digest(o.cycle.arms) && digest(cycle.fix) === digest(o.cycle.fix), 'cycle-plan-changed');
    requireThat(cycle.cursor < cycle.plan.length, 'passing-scenario-rerun');
    const attemptCap = continuation ? continuation.slot.maxTotalAttempts - (imported?.priorAttempts ?? 0) : config.iterationCap;
    requireThat(!cycle.stopped && cycle.chain < attemptCap, 'repair-ceiling');
    const slot = cycle.plan[cycle.cursor];
    requireThat(slot.arm === o.arm && slot.repeat === o.repeat, 'failed-slot-cannot-be-skipped');
    if (cycle.driverPath) requireThat(o.driver?.path === cycle.driverPath, 'driver-path-changed');
    const planned = { product: cycle.armSources[slot.arm], tool: cycle.toolSource, ...(cycle.driverSource ? { driver: cycle.driverSource } : {}) };
    const relocations = continuation?.relocations.filter(r => {
      const kind = r.kind ?? 'product';
      return sameSource({ [kind]: r.from }, { [kind]: planned[kind] }) && sameSource({ [kind]: r.to }, { [kind]: current[kind] });
    }) ?? [];
    requireThat(planned.product.root === current.product.root || relocations.some(r => (r.kind ?? 'product') === 'product'), 'planned-source-mismatch');
    const chain = state.attempts.filter(a => a.cycle === cycle.id && a.slot === cycle.cursor);
    if (imported?.latestSource) requireThat(!sameSource(imported.latestSource, current), 'unchanged-retry');
    if (chain.length || !sameSource(planned, current)) {
      requireThat(o.repair, 'planned-source-mismatch-or-material-change-required');
      changed(o.repair, current, d.changed);
      if (chain.length) requireThat(!sameSource(chain.at(-1).source, current), 'unchanged-retry');
      requireThat(Object.values(planned).some(s => s.root === resolve(o.repair.root) && s.head === o.repair.from)
        || relocations.some(r => resolve(o.repair.root) === r.to.root && o.repair.from === r.from.head), 'repair-from-mismatch');
    }
    if (continuation && imported?.nextTotalAttempt >= 3) {
      const review = o.importedBudget.thirdReview;
      effectiveReview = { ...review, evidence: review.evidenceHashes, source: structuredClone(current) };
      reviewThird(effectiveReview,
        imported.previous.map(a => ({ reportHash: a.hash, endedAt: a.endedAt, hypothesis: a.hypothesis })), o.owner, current, o.repair, d.now(), d.lineChanged);
    } else if (cycle.chain === 2 || continuation && cycle.chain >= 2) reviewThird(o.review, chain, o.owner, current, o.repair, d.now(), d.lineChanged);
    if (imported?.nextTotalAttempt >= 3) effectiveReview = { ...o.importedBudget.thirdReview, evidence: o.importedBudget.thirdReview.evidenceHashes, source: structuredClone(current) };
    checkPort(o.world.port);
    requireThat(await d.portFree(o.world.port), 'occupied-resource');
    controller.signal.throwIfAborted();
    const runParent = join(dirname(ledger), 'runs'); mkdirSync(runParent, { recursive: true });
    const dir = mkdtempSync(join(runParent, 'attempt-'));
    paths = { dir, data: join(dir, 'data'), profile: join(dir, 'profile'), video: join(dir, 'video'), log: join(dir, 'world.log') };
    for (const name of ['data', 'profile', 'video']) mkdirSync(paths[name]);
    cycle.chain++;
    if (continuation) (state.continuationAuthorities ??= []).push(continuation.pin);
    report = { version: 1, qualified: false, injected: d.test, owner: o.owner, cycle: cycle.id, slot: cycle.cursor,
      arm: slot.arm, repeat: slot.repeat, repairAttempt: cycle.chain, cumulativeRun: state.attempts.length + 1,
      startedAt: new Date(d.now()).toISOString(), source: current, hypothesis: effectiveReview?.hypothesis ?? o.repair?.hypothesis ?? 'predeclared measurement',
      paths, driver: o.driver ?? null, browserStarted: false, status: 'BOOT_ABORT', assertions: [], console: [], network: [], expectedHttp: [],
      evidence: [...(continuation ? [continuation.pin] : []), ...(effectiveReview && imported ? imported.reviewEvidence : [])], teardown: {}, review: effectiveReview ? structuredClone(effectiveReview) : null,
      ...(continuation ? { continuationAuthority: continuation.pin } : {}) };
    cycle.inFlight = paths.dir; save(); // a crash remains an explicit unfinished ownership record
    requireThat(!state.attempts.some(a => a.runDir === paths.dir), 'reused-run-directory');
    const world = await d.boot({ ...o.world, checkout: current.product.root, data: paths.data, fresh: false, log: paths.log,
      signal: controller.signal, onSpawn(c, mode = {}) {
        requireThat(!children.includes(c) && (native || !child), 'multiple-world-children');
        requireThat(!mode.transient || (o.world.kind === 'v2-bodies' || o.world.kind === 'native-page'), 'transient-fixture-kind');
        children.push(c); if (mode.processGroup) processGroups.add(c); if (mode.transient) transients.add(c); else child ??= c;
        const died = e => { if (!closing) { worldDeath = e; controller.abort(e); } };
        c.once('error', e => { childError = e; died(e); }); c.once('exit', () => { if (!transients.has(c) || c.signalCode !== null || c.exitCode !== 0) died(new Error('proof.owned-world-exited')); }); } });
    requireThat(child && world.child === child && healthy() && !childError, 'boot-not-owned');
    if (o.world.kind === 'v2-account') requireThat(world.children?.length === 4 && world.children.every((c, i) => children[i] === c), 'fixture-children-mismatch');
    if (o.world.kind === 'v2-bodies') requireThat(world.children?.length === 3 && world.children.every((c, i) => children.filter(c => !transients.has(c))[i] === c), 'fixture-children-mismatch');
    if (o.world.kind === 'native-page') requireThat(world.children?.length >= 3 && world.children.every((c, i) => children.filter(c => !transients.has(c))[i] === c), 'fixture-children-mismatch');
    report.ownedOrigin = new URL(world.base).origin;
    requireThat(resolve(world.dataDir) === paths.data && new URL(world.base).port === String(o.world.port), 'boot-resource-mismatch');
    controller.signal.throwIfAborted();
    const fixture = await bounded(() => driver.prepare?.({ base: world.base, paths, signal: controller.signal, recipe: world.recipe, arm: slot.arm, repeat: slot.repeat }), controller.signal, o.phaseTimeoutMs ?? 30000, 'prepare', timeout);
    controller.signal.throwIfAborted();
    requireThat(healthy(), 'owned-world-exited');
    let launchSettled = false, lateBrowser, lateOpened, lateCleanup;
    const closeLate = context => lateCleanup ??= (async () => {
      const result = { browserOpenedAfterAbort: true, closed: false };
      try { await bounded(() => context.close(), null, o.cleanupTimeoutMs ?? 8000, 'late-browser-close'); result.closed = true; }
      catch (error) { result.error = String(error); }
      writeNew(join(paths.dir, 'late-browser-context-cleanup.json'), result); return result;
    })();
    const markObservation = () => {
      if (!report.browserObservationStarted) { report.browserObservationStarted = true; state.captures++; report.captureOrdinal = state.historicalCaptures + state.captures; }
    };
    const opening = Promise.resolve().then(() => d.browser({ ...o, signal: controller.signal, onOpened(context) {
      if (browserCleanupStarted || finalized || controller.signal.aborted) {
        lateOpened = context;
        if (!finalized) { cleanupFailed = true; report.teardown.browserOpenPending = true; }
        void closeLate(context).catch(() => {}); return;
      }
      browser = context; markObservation();
    } }, paths, world.base));
    opening.then(value => { launchSettled = true; lateBrowser = value; }, () => { launchSettled = true; });
    try { browser = await bounded(() => opening, controller.signal, (o.phaseTimeoutMs ?? 30000) + 1000, 'browser-open', timeout); }
    catch (error) {
      if (lateBrowser) browser = lateBrowser;
      else if (!launchSettled) {
        cleanupFailed = true; report.teardown.browserOpenPending = true;
        // A late context is still ours. Preserve its separate cleanup result; never rewrite the failed report.
        void opening.then(context => closeLate(context), async error => lateOpened
          ? { ...await closeLate(lateOpened), setupError: String(error) }
          : { browserOpenedAfterAbort: false, error: String(error) })
          .then(result => writeNew(join(paths.dir, 'late-browser-cleanup.json'), result)).catch(() => {});
      }
      throw error;
    }
    report.browserStarted = true; markObservation();
    report.browserProvenance = browser.provenance ?? null;
    const page = browser.page;
    page.on('console', m => report.console.push({ kind: m.type(), text: m.text(), location: m.location?.() ?? null }));
    page.on('pageerror', e => report.console.push({ kind: 'pageerror', text: String(e) }));
    const navigation = { epoch: 0 }, requested = new WeakMap();
    page.on('request', request => requested.set(request, navigation.epoch));
    page.on('requestfailed', request => { const at = requested.get(request);
      report.network.push({ kind: 'requestfailed', method: request.method(), url: request.url(), error: request.failure()?.errorText ?? 'unknown', inFlightAtDriverNavigation: at !== undefined && navigation.epoch > at }); });
    page.on('response', response => { if (response.status() >= 400) report.network.push({ kind: 'http', status: response.status(), url: response.url() }); });
    observationStop = await bounded(() => driver.beforeNavigation?.({ page, base: world.base, paths, signal: controller.signal }), controller.signal, o.phaseTimeoutMs ?? 30000, 'before-navigation', timeout);
    await bounded(() => page.goto((o.world.kind === 'v2-bodies' || o.world.kind === 'native-page') ? world.viewer : o.world.kind === 'v2-account' ? new URL('/src/account/', world.base).href : world.base + '?dev=1', { waitUntil: 'domcontentloaded', timeout: o.navigationTimeoutMs ?? 30000 }), controller.signal, o.navigationTimeoutMs ?? 30000, 'navigation', timeout);
    // From here on, a goto or reload is the driver's: requests in flight when one starts may be aborted by it.
    for (const name of ['goto', 'reload']) if (typeof page[name] === 'function') { const call = page[name].bind(page); page[name] = (...args) => { navigation.epoch++; return call(...args); }; }
    await bounded(() => driver.default({ page, base: world.base, paths, signal: controller.signal, fixture, arm: slot.arm, repeat: slot.repeat,
      expectHttp(path, status, reason) { requireThat(native && path.startsWith('/') && Number.isSafeInteger(status) && status >= 400 && reason?.trim(), 'expected-http-invalid'); report.expectedHttp.push({ path, status, reason }); },
      check(key, ok, detail = '') { report.assertions.push({ key, ok: !!ok, detail }); if (!ok) throw Object.assign(new Error(detail || key), { assertion: key }); } }), controller.signal, o.journeyTimeoutMs ?? 90000, 'journey', timeout);
    requireThat(report.assertions.length && report.assertions.every(a => a.ok), 'no-passing-assertions');
    if (native) {
      requireThat(report.network.every(event => expectedNetwork(event, report, world.base)), 'unexpected-network-error');
      requireThat(!unexpectedConsole(report, world.base), 'unexpected-console-error');
    }
    requireThat(new URL(page.url()).origin === new URL(world.base).origin, 'journey-left-owned-origin');
    if (o.world.kind === 'native-page') world.recipe.verify();
    const endSource = { product: d.source(o.sourceRoot), tool: d.source(toolRoot), ...(o.driver ? { driver: d.source(o.driver.root) } : {}) };
    requireThat(sameSource(current, endSource), 'source-changed-during-attempt');
    requireThat(!worldDeath && healthy(), 'owned-world-exited');
    report.status = 'PASS';
  } catch (error) {
    if (!report) throw error;
    report.status = report.browserStarted ? controller.signal.aborted && !worldDeath && !timedOut ? 'INTERRUPTED' : 'FAIL' : 'BOOT_ABORT';
    report.error = String(error?.stack ?? error); report.assertion = error?.assertion ?? error?.message ?? 'unknown';
  } finally {
    try {
    if (report) {
      const evidence = (name, value) => { const file = join(paths.dir, name); writeNew(file, value); report.evidence.push({ file, hash: digest(readFileSync(file)) }); };
      try {
        for (const [name, capture] of [[report.status === 'PASS' ? 'final.png' : 'failure.png', () => browser?.page.screenshot()], ['accessibility.yml', () => browser?.page.locator('body').ariaSnapshot()]]) {
          try { const value = await bounded(capture, null, o.cleanupTimeoutMs ?? 8000, 'evidence'); if (value) evidence(name, value); else { evidence(name + '.unavailable.txt', 'Browser observation unavailable at this boundary.\n'); if (report.browserStarted) report.status = 'EVIDENCE_FAIL'; } }
          catch (e) { evidence(name + '.unavailable.txt', String(e)); if (report.browserStarted) report.status = 'EVIDENCE_FAIL'; }
        }
        evidence('world-tail.log', existsSync(paths.log) ? readFileSync(paths.log, 'utf8').slice(-12000) : 'World did not write a log.\n');
        evidence('explanation.md', `${report.error ?? 'Predeclared journey passed.'}\n\n${o.explanation ?? 'See assertions and source-bound repair history.'}\n`);
      } catch (e) { report.evidenceError = String(e); report.status = 'EVIDENCE_FAIL'; }
      try { if (observationStop) await bounded(observationStop, null, o.cleanupTimeoutMs ?? 8000, 'observer-close'); } catch (e) { report.teardown.observerError = String(e); cleanupFailed = true; }
      browserCleanupStarted = true;
      try { if (browser) await bounded(() => browser.close(), null, o.cleanupTimeoutMs ?? 8000, 'browser-close'); report.teardown.browserClosed = !report.teardown.browserOpenPending; } catch (e) { report.teardown.browserError = String(e); cleanupFailed = true; }
      try {
        for (const event of report.network) event.expected = expectedNetwork(event, report, report.ownedOrigin);
        for (const event of report.console) if (event.kind === 'error') event.expected = expectedResourceError(event, report, report.ownedOrigin);
        evidence('console.json', report.console);
        evidence('network.json', report.network);
        if (native && report.status === 'PASS' && (report.network.some(event => !event.expected) || unexpectedConsole(report, report.ownedOrigin))) {
          report.status = 'FAIL'; report.error = 'proof.unexpected-error-during-finalization';
        }
      } catch (e) { report.evidenceError = String(e); report.status = 'EVIDENCE_FAIL'; }
      if (report.status === 'PASS' && !healthy()) worldDeath ??= new Error('proof.owned-world-exited');
      closing = true;
      report.teardown.children = children.map(c => ({ pid: c.pid ?? null, executable: c.spawnfile ?? null, exitCode: c.exitCode, signalCode: c.signalCode, exited: c.exitCode !== null || c.signalCode !== null, error: null }));
      try {
        await bounded(async () => {
          const stopped = await Promise.allSettled((children.length ? children : [child]).map(c => d.stop(c, { processGroup: processGroups.has(c) })));
          report.teardown.children = children.map((c, i) => ({ pid: c.pid ?? null, executable: c.spawnfile ?? null, exitCode: c.exitCode, signalCode: c.signalCode,
            exited: c.exitCode !== null || c.signalCode !== null, error: stopped[i]?.status === 'rejected' ? String(stopped[i].reason) : null }));
          requireThat(stopped.every(r => r.status === 'fulfilled') && report.teardown.children.every(c => c.exited), 'owned-children-still-live');
        }, null, o.cleanupTimeoutMs ?? 8000, 'world-stop');
        report.teardown.worldStopped = true;
      } catch (e) {
        report.teardown.worldError = String(e); cleanupFailed = true;
        report.teardown.children = children.map((c, i) => ({ ...report.teardown.children[i], exitCode: c.exitCode, signalCode: c.signalCode, exited: c.exitCode !== null || c.signalCode !== null }));
      }
      try {
        if (existsSync(paths.log)) report.evidence.push({ file: paths.log, hash: digest(readFileSync(paths.log)) });
        if (native) for (const file of readdirSync(paths.dir).filter(f => /^(?:command-.*\.json|accessibility-before-.*\.yml|transient-cleanup\.json|native-page-provenance\.json|native-input-facts\.json|native-manual\.png|native-document\.html)$/.test(f))) { const at = join(paths.dir, file); report.evidence.push({ file: at, hash: digest(readFileSync(at)) }); }
        const captureDir = join(paths.dir, 'capture');
        if (existsSync(captureDir)) for (const file of readdirSync(captureDir)) { const at = join(captureDir, file); report.evidence.push({ file: at, hash: digest(readFileSync(at)) }); }
        for (const file of readdirSync(paths.video)) {
          const at = join(paths.video, file); report.evidence.push({ file: at, hash: digest(readFileSync(at)) });
          if (!d.test && native && file.endsWith('.webm')) {
            const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', at], { encoding: 'utf8', timeout: 5000 }));
            requireThat(Number.isFinite(seconds) && seconds > 0 && seconds <= journeyCap(o) / 1000, 'video-duration-out-of-bounds');
            (report.videoDurations ??= []).push({ file: at, seconds });
          }
        }
        if (!d.test && report.browserStarted) requireThat(report.teardown.browserClosed && readdirSync(paths.video).some(f => f.endsWith('.webm')), 'finalized-video-required');
      } catch (e) { report.evidenceError = String(e); report.status = 'EVIDENCE_FAIL'; }
      if (cleanupFailed) report.status = 'CLEANUP_FAIL';
      else if (worldDeath) { report.status = report.browserStarted ? 'FAIL' : 'BOOT_ABORT'; report.error ??= String(worldDeath); }
      else if (controller.signal.aborted) { report.status = report.browserStarted ? timedOut ? 'FAIL' : 'INTERRUPTED' : 'BOOT_ABORT'; report.error ??= String(controller.signal.reason); }
      if (report.status === 'PASS') {
        try { requireThat(sameSource(report.source, { product: d.source(o.sourceRoot), tool: d.source(toolRoot), ...(o.driver ? { driver: d.source(o.driver.root) } : {}) }), 'source-changed-during-finalization'); }
        catch (e) { report.status = 'FAIL'; report.error = String(e); }
      }
      report.endedAt = new Date(d.now()).toISOString(); report.qualified = !d.test && report.status === 'PASS';
      const cycle = state.cycles.at(-1), chain = state.attempts.filter(a => a.cycle === cycle.id && a.slot === cycle.cursor);
      cycle.armSources[report.arm] = report.source.product; cycle.toolSource = report.source.tool; if (report.source.driver) cycle.driverSource = report.source.driver;
      if (report.status === 'PASS') { cycle.cursor++; cycle.chain = 0; }
      else if (chain.some(a => a.assertion === report.assertion && sameSource(a.source, report.source))) cycle.stopped = 'unchanged repeated assertion';
      const file = join(paths.dir, 'report.json'); writeNew(file, report);
      state.attempts.push({ cycle: report.cycle, slot: report.slot, runDir: paths.dir, source: report.source, status: report.status,
        assertion: report.assertion, hypothesis: report.hypothesis, endedAt: report.endedAt, report: file, reportHash: digest(readFileSync(file)) });
      delete cycle.inFlight; if (cleanupFailed) cycle.stopped = 'cleanup failed'; save(); finalized = true;
    }
    } finally {
    o.signal?.removeEventListener('abort', onAbort); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); process.removeListener('SIGHUP', onSignal);
    if (report && !finalized) cleanupFailed = true;
    if (!cleanupFailed) rmSync(lock, { recursive: true });
    }
  }
  return report;
}
