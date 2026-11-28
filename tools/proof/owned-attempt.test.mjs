import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createTestRunner, runOwnedAttempt, journeyCap } from './owned-attempt.mjs';
import { verifyAccountArtifacts } from './v2-account-fixture.mjs';
import { createHash } from 'node:crypto';

const parent = resolve('.local/proof-owned-attempt-tests'); mkdirSync(parent, { recursive: true });
function setup(t, overrides = {}) {
  const root = mkdtempSync(join(parent, 'lifecycle-')), product = join(root, 'product'); mkdirSync(product);
  writeFileSync(join(product, 'fix.ts'), 'export const repaired = true;\n');
  let head = 'p1', tool = 't1', clock = Date.now(); const children = [], browsers = [];
  const identity = r => ({ root: resolve(r), head: resolve(r) === product ? head : tool });
  const runner = createTestRunner({ source: identity, changed: () => ['fix.ts'], now: () => ++clock,
    portFree: async () => true,
    boot: async o => { const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); children.push(child); o.onSpawn(child);
      writeFileSync(o.log, 'owned fake world\n'); return { child, base: `https://example.com:${o.port}/w/${o.slug}`, dataDir: o.data }; },
    browser: async (o, paths, base) => { let url = base; const b = { closed: false, base,
      page: { on() {}, goto: async v => { url = v; }, url: () => url, screenshot: async () => Buffer.from('PNG observation'), locator: () => ({ ariaSnapshot: async () => '- canvas' }) },
      close: async () => { b.closed = true; } }; browsers.push(b); return b; },
    stop: async c => { if (c) c.exitCode = 0; }, ...overrides });
  const o = { owner: '/test/implementer', toolRoot: root, sourceRoot: product, ledger: join(root, 'ledger.json'), arm: 'candidate', repeat: 1,
    cycle: { id: 'corrective-1', fix: { root: product, from: 'p0', to: 'p1', paths: ['fix.ts'], scope: 'repair fixture lifecycle' },
      arms: { candidate: { root: product, head: 'p1' } }, plan: [{ arm: 'candidate', repeat: 1 }] },
    world: { slug: 'proof-fixture', port: 19040 }, journey: async c => c.check('contact', true) };
  const change = (next, hypothesis = 'correct the contact fixture') => { const from = head; head = next; o.repair = { root: product, from, to: next, paths: ['fix.ts'], scope: 'relevant contact correction', hypothesis }; };
  const ledger = () => JSON.parse(readFileSync(o.ledger));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, product, runner, o, change, children, browsers, ledger, identity, now: () => ++clock };
}
test('fresh success owns directories and teardown; passing scenario cannot be rerun by a commit', async t => {
  const f = setup(t); const r = await f.runner(f.o);
  assert.equal(r.status, 'PASS'); assert.equal(r.qualified, false); assert.equal(r.injected, true);
  assert.equal(r.captureOrdinal, 1); assert.equal(f.children[0].exitCode, 0); assert.equal(f.browsers[0].closed, true);
  assert.notEqual(r.paths.data, r.paths.profile); assert.ok(existsSync(r.paths.data));
  f.change('p2'); await assert.rejects(f.runner(f.o), /passing-scenario-rerun/);
});
test('failed assertion preserves immutable observations, fresh retry, and pins the planned sample', async t => {
  const f = setup(t); f.o.cycle.plan.push({ arm: 'candidate', repeat: 2 });
  f.o.journey = async c => c.check('contact', false, 'no soil contact');
  const one = await f.runner(f.o), raw = readFileSync(join(one.paths.dir, 'report.json'));
  assert.equal(one.status, 'FAIL'); assert.ok(one.evidence.some(e => e.file.endsWith('failure.png')));
  for (const name of ['accessibility.yml', 'console.json', 'world-tail.log', 'explanation.md']) assert.ok(one.evidence.some(e => e.file.endsWith(name)));
  f.o.repeat = 2; await assert.rejects(f.runner(f.o), /failed-slot-cannot-be-skipped/); f.o.repeat = 1;
  await assert.rejects(f.runner(f.o), /material-change-required/);
  f.change('p2'); f.o.journey = async c => c.check('contact', true);
  const two = await f.runner(f.o); assert.equal(two.repairAttempt, 2); assert.notEqual(two.paths.dir, one.paths.dir);
  assert.deepEqual(readFileSync(join(one.paths.dir, 'report.json')), raw);
  writeFileSync(join(one.paths.dir, 'explanation.md'), 'tampered'); f.o.repeat = 2;
  await assert.rejects(f.runner(f.o), /evidence-changed/);
});
test('third attempt requires fresh independent evidence-bound review and is the last attempt', async t => {
  let changedLine = true; const f = setup(t, { lineChanged: () => changedLine }); f.o.journey = async c => c.check('contact', false);
  await f.runner(f.o); f.change('p2', 'adjust hand approach'); await f.runner(f.o); f.change('p3', 'repair target fixture');
  await assert.rejects(f.runner(f.o), /independent-review-required/);
  const attempts = f.ledger().attempts;
  f.o.review = { reviewer: f.o.owner, evidenceOnly: true, decision: 'TRY', at: new Date(f.now()).toISOString(), evidence: attempts.map(a => a.reportHash),
    source: { product: f.identity(f.product), tool: f.identity(f.root) }, hypothesis: 'different concrete frame hypothesis', change: { path: 'fix.ts', line: 1 } };
  await assert.rejects(f.runner(f.o), /independent-review-required/);
  f.o.review.reviewer = '/test/evidence-reviewer'; f.o.review.decision = 'ESCALATE';
  await assert.rejects(f.runner(f.o), /review-escalate/); f.o.review.decision = 'TRY';
  f.o.review.evidence = ['stale']; await assert.rejects(f.runner(f.o), /review-evidence-mismatch/); f.o.review.evidence = attempts.map(a => a.reportHash);
  f.o.review.source.product.head = 'stale'; await assert.rejects(f.runner(f.o), /review-source-mismatch/); f.o.review.source.product = f.identity(f.product);
  f.o.review.at = attempts[1].endedAt; await assert.rejects(f.runner(f.o), /review-stale/); f.o.review.at = new Date(f.now()).toISOString();
  const newHypothesis = f.o.review.hypothesis; f.o.review.hypothesis = attempts[0].hypothesis;
  await assert.rejects(f.runner(f.o), /different-hypothesis-required/); f.o.review.hypothesis = newHypothesis;
  changedLine = false; await assert.rejects(f.runner(f.o), /review-line-not-changed/); changedLine = true;
  const third = await f.runner(f.o); assert.equal(third.repairAttempt, 3); assert.equal(third.status, 'FAIL');
  f.change('p4'); await assert.rejects(f.runner(f.o), /repair-ceiling/);
});
function continuation(f, {current,relocations=[],maximum=4}={}) {
  const file=join(f.root,'continuation.json'),value={schema:'owned-proof-continuation/1',authorizer:'/test/coordinator',
    grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date(f.now()).toISOString(),owner:f.o.owner,
    ledger:{file:f.o.ledger,hash:createHash('sha256').update(readFileSync(f.o.ledger)).digest('hex')},cycle:f.o.cycle,
    current:current??{product:f.identity(f.product),tool:f.identity(f.root)},importedBudget:null,
    slot:{arm:f.o.arm,repeat:f.o.repeat,maxTotalAttempts:maximum},relocations,
    frozenEvidence:f.ledger().attempts.map(a=>({file:a.report,hash:a.reportHash}))};
  writeFileSync(file,JSON.stringify(value));f.o.continuationAuthority={file,hash:createHash('sha256').update(readFileSync(file)).digest('hex')};
  return value;
}
function latestReview(f) {
  const rows=f.ledger().attempts.slice(-2);
  return {reviewer:'/test/independent-reviewer',evidenceOnly:true,decision:'TRY',at:new Date(f.now()).toISOString(),
    evidence:rows.map(a=>a.reportHash),source:{product:f.identity(f.product),tool:f.identity(f.root)},
    hypothesis:'new independently diagnosed correction '+rows.length+' '+rows.at(-1).reportHash,change:{path:'fix.ts',line:1}};
}
test('an exact one-prestate authority permits a fourth correction without resetting the chain or old evidence',async t=>{
  const f=setup(t);f.o.journey=async c=>c.check('contact',false);
  const one=await f.runner(f.o);f.change('p2');await f.runner(f.o);f.change('p3');f.o.review=latestReview(f);await f.runner(f.o);
  const old=readFileSync(join(one.paths.dir,'report.json'));f.change('p4');f.o.review=latestReview(f);
  await assert.rejects(f.runner(f.o),/repair-ceiling/);continuation(f);
  const prior=f.o.review.evidence;f.o.review.evidence=f.ledger().attempts.map(a=>a.reportHash);
  await assert.rejects(f.runner(f.o),/review-evidence-mismatch/);f.o.review.evidence=prior;
  f.o.journey=async c=>c.check('contact',true);const four=await f.runner(f.o);
  assert.equal(four.status,'PASS');assert.equal(four.repairAttempt,4);assert.equal(f.ledger().attempts.length,4);
  assert.equal(f.ledger().cycles.length,1);assert.deepEqual(readFileSync(join(one.paths.dir,'report.json')),old);
  assert.deepEqual(four.continuationAuthority,f.o.continuationAuthority);assert.equal(f.ledger().continuationAuthorities.length,1);
});
test('authorized product relocation verifies the frozen root and still requires a relevant source repair',async t=>{
  let identity;const f=setup(t,{source:r=>identity(r)});identity=f.identity;
  f.o.journey=async c=>c.check('contact',false);const first=await f.runner(f.o),old=readFileSync(join(first.paths.dir,'report.json'));
  const to=join(f.root,'relocated');mkdirSync(to);writeFileSync(join(to,'fix.ts'),'export const repaired = 2;');
  identity=r=>resolve(r)===to?{root:to,head:'p2'}:f.identity(r);f.o.sourceRoot=to;
  f.o.repair={root:to,from:'p1',to:'p2',paths:['fix.ts'],scope:'reviewed source relocation and correction',hypothesis:'actual corrected current source'};
  await assert.rejects(f.runner(f.o),/planned-source-mismatch/);
  continuation(f,{maximum:3,current:{product:identity(to),tool:identity(f.root)},relocations:[{from:f.identity(f.product),to:identity(to),
    sourceFiles:[{path:'fix.ts',hash:createHash('sha256').update(readFileSync(join(f.product,'fix.ts'))).digest('hex')}]}]});
  f.o.journey=async c=>c.check('contact',true);const second=await f.runner(f.o);
  assert.equal(second.status,'PASS');assert.equal(second.repairAttempt,2);assert.equal(f.ledger().cycles.length,1);
  assert.deepEqual(readFileSync(join(first.paths.dir,'report.json')),old);
  assert.equal(readFileSync(join(f.product,'fix.ts'),'utf8'),'export const repaired = true;\n');
});
test('an explicitly relocated tool and identical ledger retain counts and require a material tool correction',async t=>{
  let identity;const f=setup(t,{source:r=>identity(r)});identity=f.identity;
  writeFileSync(join(f.root,'fix.ts'),'frozen helper');f.o.journey=async c=>c.check('contact',false);await f.runner(f.o);
  const fromFile=f.o.ledger,old=readFileSync(fromFile),to=join(f.root,'new-tool');mkdirSync(to);writeFileSync(join(to,'fix.ts'),'corrected helper');
  identity=r=>resolve(r)===to?{root:to,head:'t2'}:f.identity(r);
  f.o.toolRoot=to;f.o.ledger=join(to,'ledger.json');writeFileSync(f.o.ledger,old);
  f.o.repair={root:to,from:'t1',to:'t2',paths:['fix.ts'],scope:'actual helper compatibility correction'};
  const options={current:{product:identity(f.product),tool:identity(to)}};
  continuation(f,options);await assert.rejects(f.runner(f.o),/repair-from-mismatch/);
  options.relocations=[{kind:'tool',from:identity(f.root),to:identity(to),sourceFiles:[{path:'fix.ts',hash:createHash('sha256').update(readFileSync(join(f.root,'fix.ts'))).digest('hex')}]}];
  const a=continuation(f,options);a.ledgerRelocation={fromFile,hash:createHash('sha256').update(old).digest('hex'),toFile:f.o.ledger};
  writeFileSync(f.o.continuationAuthority.file,JSON.stringify(a));f.o.continuationAuthority.hash=createHash('sha256').update(readFileSync(f.o.continuationAuthority.file)).digest('hex');
  f.o.journey=async c=>c.check('contact',true);const report=await f.runner(f.o);
  assert.equal(report.status,'PASS');assert.equal(report.repairAttempt,2);assert.equal(f.ledger().attempts.length,2);assert.equal(f.ledger().cycles.length,1);
  assert.deepEqual(readFileSync(fromFile),old);assert.equal(report.source.tool.root,to);
});
test('a continuation cannot bypass stopped, unfinished or cleanup-failed ownership',async t=>{
  const f=setup(t);f.o.journey=async c=>c.check('contact',false);await f.runner(f.o);f.change('p2');
  const state=f.ledger();state.cycles[0].stopped='cleanup failed';writeFileSync(f.o.ledger,JSON.stringify(state));continuation(f);
  await assert.rejects(f.runner(f.o),/repair-ceiling/);
  delete state.cycles[0].stopped;state.cycles[0].inFlight='owned';writeFileSync(f.o.ledger,JSON.stringify(state));continuation(f);
  await assert.rejects(f.runner(f.o),/unfinished-attempt/);
  const g=setup(t,{stop:async()=>{throw Error('cleanup failed');}});await g.runner(g.o);g.change('p2');continuation(g);
  await assert.rejects(g.runner(g.o),/EEXIST/);assert.ok(existsSync(g.o.ledger+'.lock'));
});
test('two predeclared repeats per arm allow passes, but a failure cannot be sidestepped and counts all three tries', async t => {
  const f = setup(t); f.o.cycle.arms.baseline = { root: f.product, head: 'p1' };
  f.o.cycle.plan = [{ arm: 'baseline', repeat: 1 }, { arm: 'baseline', repeat: 2 }, { arm: 'candidate', repeat: 1 }, { arm: 'candidate', repeat: 2 }];
  f.o.arm = 'baseline'; const a = await f.runner(f.o); f.o.repeat = 2; const b = await f.runner(f.o);
  assert.equal(a.repairAttempt, 1); assert.equal(b.repairAttempt, 1);
  f.o.arm = 'candidate'; f.o.repeat = 1; f.o.journey = async c => c.check('contact', false); const c = await f.runner(f.o);
  f.o.repeat = 2; await assert.rejects(f.runner(f.o), /failed-slot-cannot-be-skipped/); f.o.repeat = 1;
  f.change('p2'); f.o.journey = async c => c.check('contact', true); const d = await f.runner(f.o);
  f.o.repeat = 2; const e = await f.runner(f.o);
  assert.deepEqual([a, b, c, d, e].map(r => r.captureOrdinal), [1, 2, 3, 4, 5]);
  assert.deepEqual([c, d, e].map(r => r.repairAttempt), [1, 2, 1]);
});
test('competing owner, occupied/reserved resources, existing paths and unowned healthy world are refused', async t => {
  const f = setup(t); mkdirSync(f.o.ledger + '.lock');
  await assert.rejects(f.runner(f.o), /EEXIST/); rmSync(f.o.ledger + '.lock', { recursive: true });
  await assert.rejects(f.runner({ ...f.o, url: 'https://example.com' }), /existing-resource-override/);
  await assert.rejects(f.runner({ ...f.o, dataDir: f.root }), /existing-resource-override/);
  f.o.world.port = 7830; await assert.rejects(f.runner(f.o), /reserved/);
  const g = setup(t, { portFree: async () => false }); await assert.rejects(g.runner(g.o), /occupied-resource/);
  const h = setup(t, { boot: async () => ({ child: {}, base: 'https://example.com', dataDir: 'old' }) });
  const r = await h.runner(h.o); assert.equal(r.status, 'BOOT_ABORT'); assert.match(r.error, /boot-not-owned/); assert.equal(r.qualified, false);
});
test('boot errors, interruption and cleanup failure stay visible and never qualify', async t => {
  const f = setup(t, { boot: async o => { const c = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); o.onSpawn(c); throw Error('boot failed'); } });
  const boot = await f.runner(f.o); assert.equal(boot.status, 'BOOT_ABORT'); assert.equal(boot.browserStarted, false); assert.equal(boot.teardown.worldStopped, true);
  const g = setup(t, { stop: async () => { throw Error('owned teardown failed'); } }); const cleanup = await g.runner(g.o);
  assert.equal(cleanup.status, 'CLEANUP_FAIL'); assert.equal(cleanup.qualified, false); assert.ok(existsSync(g.o.ledger + '.lock'));
  const h = setup(t), controller = new AbortController(); h.o.signal = controller.signal;
  h.o.journey = async () => { controller.abort(Error('test interrupt')); await new Promise(() => {}); };
  const interrupted = await h.runner(h.o); assert.equal(interrupted.status, 'INTERRUPTED'); assert.equal(h.browsers[0].closed, true); assert.equal(h.children[0].exitCode, 0);
});
test('historical capture ordinals survive explicit cycles and changed HEAD does not reset a failed chain', async t => {
  const f = setup(t); f.o.history = { count: 7, evidence: [] }; f.o.journey = async c => c.check('contact', false);
  const r = await f.runner(f.o); assert.equal(r.captureOrdinal, 8); f.change('p2');
  const second = await f.runner(f.o); assert.equal(second.repairAttempt, 2);
  f.o.cycle = { ...f.o.cycle, id: 'corrective-2', fix: { root: f.product, from: 'p2', to: 'p2', paths: ['fix.ts'], scope: 'commit alone' } };
  await assert.rejects(f.runner(f.o), /material-change-required/);
});
test('crashed in-flight ownership and unplanned source substitutions cannot start another attempt', async t => {
  const f = setup(t); await f.runner(f.o);
  const state = f.ledger(); state.cycles[0].cursor = 0; state.cycles[0].chain = 0; state.cycles[0].inFlight = 'unfinished-owned-run';
  writeFileSync(f.o.ledger, JSON.stringify(state));
  await assert.rejects(f.runner(f.o), /unfinished-attempt/);
  const g = setup(t); g.o.cycle.arms.candidate.head = 'different-source';
  await assert.rejects(g.runner(g.o), /planned-source-mismatch/);
});
test('failure evidence errors still close exactly the owned browser and world', async t => {
  let stopped = false, closed = false;
  const f = setup(t, { browser: async (o, paths, base) => ({ page: { on() {}, goto: async () => {}, url: () => base,
    screenshot: async () => { mkdirSync(join(paths.dir, 'failure.png')); mkdirSync(join(paths.dir, 'failure.png.unavailable.txt')); throw Error('capture unavailable'); },
    locator: () => ({ ariaSnapshot: async () => '- fixture' }) }, close: async () => { closed = true; } }),
    stop: async () => { stopped = true; } });
  f.o.journey = async c => c.check('contact', false);
  try { await f.runner(f.o); } catch { /* disk/capture faults must not bypass resource cleanup */ }
  assert.equal(closed, true); assert.equal(stopped, true);
});
test('passing assertions cannot qualify without required screenshot and accessibility observations', async t => {
  const f = setup(t, { browser: async (o, paths, base) => ({ page: { on() {}, goto: async () => {}, url: () => base,
    screenshot: async () => { throw Error('screenshot unavailable'); }, locator: () => ({ ariaSnapshot: async () => { throw Error('accessibility unavailable'); } }) }, close: async () => {} }) });
  const report = await f.runner(f.o); assert.equal(report.status, 'EVIDENCE_FAIL'); assert.equal(report.qualified, false);
  assert.equal(report.teardown.worldStopped, true); assert.ok(report.evidence.some(e => e.file.endsWith('.unavailable.txt')));
});
test('real owned tiny child receives forced fake/data/auth settings and exits after success and boot abort', async t => {
  let owned;
  const f = setup(t, { boot: undefined, stop: undefined });
  // Use production boot/teardown with an isolated tiny native-entry fixture; browser remains an injected observation.
  const { startWorld } = await import('../god-skill/dev-world.mjs');
  const server = join(f.product, 'apps/server/src'); mkdirSync(server, { recursive: true });
  writeFileSync(join(server, 'main.ts'), `import {createServer} from 'node:http';\nconsole.log(JSON.stringify({brain:process.env.BRAIN_MODE,auth:process.env.DEV_AUTH,data:process.env.DATA_DIR}));\ncreateServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT));\n`);
  const port = await new Promise(resolve => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const runner = createTestRunner({ source: r => ({root:resolve(r),head:resolve(r).endsWith('/product')?'p1':'t1'}), changed: () => ['fix.ts'], browser: async (o, paths, base) => ({ page: {
    on() {}, goto: async () => {}, url: () => base, screenshot: async () => Buffer.from('PNG'), locator: () => ({ ariaSnapshot: async () => '- fixture' }) }, close: async () => {} }),
    boot: async o => startWorld({ ...o, onSpawn(c) { owned = c; o.onSpawn(c); } }) });
  f.o.world.port = port; f.o.world.env = { BRAIN_MODE: 'live', DEV_AUTH: '0', DATA_DIR: 'old-data' };
  const result = await runner(f.o); assert.equal(result.status, 'PASS'); assert.ok(owned.exitCode !== null || owned.signalCode !== null);
  const env = JSON.parse(readFileSync(result.paths.log, 'utf8').trim()); assert.equal(env.brain, 'fake'); assert.equal(env.auth, '1'); assert.equal(env.data, result.paths.data);
  assert.equal(result.qualified, false);
  const g = setup(t); mkdirSync(join(g.product, 'apps/server/src'), { recursive: true });
  writeFileSync(join(g.product, 'apps/server/src/main.ts'), "throw Error('fixture boot failed');\n");
  g.o.world.port = port; g.o.world.timeoutMs = 1000;
  const aborted = await runner({ ...g.o, journey: async c => c.check('must-not-run', true) });
  assert.equal(aborted.status, 'BOOT_ABORT'); assert.equal(aborted.assertions.length, 0);
  assert.ok(owned.exitCode !== null || owned.signalCode !== null);
  const h = setup(t); mkdirSync(join(h.product, 'apps/server/src'), { recursive: true });
  writeFileSync(join(h.product, 'apps/server/src/main.ts'), "import {createServer} from 'node:http';createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT));setTimeout(()=>process.exit(1),180);\n");
  h.o.world.port = port; h.o.journey = async c => { await new Promise(r => setTimeout(r, 250)); c.check('contact', true); };
  const death = await runner(h.o); assert.equal(death.status, 'FAIL'); assert.match(death.error, /owned-world-exited/);
});
test('default checkout caller and ownership-callback error retain default entrypoint and stop the spawned child', async t => {
  const f = setup(t); const { startWorld } = await import('../god-skill/dev-world.mjs'); let child;
  const data = join(f.root, 'default-data');
  await assert.rejects(startWorld({ slug: 'default-fixture', port: 19049, data, log: join(f.root, 'default.log'),
    onSpawn(c) { child = c; assert.equal(c.spawnargs[1], 'apps/server/src/main.ts'); throw Error('stop before entry'); } }), /stop before entry/);
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  assert.ok(existsSync(data)); assert.ok(child.exitCode !== null || child.signalCode !== null);
});
for (const explicit of [false, true]) test(`public world adapter resolves relative genesis from ${explicit ? 'explicit checkout' : 'legacy caller cwd'}`, async t => {
  const f = setup(t), { startWorld } = await import('../god-skill/dev-world.mjs'), previous = process.cwd();
  const caller = join(f.root, 'caller'); mkdirSync(caller); mkdirSync(join(f.product, 'apps/server/src'), { recursive: true });
  writeFileSync(join(f.product, 'apps/server/src/main.ts'), "throw Error('probe must exit before the real entry');\n");
  writeFileSync(join(caller, 'relative-seed.json'), 'caller fixture'); writeFileSync(join(f.product, 'relative-seed.json'), 'checkout fixture');
  const port = await new Promise(resolve => { const server = createServer().listen(0, () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const probe = "import{readFileSync}from'node:fs';console.log(JSON.stringify({genesis:process.env.GENESIS_FILE,content:readFileSync(process.env.GENESIS_FILE,'utf8')}));process.exit(0);";
  const log = join(f.root, 'genesis-probe.log'); let child;
  try {
    process.chdir(caller);
    await assert.rejects(startWorld({ slug: 'genesis-probe', port, data: join(f.root, 'data'), genesis: 'relative-seed.json',
      ...(explicit ? { checkout: f.product } : {}), log, timeoutMs: 1500, onSpawn: c => { child = c; },
      env: { NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(probe), GENESIS_FILE: 'must-not-override-owned-recipe' } }), /world exited before healthy/);
  } finally {
    process.chdir(previous);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  }
  assert.equal(child.exitCode, 0, 'the actual child could read the selected fixture before its controlled exit');
  const selected = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(selected.genesis, join(explicit ? f.product : caller, 'relative-seed.json'));
  assert.equal(selected.content, explicit ? 'checkout fixture' : 'caller fixture');
});
test('actual public API rejects arbitrary running URLs before any browser or child work', async () => {
  await assert.rejects(runOwnedAttempt({ owner: 'agent', cycle: { id: 'x', plan: [{}] }, ledger: 'unused', url: 'https://example.com' }), /existing-resource-override/);
});
test('empty-tree fix, changed agent identity and untracked driver cannot launder qualification', async t => {
  const f = setup(t, { changed: () => [''] }); f.o.cycle.fix.paths = [''];
  await assert.rejects(f.runner(f.o), /change-paths-mismatch/);
  const g = setup(t); g.o.journey = async c => c.check('contact', false); await g.runner(g.o); g.change('p2'); g.o.owner = '/test/renamed';
  await assert.rejects(g.runner(g.o), /owner-mismatch/);
  await assert.rejects(runOwnedAttempt({ ...g.o, journey: async () => {} }), /committed-driver-required/);
});
test('owned-world death during otherwise passing assertions and late interruption are failures', async t => {
  const f = setup(t); f.o.journey = async c => { f.children[0].exitCode = 1; f.children[0].emit('exit', 1); c.check('contact', true); };
  const died = await f.runner(f.o); assert.equal(died.status, 'FAIL'); assert.equal(died.qualified, false);
  const controller = new AbortController();
  const g = setup(t, { browser: async (o, paths, base) => ({ page: { on() {}, goto: async () => {}, url: () => base,
    screenshot: async () => { controller.abort(Error('late interrupt')); return Buffer.from('PNG'); }, locator: () => ({ ariaSnapshot: async () => '- fixture' }) }, close: async () => {} }) });
  g.o.signal = controller.signal;
  const interrupted = await g.runner(g.o); assert.equal(interrupted.status, 'INTERRUPTED'); assert.equal(interrupted.qualified, false);
});
test('interrupted browser launch retains pending ownership, stops the world, and closes only its late context', async t => {
  const controller = new AbortController(); let opened, closed = false;
  const f = setup(t, { browser: async () => { setTimeout(() => controller.abort(Error('launch interrupted')), 1); return await new Promise(resolve => { opened = resolve; }); } });
  f.o.signal = controller.signal;
  const report = await f.runner(f.o); assert.equal(report.status, 'CLEANUP_FAIL'); assert.equal(report.teardown.worldStopped, true);
  assert.equal(report.teardown.browserClosed, false); assert.equal(report.teardown.browserOpenPending, true); assert.ok(existsSync(f.o.ledger + '.lock'));
  const original = readFileSync(join(report.paths.dir, 'report.json'));
  opened({ close: async () => { closed = true; } }); await new Promise(r => setImmediate(r));
  assert.equal(closed, true); assert.deepEqual(readFileSync(join(report.paths.dir, 'report.json')), original);
  assert.equal(JSON.parse(readFileSync(join(report.paths.dir, 'late-browser-cleanup.json'))).closed, true);
});
test('tracked committed driver preflight uses matching product/tool/driver identities and bounds all hooks', async t => {
  const f = setup(t), env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Proof Fixture', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'Proof Fixture', GIT_COMMITTER_EMAIL: 'proof@example.com' };
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(join(f.root, '.gitignore'), 'runs/\nledger.json*\n');
  writeFileSync(join(f.root, 'driver.mjs'), 'export default async c => c.check("tracked-driver",true);\n');
  git('add', '.'); git('commit', '-m', 'Initial fixture'); const from = git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'driver.mjs'), 'export default async c => c.check("tracked-driver",true,"corrected fixture");\n');
  git('add', '.'); git('commit', '-m', 'Correct fixture'); let head = git('rev-parse', 'HEAD');
  f.o.sourceRoot = f.root; f.o.driver = { root: f.root, path: 'driver.mjs' };
  f.o.cycle.fix = { root: f.root, from, to: head, paths: ['driver.mjs'], scope: 'relevant fixture correction' };
  f.o.cycle.arms.candidate = { root: f.root, head };
  let cancelling, controller;
  const callbacks = { boot: async o => { const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); o.onSpawn(child); if (cancelling === 'prepare') setTimeout(() => controller.abort(Error('prepare interrupted')), 5); return { child, base: `https://example.com:${o.port}`, dataDir: o.data }; },
    browser: async (o, paths, base) => { if (cancelling === 'beforeNavigation') setTimeout(() => controller.abort(Error('navigation interrupted')), 5); return { page: { on() {}, goto: async () => {}, url: () => base, screenshot: async () => Buffer.from('PNG'), locator: () => ({ ariaSnapshot: async () => '- fixture' }) }, close: async () => {} }; }, stop: async c => { if(c)c.exitCode = 0; },
    source: root => ({ root: resolve(root), head: git('rev-parse', 'HEAD') }), changed: () => ['driver.mjs'], portFree: async () => true };
  const runner = createTestRunner(callbacks), passed = await runner(f.o);
  assert.equal(passed.status, 'PASS'); assert.deepEqual(Object.keys(passed.source).sort(), ['driver', 'product', 'tool']);
  for (const phase of ['prepare', 'prepare-abort', 'beforeNavigation', 'beforeNavigation-abort', 'observer']) {
    const hook = phase.replace('-abort', '');
    const code = phase === 'observer' ? 'export const beforeNavigation=async()=>()=>new Promise(()=>{});' : `export const ${hook}=async({signal,paths})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{writeFileSync(join(paths.dir,'hook-aborted.txt'),'observed');${phase.endsWith('-abort') ? 'reject(signal.reason);' : ''}},{once:true}));`;
    writeFileSync(join(f.root, 'driver.mjs'), "import {writeFileSync} from 'node:fs';import {join} from 'node:path';\n" + code + '\nexport default async c=>c.check("hook",true);\n');
    git('add', 'driver.mjs'); git('commit', '-m', 'Correct hook fixture'); const next = git('rev-parse', 'HEAD');
    f.o.cycle = { ...f.o.cycle, id: phase, fix: { ...f.o.cycle.fix, from: head, to: next }, arms: { candidate: { root: f.root, head: next } } }; head = next;
    cancelling = phase.endsWith('-abort') ? hook : null; controller = new AbortController(); f.o.signal = controller.signal;
    f.o.phaseTimeoutMs = cancelling ? 1000 : 5; f.o.cleanupTimeoutMs = 5;
    const r = await runner(f.o); assert.equal(r.teardown.worldStopped, true);
    assert.equal(r.qualified, false); assert.equal(r.status, phase === 'observer' ? 'CLEANUP_FAIL' : hook === 'prepare' ? 'BOOT_ABORT' : cancelling ? 'INTERRUPTED' : 'FAIL');
    if (phase !== 'observer') assert.ok(existsSync(join(r.paths.dir, 'hook-aborted.txt')), 'timeout and cancellation abort the hook signal');
    if (phase === 'observer') assert.ok(existsSync(f.o.ledger + '.lock'), 'failed observer cleanup retains ownership');
  }
});
test('public production preflight refuses a dirty helper, or reaches owned boot with three matching committed identities', async t => {
  const f = setup(t), env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Proof Fixture', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'Proof Fixture', GIT_COMMITTER_EMAIL: 'proof@example.com' };
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(join(f.root, '.gitignore'), 'runs/\nledger.json*\n');
  mkdirSync(join(f.root, 'apps/server/src'), { recursive: true });
  writeFileSync(join(f.root, 'apps/server/src/main.ts'), "import {createServer} from 'node:http';createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT));\n");
  writeFileSync(join(f.root, 'driver.mjs'), 'export default async c=>c.check("fixture",true);\n');
  git('add', '.'); git('commit', '-m', 'Initial fixture'); const from = git('rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'driver.mjs'), 'export default async c=>c.check("fixture",true,"corrected fixture");\n');
  git('add', '.'); git('commit', '-m', 'Correct fixture'); const head = git('rev-parse', 'HEAD');
  const port = await new Promise(resolve => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const o = { ...f.o, toolRoot: undefined, sourceRoot: f.root, driver: { root: f.root, path: 'driver.mjs' }, world: { slug: 'owned-test', port, timeoutMs: 2000 },
    cycle: { id: 'public-preflight', fix: { root: f.root, from, to: head, paths: ['driver.mjs'], scope: 'actual committed fixture correction' }, arms: { candidate: { root: f.root, head } }, plan: [{ arm: 'candidate', repeat: 1 }] } };
  delete o.journey;
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) await assert.rejects(runOwnedAttempt(o), /source-dirty/);
  else {
    const r = await runOwnedAttempt(o); assert.equal(r.status, 'BOOT_ABORT'); assert.equal(r.browserStarted, false);
    assert.match(r.error, /explicit-browser-cache-required/); assert.equal(r.teardown.worldStopped, true); assert.equal(r.qualified, false);
    assert.deepEqual(Object.keys(r.source).sort(), ['driver', 'product', 'tool']);
    await assert.rejects(runOwnedAttempt(o), /fresh-node-process-required/);
  }
});

for (const signalName of ['SIGINT','SIGTERM','SIGHUP']) test(`production browser adapter owns ${signalName} through repeated interruption and finalizes both cleanups`, async t => {
  const f = setup(t), dependencyRoot=join(f.root,'controlled-dependency'), pkg=join(dependencyRoot,'node_modules/@playwright/test');
  mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@playwright/test',main:'index.cjs'}));
  writeFileSync(join(pkg,'index.cjs'),'module.exports={chromium:{}};\n');
  const pw = createRequire(join(dependencyRoot,'mars/viewer/package.json'))('@playwright/test');
  const original = pw.chromium.launchPersistentContext;
  let closed = false, launchOptions;
  const page = { on() {}, goto: async () => {}, url: () => 'https://example.com:19040/w/proof-fixture',
    screenshot: async () => Buffer.from('PNG observation'), locator: () => ({ ariaSnapshot: async () => '- fixture' }) };
  // Exercise the real production adapter through the controlled library boundary, not an injected browser helper.
  pw.chromium.launchPersistentContext = async (_profile, options) => {
    launchOptions = options;
    assert.equal(options.handleSIGINT, false, 'Playwright must not exit the owner during SIGINT cleanup');
    assert.equal(options.handleSIGTERM, false); assert.equal(options.handleSIGHUP, false);
    return { pages: () => [page], close: async () => { assert.equal(process.emit(signalName),true,'owner still handles repeated signals during cleanup'); closed = true; } };
  };
  t.after(() => { pw.chromium.launchPersistentContext = original; });
  const cache = join(f.root, 'explicit-browser-cache'); mkdirSync(cache); const executable = join(cache, 'browser'); writeFileSync(executable, 'controlled launch boundary');
  Object.assign(f.o, { browserCache: cache, browserExecutable: executable, playwrightRoot: dependencyRoot,
    journeyTimeoutMs: 50, journey: async () => await new Promise(() => setTimeout(() => process.emit(signalName), 1)) });
  const runner = createTestRunner({ source: f.identity, changed: () => ['fix.ts'], portFree: async () => true,
    boot: async o => { const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); f.children.push(child); o.onSpawn(child);
      writeFileSync(o.log, 'owned fixture world\n'); return { child, base: page.url(), dataDir: o.data }; },
    stop: async c => { c.exitCode = 0; } });
  const report = await runner(f.o);
  assert.ok(launchOptions); assert.equal(report.status, 'INTERRUPTED'); assert.equal(report.qualified, false);
  assert.equal(closed, true); assert.equal(report.teardown.browserClosed, true); assert.equal(report.teardown.worldStopped, true);
  assert.ok(existsSync(join(report.paths.dir, 'report.json'))); assert.equal(f.ledger().cycles[0].inFlight, undefined);
  assert.equal(existsSync(f.o.ledger + '.lock'), false, 'finalized interruption releases its owned lock');
});


test('native-v2 monitors every child and retains death even after passing assertions', async t => {
  const children=[];
  const f=setup(t,{boot:async o=>{
    for(let i=0;i<4;i++){const c=Object.assign(new EventEmitter(),{pid:undefined,exitCode:null,signalCode:null});children.push(c);o.onSpawn(c);}
    return {child:children[0],children,base:`http://example.com:${o.port}`,dataDir:o.data};
  },stop:async c=>{if(c.exitCode===null)c.exitCode=0;}});
  f.o.world.kind='v2-account';f.o.journey=async c=>{children[2].exitCode=1;children[2].emit('exit',1);c.check('visible-assertion',true);};
  const report=await f.runner(f.o);assert.equal(report.status,'FAIL');assert.equal(report.qualified,false);
  assert.equal(report.teardown.children.length,4);assert(report.teardown.children.every(c=>c.exited));assert.equal(report.teardown.children[2].exitCode,1);
});

test('native-v2 partial boot stops every registered child before browser creation', async t => {
  const children=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<3;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});children.push(c);o.onSpawn(c);}
    throw Error('third native service never ready');
  }});f.o.world.kind='v2-account';const report=await f.runner(f.o);
  assert.equal(report.status,'BOOT_ABORT');assert.equal(report.browserStarted,false);assert.equal(report.teardown.children.length,3);
  assert(children.every(c=>c.exitCode===0));assert(!existsSync(f.o.ledger+'.lock'));
});

