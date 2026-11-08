import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eyesBrowserLaunch, eyesBrowserModes, eyesWorkerProblem, EYES_UA_TAG, isEyesAgent, eyesNice, eyesCpus, eyesExtraArgs, eyesExecutable, EYES_EXIT_NO_BROWSER} from './edge/eyes/browser-config.mjs';
import {EyesWorker} from './edge/eyes/worker.ts';

test('CPU Eyes defaults directly to SwiftShader on Linux, with one persistent Chromium worker', () => {
  assert.deepEqual(eyesBrowserModes({}, 'linux'), ['swiftshader']);
  assert.deepEqual(eyesBrowserModes({EDGE_EYES_GPU: 'auto'}, 'linux'), ['swiftshader']);
  const launch = eyesBrowserLaunch('swiftshader', {}, 'linux');
  assert.equal(launch.channel, 'chromium');
  assert.ok(launch.args.includes('--use-angle=swiftshader'));
  assert.ok(launch.args.includes('--enable-unsafe-swiftshader'));
  assert.throws(() => eyesBrowserModes({EDGE_EYES_GPU: 'typo'}, 'linux'), /EDGE_EYES_GPU/);
});
test('persistent service refuses the shared Mac before taking a Chrome lease or launching a browser', () => {
  assert.equal(eyesWorkerProblem('linux'),null);
  assert.match(eyesWorkerProblem('darwin')!,/disabled on the shared Mac/);
  for (const mode of ['auto','metal','swiftshader', 'gl']) assert.throws(() => eyesBrowserModes({EDGE_EYES_GPU: mode}, 'darwin'), /disabled on the shared Mac/);
  assert.throws(()=>eyesBrowserLaunch('metal',{},'darwin'),/disabled on the shared Mac/);
});

test('the Eyes worker is marked by its user agent and runs at a low priority', () => {
  assert.equal(EYES_UA_TAG, 'EdenEyes/1');
  assert.equal(isEyesAgent('Mozilla/5.0 HeadlessChrome EdenEyes/1'), true);
  assert.equal(isEyesAgent('Mozilla/5.0'), false); assert.equal(isEyesAgent(undefined), false);
  assert.equal(eyesNice({}), 10); assert.equal(eyesNice({EDGE_EYES_NICE: '0'}), 0); assert.equal(eyesNice({EDGE_EYES_NICE: '19'}), 19);
  assert.equal(eyesNice({EDGE_EYES_NICE: '25'}), 10); assert.equal(eyesNice({EDGE_EYES_NICE: 'x'}), 10);
});

test('optional CPU pinning and extra Chromium switches are validated, never passed through raw', () => {
  assert.equal(eyesCpus({}), null);
  assert.equal(eyesCpus({EDGE_EYES_CPUS: '0-1'}), '0-1');
  assert.equal(eyesCpus({EDGE_EYES_CPUS: '0,2-3'}), '0,2-3');
  assert.equal(eyesCpus({EDGE_EYES_CPUS: '0; rm -rf /'}), null);
  assert.deepEqual(eyesExtraArgs({EDGE_EYES_CHROME_ARGS: ' --num-raster-threads=1  junk --renderer-process-limit=1 '}), ['--num-raster-threads=1', '--renderer-process-limit=1']);
  assert.deepEqual(eyesBrowserLaunch('swiftshader', {EDGE_EYES_CHROME_ARGS: '--num-raster-threads=1'}, 'linux').args.at(-1), '--num-raster-threads=1');
});

test('Linux launch runs without the Chromium sandbox and gives Chrome a writable XDG home (unit hides $HOME)', () => {
  const launch = eyesBrowserLaunch('swiftshader', {PATH: '/usr/bin', HOME: '/home/simworlds'}, 'linux', '/tmp/eden-eyes-x');
  assert.ok(launch.args.includes('--no-sandbox'));
  assert.equal(launch.env?.XDG_CONFIG_HOME, '/tmp/eden-eyes-x');
  assert.equal(launch.env?.XDG_CACHE_HOME, '/tmp/eden-eyes-x');
  assert.equal(launch.env?.PATH, '/usr/bin');
  assert.equal(eyesBrowserLaunch('swiftshader', {}, 'linux').env, undefined);
  assert.ok(!eyesBrowserLaunch('gl', {}, 'win32').args.includes('--no-sandbox'));
});

// #1340: a release bumped Playwright (1.63 -> 1.64.1 expects chromium-1248); the host had only the older revision installed
const B = '/srv/eyes/ms-playwright', WANT = `${B}/chromium-1248/chrome-linux64/chrome`;
const io = (files: string[]) => ({exists: (p: string) => files.includes(p), list: (d: string) => {if (d !== B) throw new Error('ENOENT'); return [...new Set(files.filter(f => f.startsWith(B + '/')).map(f => f.slice(B.length + 1).split('/')[0]))];}});