test('native-v2 incomplete cleanup retains ownership lock and per-child evidence', async t => {
  const children=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<4;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});children.push(c);o.onSpawn(c);}
    return {child:children[0],children,base:`http://example.com:${o.port}`,dataDir:o.data};
  },stop:async c=>{if(c===children[1])throw Error('owned child still live');c.exitCode=0;}});
  f.o.world.kind='v2-account';const report=await f.runner(f.o);assert.equal(report.status,'CLEANUP_FAIL');assert.equal(report.qualified,false);
  assert.equal(report.teardown.children.length,4);assert.equal(report.teardown.children[1].exited,false);assert(existsSync(f.o.ledger+'.lock'));
});

test('native-v2 fixed recipe rejects arbitrary kind and tampered/source-mismatched artifact receipts', async t => {
  const f=setup(t);await assert.rejects(f.runner({...f.o,world:{...f.o.world,kind:'existing-url'}}),/unknown-fixture-kind/);
  const file=join(f.product,'artifact.json');writeFileSync(file,'{}');assert.throws(()=>verifyAccountArtifacts(f.product,{file:'artifact.json',hash:'0'.repeat(64)}),/artifact-pin/);
  const git=(...args)=>execFileSync('git',['-C',f.product,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('add','fix.ts');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Create isolated artifact fixture');
  const body=JSON.stringify({schema:'v2-account-proof-artifacts/1',sourceHead:git('rev-parse','HEAD'),source:{'fix.ts':'0'.repeat(64)}});writeFileSync(file,body);
  assert.throws(()=>verifyAccountArtifacts(f.product,{file:'artifact.json',hash:createHash('sha256').update(body).digest('hex')}),/artifact-source/);
  assert.equal(f.children.length,0);
});


test('native-v2 keeps expected negative HTTP and unrelated network errors in failed evidence', async t => {
  const children=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<4;i++){const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});children.push(child);o.onSpawn(child);}
    return {child:children[0],children,base:`http://example.com:${o.port}`,dataDir:o.data};
  },browser:async(o,paths,base)=>{
    let url=base;const page=Object.assign(new EventEmitter(),{url:()=>url,screenshot:async()=>Buffer.from('PNG'),locator:()=>({ariaSnapshot:async()=>'- account'}),goto:async value=>{
      url=value;page.emit('response',{status:()=>503,url:()=>base+'/v1/auth/config'});
      page.emit('requestfailed',{method:()=>'GET',url:()=>base+'/assets/missing.js',failure:()=>({errorText:'connection lost'})});
    }});return {page,close:async()=>{}};
  }});f.o.world.kind='v2-account';f.o.journey=async c=>{c.expectHttp('/v1/auth/config',503,'explicit local test configuration');c.check('visible-control',true);};
  const report=await f.runner(f.o);assert.equal(report.status,'FAIL');assert.match(report.error,/unexpected-network-error/);
  const network=JSON.parse(readFileSync(join(report.paths.dir,'network.json')));assert.equal(network.length,2);assert.equal(network[0].expected,true);assert.equal(network[1].expected,false);assert.equal(report.qualified,false);
});


test('native-v2 console errors require exact owned-origin HTTP evidence and narrow browser text', async t => {
  const text='Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
  const sample=async({foreignResponse=false,foreignConsole=false,message=text}={})=>{
    const children=[];const f=setup(t,{boot:async o=>{
      for(let i=0;i<4;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});children.push(c);o.onSpawn(c);}
      return {child:children[0],children,base:`http://example.com:${o.port}`,dataDir:o.data};
    },browser:async(o,paths,base)=>{
      let url=base;const page=Object.assign(new EventEmitter(),{url:()=>url,screenshot:async()=>Buffer.from('PNG'),locator:()=>({ariaSnapshot:async()=>'- account'}),goto:async value=>{
        url=value;page.emit('response',{status:()=>503,url:()=>(foreignResponse?'https://other.example':base)+'/v1/auth/config'});
        page.emit('console',{type:()=>'error',text:()=>message,location:()=>({url:(foreignConsole?'https://other.example':base)+'/v1/auth/config',lineNumber:0,columnNumber:0})});
      }});return {page,close:async()=>{}};
    }});f.o.world.kind='v2-account';f.o.journey=async c=>{c.expectHttp('/v1/auth/config',503,'explicit loopback provider absence');c.check('observed-page',true);};return f.runner(f.o);
  };
  const expected=await sample();assert.equal(expected.status,'PASS');assert.equal(expected.qualified,false);
  const console=JSON.parse(readFileSync(join(expected.paths.dir,'console.json')));assert.equal(console[0].expected,true);assert.equal(console[0].location.lineNumber,0);
  const unrelated=await sample({message:'Unrelated application failure'});assert.equal(unrelated.status,'FAIL');assert.match(unrelated.error,/unexpected-console-error/);
  const otherOrigin=await sample({foreignResponse:true,foreignConsole:true});assert.equal(otherOrigin.status,'FAIL');assert.match(otherOrigin.error,/unexpected-network-error/);
  const unmatched=await sample({foreignConsole:true});assert.equal(unmatched.status,'FAIL');assert.match(unmatched.error,/unexpected-console-error/);
});