test('#1340 Eyes launches Playwright\'s own Chromium when it is installed, an explicit one when set', () => {
  assert.deepEqual(eyesExecutable(WANT, {}, io([WANT])), {path: null, source: 'playwright', note: "Playwright's own Chromium", log: `Playwright's ${WANT}`});
  const own = eyesExecutable(WANT, {EDGE_EYES_CHROME: '/opt/chrome/chrome'}, io([WANT, '/opt/chrome/chrome']));
  assert.equal(own.path, '/opt/chrome/chrome'); assert.equal(own.source, 'EDGE_EYES_CHROME'); assert.equal(own.note, 'an explicit Chromium');
  assert.match(eyesExecutable(WANT, {EDGE_EYES_CHROME: '/nope'}, io([WANT])).problem!, /^no-browser: the explicit Chromium does not exist$/);
  assert.match(eyesExecutable(WANT, {EDGE_EYES_CHROME: '/nope'}, io([WANT])).log, /EDGE_EYES_CHROME \/nope does not exist/);
});

test('#1340 when the release expects a revision that is not installed, Eyes uses the newest installed one, and says so', () => {
  const r = eyesExecutable(WANT, {}, io([`${B}/chromium-1187/chrome-linux/chrome`, `${B}/chromium-1194/chrome-linux64/chrome`, `${B}/chromium_headless_shell-1194/x`, `${B}/ffmpeg-1011/ffmpeg`]));
  assert.equal(r.path, `${B}/chromium-1194/chrome-linux64/chrome`); assert.equal(r.source, 'fallback');
  assert.match(r.note!, /^fallback: expected chromium-1248, using chromium-1194$/);
  assert.equal(eyesExecutable(WANT, {}, io([`${B}/chromium-1187/chrome-linux/chrome`])).path, `${B}/chromium-1187/chrome-linux/chrome`, 'older layout');
  const none = eyesExecutable(WANT, {}, io([`${B}/ffmpeg-1011/ffmpeg`]));
  assert.equal(none.path, null); assert.match(none.log, /Playwright expects chromium-1248 at .*; install it: PLAYWRIGHT_BROWSERS_PATH=\/srv\/eyes\/ms-playwright pnpm --filter mars-campus-viewer exec playwright install chromium/);
  assert.match(none.problem!, /^no-browser: expected chromium-1248$/);
  assert.match(eyesExecutable(WANT, {}, {exists: () => false, list: () => {throw new Error('ENOENT');}}).problem!, /^no-browser: expected chromium-1248$/);
  // an explicit executable replaces Playwright's channel
  const launch = eyesBrowserLaunch('swiftshader', {}, 'linux', null, r.path);
  assert.equal(launch.executablePath, r.path); assert.equal(launch.channel, undefined);
});

test('#1340 a worker with no browser keeps its reason and is retried after the long backoff, not every 2 minutes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eyes-nobrowser-')), script = join(dir, 'w.mjs'), starts = join(dir, 'starts');
  writeFileSync(script, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(starts)}, 'x'); process.send({t: 'status', ready: false, renderer: null, detail: 'no-browser: expected chromium-1248'}); setTimeout(() => process.exit(${EYES_EXIT_NO_BROWSER}), 50);`);
  const w = new EyesWorker({viewerUrl: 'http://127.0.0.1:9/w/eden/', script, noBrowserBackoffMs: 60_000});
  try {
    await new Promise(r => setTimeout(r, 6500));
    const st = w.status();
    assert.equal(st.state, 'down');
    assert.match(st.detail!, /^no browser \(retry in 1 min\): no-browser: expected chromium-1248/);
    const {readFileSync} = await import('node:fs');
    assert.equal(readFileSync(starts, 'utf8').length, 1, 'one start, then the long wait (the ordinary backoff would retry after 5 s)');
  } finally {w.close();}
});

test('#1340 what reaches the public status (note, problem) never names a path or the install command', () => {
  const cases = [eyesExecutable(WANT, {}, io([WANT])), eyesExecutable(WANT, {}, io([`${B}/chromium-1194/chrome-linux64/chrome`])), eyesExecutable(WANT, {}, io([])),
    eyesExecutable(WANT, {EDGE_EYES_CHROME: '/opt/c/chrome'}, io(['/opt/c/chrome'])), eyesExecutable(WANT, {EDGE_EYES_CHROME: '/opt/c/chrome'}, io([])), eyesExecutable('/no-rev/chrome', {}, io([])), eyesExecutable(null, {}, io([]))];
  for (const c of cases) for (const k of ['note', 'problem'] as const) if (c[k]) { assert.doesNotMatch(c[k]!, /\//, `${k}: ${c[k]}`); assert.doesNotMatch(c[k]!, /PLAYWRIGHT_BROWSERS_PATH|install it/, `${k}: ${c[k]}`); }
});