test('body recipe owns successful finite seed children and all three services without qualifying injection', async t => {
  const services=[];let seed;const f=setup(t,{boot:async o=>{
    seed=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});o.onSpawn(seed,{transient:true});seed.exitCode=0;seed.emit('exit',0);
    for(let i=0;i<3;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});services.push(c);o.onSpawn(c);}
    return {child:services[0],children:services,base:`http://example.com:${o.port}`,viewer:`http://example.com:${o.port}/?stream=/s/fixed/`,dataDir:o.data};
  }});f.o.world.kind='v2-bodies';const report=await f.runner(f.o);
  assert.equal(report.status,'PASS');assert.equal(report.qualified,false);assert.equal(report.injected,true);
  assert.equal(report.teardown.children.length,4);assert(report.teardown.children.every(c=>c.exited));assert.equal(seed.exitCode,0);
});

test('body recipe aborts abnormal finite child exit before opening the browser', async t => {
  const services=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<3;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});services.push(c);o.onSpawn(c);}
    const command=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});o.onSpawn(command,{transient:true});command.exitCode=1;command.emit('exit',1);
    return {child:services[0],children:services,base:`http://example.com:${o.port}`,viewer:`http://example.com:${o.port}/`,dataDir:o.data};
  }});f.o.world.kind='v2-bodies';const report=await f.runner(f.o);
  assert.equal(report.status,'BOOT_ABORT');assert.equal(report.browserStarted,false);assert.equal(report.teardown.children.length,4);assert(report.teardown.children.every(c=>c.exited));
});

test('body recipe service death remains fatal after finite child success', async t => {
  const services=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<3;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});services.push(c);o.onSpawn(c);}
    return {child:services[0],children:services,base:`http://example.com:${o.port}`,viewer:`http://example.com:${o.port}/`,dataDir:o.data};
  }});f.o.world.kind='v2-bodies';f.o.journey=async c=>{services[1].exitCode=0;services[1].emit('exit',0);c.check('observed',true);};
  const report=await f.runner(f.o);assert.equal(report.status,'FAIL');assert.equal(report.qualified,false);assert(report.teardown.children.every(c=>c.exited));
});

// Aborted requests: accepted only for a declared expected response's URL or when in flight at the driver's own goto/reload.
async function abortSample(t, journey) {
  const services=[];const f=setup(t,{boot:async o=>{
    for(let i=0;i<3;i++){const c=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});services.push(c);o.onSpawn(c);}
    return {child:services[0],children:services,base:`http://example.com:${o.port}`,viewer:`http://example.com:${o.port}/`,dataDir:o.data};
  },browser:async(o,paths,base)=>{
    let url=base;const page=Object.assign(new EventEmitter(),{url:()=>url,screenshot:async()=>Buffer.from('PNG'),locator:()=>({ariaSnapshot:async()=>'- bodies'}),goto:async value=>{url=value;},reload:async()=>{}});
    return {page,close:async()=>{}};
  }});f.o.world.kind='v2-bodies';
  f.o.journey=async c=>{const base=new URL(c.base).origin;const request=path=>({method:()=>'GET',url:()=>base+path,failure:()=>({errorText:'net::ERR_ABORTED'})});await journey({...c,base,request});c.check('observed',true);};
  const report=await f.runner(f.o);return {report,network:JSON.parse(readFileSync(join(report.paths.dir,'network.json')))};
}
test('an aborted GET of a declared expected response URL is expected', async t => {
  const {report,network}=await abortSample(t,async({page,request,expectHttp})=>{const r=request('/s/h/w/l/bundles/00000002/index');expectHttp('/s/h/w/l/bundles/00000002/index',404,'next day at the live edge');
    page.emit('request',r);page.emit('response',{status:()=>404,url:()=>r.url()});page.emit('requestfailed',r);});
  assert.equal(report.status,'PASS');assert.deepEqual(network.map(e=>e.expected),[true,true]);
});
test('an aborted GET in flight when the driver navigates is expected, for goto and for reload', async t => {
  for (const nav of ['goto','reload']) {
    const {report,network}=await abortSample(t,async({page,base,request})=>{const r=request('/assets/chunk.js');page.emit('request',r);await page[nav](base+'/');page.emit('requestfailed',r);});
    assert.equal(report.status,'PASS',nav);assert.equal(network[0].inFlightAtDriverNavigation,true);assert.equal(network[0].expected,true);
  }
});
test('an undeclared abort not in flight at a driver navigation still fails, as do other errors and other origins', async t => {
  const cases={
    'no-navigation':async({page,request})=>{const r=request('/assets/chunk.js');page.emit('request',r);page.emit('requestfailed',r);},
    'started-after-navigation':async({page,base,request})=>{await page.goto(base+'/');const r=request('/assets/chunk.js');page.emit('request',r);page.emit('requestfailed',r);},
    'other-error':async({page,base,request})=>{const r={...request('/assets/chunk.js'),failure:()=>({errorText:'net::ERR_CONNECTION_RESET'})};page.emit('request',r);await page.goto(base+'/');page.emit('requestfailed',r);},
    'other-origin':async({page,base})=>{const r={method:()=>'GET',url:()=>'https://other.example/a.js',failure:()=>({errorText:'net::ERR_ABORTED'})};page.emit('request',r);await page.goto(base+'/');page.emit('requestfailed',r);},
    'declared-path-without-expected-response':async({page,request,expectHttp})=>{expectHttp('/assets/chunk.js',404,'declared but never answered');const r=request('/assets/chunk.js');page.emit('request',r);page.emit('requestfailed',r);},
  };
  for (const [name,journey] of Object.entries(cases)) {
    const {report,network}=await abortSample(t,journey);
    assert.equal(report.status,'FAIL',name);assert.match(report.error,/unexpected-network-error/,name);assert.equal(network[0].expected,false,name);
  }
});

test('native customer page owns finite commands and service groups without qualifying injected proof', async t => {
  const services = []; let verified = false;
  const f = setup(t, { boot: async o => {
    const finite = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); o.onSpawn(finite, { transient: true, processGroup: true }); finite.exitCode = 0; finite.emit('exit', 0);
    for (let i = 0; i < 3; i++) { const c = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); services.push(c); o.onSpawn(c, { processGroup: true }); }
    return { child: services[0], children: services, base: `https://example.com:${o.port}`, viewer: `https://example.com:${o.port}/w/fixture/`, dataDir: o.data, recipe: { verify() { verified = true; } } };
  } });
  f.o.world.kind = 'native-page'; const report = await f.runner(f.o);
  assert.equal(report.status, 'PASS'); assert.equal(report.qualified, false); assert.equal(verified, true);
  assert.equal(report.teardown.children.length, 4); assert.ok(report.teardown.children.every(c => c.exited));
});
test('native customer-page partial startup closes registered services before a browser can exist', async t => {
  const f = setup(t, { boot: async o => {
    for (let i = 0; i < 2; i++) { const c = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }); o.onSpawn(c, { processGroup: true }); }
    throw Error('native-page startup failure');
  } });
  f.o.world.kind = 'native-page'; const report = await f.runner(f.o);
  assert.equal(report.status, 'BOOT_ABORT'); assert.equal(report.browserStarted, false);
  assert.equal(report.teardown.children.length, 2); assert.ok(report.teardown.children.every(c => c.exited)); assert.equal(report.qualified, false);
});

test('browser ownership and observation count survive calibration rejection, including failed close', async t => {
  for (const closeFails of [false, true]) {
    let closeCalls = 0;
    const f = setup(t, { browser: async o => {
      o.onOpened({ close: async () => { closeCalls++; if (closeFails) throw Error('context-close-failed'); } });
      throw Error('capture-calibration-failed');
    } });
    const report = await f.runner(f.o);
    assert.equal(report.status, closeFails ? 'CLEANUP_FAIL' : 'BOOT_ABORT');
    assert.equal(report.browserObservationStarted, true); assert.equal(report.browserStarted, false);
    assert.equal(report.captureOrdinal, 1); assert.equal(f.ledger().captures, 1); assert.equal(closeCalls, 1);
    assert.equal(report.teardown.browserClosed, closeFails ? undefined : true);
    assert.equal(report.teardown.worldStopped, true); assert.equal(report.qualified, false);
    if (closeFails) assert.match(report.teardown.browserError, /context-close-failed/);
  }
});

test('late onOpened then setup rejection closes the real context without rewriting frozen evidence', async t => {
  for (const closeFails of [false, true]) {
    const controller = new AbortController(); let onOpened, rejectSetup, closes = 0;
    const f = setup(t, { browser: async o => {
      onOpened = o.onOpened; setTimeout(() => controller.abort(Error('launch interrupted')), 1);
      return await new Promise((_, reject) => { rejectSetup = reject; });
    } });
    f.o.signal = controller.signal;
    const report = await f.runner(f.o);
    assert.equal(report.status, 'CLEANUP_FAIL'); assert.equal(report.teardown.browserClosed, false);
    const original = readFileSync(join(report.paths.dir, 'report.json')), ledger = readFileSync(f.o.ledger);
    onOpened({ close: async () => { closes++; if (closeFails) throw Error('late-close-failed'); } });
    rejectSetup(Error('calibration-aborted-after-open'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closes, 1); assert.deepEqual(readFileSync(join(report.paths.dir, 'report.json')), original);
    assert.deepEqual(readFileSync(f.o.ledger), ledger); assert.equal(report.browserObservationStarted, undefined);
    const evidence = JSON.parse(readFileSync(join(report.paths.dir, 'late-browser-cleanup.json')));
    assert.equal(evidence.browserOpenedAfterAbort, true); assert.equal(evidence.closed, !closeFails);
    assert.match(evidence.setupError, /calibration-aborted-after-open/);
    if (closeFails) assert.match(evidence.error, /late-close-failed/);
  }
});
test('a survey cycle may run its journey for up to 300 s; any other cycle keeps 90 s', async t => {
  const f = setup(t);
  await assert.rejects(f.runner({ ...f.o, journeyTimeoutMs: 90001 }), /timeout-out-of-bounds/);
  const survey = { ...f.o, cycle: { ...f.o.cycle, id: 'survey-long-build' } };
  await assert.rejects(f.runner({ ...survey, journeyTimeoutMs: 300001 }), /timeout-out-of-bounds/);
  const r = await f.runner({ ...survey, journeyTimeoutMs: 300000 }); assert.equal(r.status, 'PASS');
  assert.equal(journeyCap(survey), 300000); assert.equal(journeyCap(f.o), 90000); assert.equal(journeyCap({ cycle: { id: 'corrective-survey-' } }), 90000);
});
