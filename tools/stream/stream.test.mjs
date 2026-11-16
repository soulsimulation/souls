import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseArgs, parseEnvFile, findProfileDir, chooseScreen, OUTPUT_GRACE_MS, loadSecrets, redact, log, obsAuth, pickWindow, captureTransform, streamUrl, watchDecision,
  STALL_MS, RELOAD_EVERY_MS, PROFILE_PARAMS, STREAM_ENCODER, CHROME_FLAGS,
} from './stream.mjs';

test('parseArgs takes start <url> [--record], status, stop and watch', () => {
  assert.deepEqual(parseArgs(['start', 'https://soul.game/w/eden/', '--record']), { cmd: 'start', url: 'https://soul.game/w/eden/', record: true });
  assert.equal(parseArgs(['status']).cmd, 'status');
  assert.throws(() => parseArgs(['start']), /usage/);
  assert.throws(() => parseArgs(['start', 'eden']), /usage/);
  assert.throws(() => parseArgs(['start', 'https://x/', '--live']), /unknown option/);
  assert.throws(() => parseArgs(['go']), /usage/);
});

test('streamUrl adds ?stream=1 and keeps the rest of the URL', () => {
  assert.equal(streamUrl('https://soul.game/w/eden/'), 'https://soul.game/w/eden/?stream=1');
  assert.equal(streamUrl('https://soul.game/w/eden/?a=b#watch'), 'https://soul.game/w/eden/?a=b&stream=1#watch');
});

test('secrets: environment wins over the file; a file inside the repo is refused; values are redacted', () => {
  const root = mkdtempSync(join(tmpdir(), 'stream-test-'));
  const outside = join(root, 'stream.env');
  writeFileSync(outside, '# comment\nexport OBS_WEBSOCKET_PASSWORD="pw-from-file"\nX_STREAM_SERVER=rtmps://example.invalid/x\nX_STREAM_KEY=key-123\n');
  const s = loadSecrets({ environ: { OBS_WEBSOCKET_PASSWORD: 'pw-from-env' }, file: outside, repoRoot: join(root, 'repo') });
  assert.deepEqual(s, { obsPassword: 'pw-from-env', server: 'rtmps://example.invalid/x', key: 'key-123' });
  assert.equal(redact('server rtmps://example.invalid/x key key-123 pw pw-from-env'), 'server *** key *** pw ***');

  mkdirSync(join(root, 'repo', 'tools'), { recursive: true });
  const inside = join(root, 'repo', 'tools', 'stream.env');
  writeFileSync(inside, 'X_STREAM_KEY=k\n');
  assert.throws(() => loadSecrets({ environ: {}, file: inside, repoRoot: join(root, 'repo') }), /inside the repository/);
  assert.deepEqual(loadSecrets({ environ: {}, file: join(root, 'missing.env'), repoRoot: null }), { obsPassword: '', server: '', key: '' });
  assert.deepEqual(parseEnvFile("A='x y'\n#B=1\n"), { A: 'x y' });
});

test('log never prints a loaded secret', (t) => {
  loadSecrets({ environ: { X_STREAM_KEY: 'live_abc_secret' }, file: '/nonexistent', repoRoot: null });
  const lines = [];
  t.mock.method(console, 'log', (l) => lines.push(l));
  log('starting with live_abc_secret');
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT.*Z starting with \*\*\*$/);
});

test('obsAuth follows the obs-websocket 5 recipe', () => {
  const sha = (s) => createHash('sha256').update(s).digest('base64');
  assert.equal(obsAuth('pw', 'salt', 'chal'), sha(sha('pwsalt') + 'chal'));
});

test('pickWindow takes the window whose title carries the marker, never a look-alike', () => {
  const items = [{ itemName: '[Google Chrome] Eden · Souls', itemValue: 1 }, { itemName: '[Google Chrome] souls-stream-ab12cd', itemValue: 7 }];
  assert.equal(pickWindow(items, 'souls-stream-ab12cd').itemValue, 7);
  assert.equal(pickWindow(items, 'souls-stream-ffffff'), null);
});

test('captureTransform crops the title bar and fills 1920x1080', () => {
  const t = captureTransform(1920, 1136, 960, 540); // 2x page, 2x capture
  assert.equal(t.cropTop, 56);
  assert.equal(t.boundsWidth, 1920);
  assert.equal(t.boundsHeight, 1080);
  assert.equal(captureTransform(3840, 2100, 1920, 1018).cropTop, 64); // 1x page captured at 2x
  assert.equal(captureTransform(1920, 1080, 1920, 1080).cropTop, 0);
});

test('watchdog: reload after 10 s without new frames, again only after another 10 s', () => {
  const w = { lastFrames: undefined, lastProgressAt: 0, lastReloadAt: 0 };
  assert.deepEqual(watchDecision(w, { now: 1000, frames: 10, outputActive: true }), []);
  assert.deepEqual(watchDecision(w, { now: 5000, frames: 50, outputActive: true }), []);
  assert.deepEqual(watchDecision(w, { now: 5000 + STALL_MS - 1, frames: 50, outputActive: true }), []);
  const a = watchDecision(w, { now: 5000 + STALL_MS, frames: 50, outputActive: true });
  assert.equal(a.length, 1);
  assert.equal(a[0].do, 'reload');
  assert.match(a[0].why, /stalled for 10 s/);
  assert.deepEqual(watchDecision(w, { now: 5000 + STALL_MS + 2000, frames: undefined, outputActive: true }), []);
  assert.equal(watchDecision(w, { now: 5000 + 2 * STALL_MS, frames: undefined, outputActive: true })[0]?.do, 'reload');
});

test('watchdog: a page that cannot be read counts as stalled', () => {
  const w = { lastFrames: undefined, lastProgressAt: 0, lastReloadAt: 0 };
  assert.equal(watchDecision(w, { now: STALL_MS, frames: undefined, outputActive: true })[0]?.do, 'reload');
});

test('watchdog: scheduled reload every 4 h even when frames flow', () => {
  const w = { lastFrames: undefined, lastProgressAt: 0, lastReloadAt: 0 };
  let frames = 0, reloads = [];
  for (let now = 0; now <= RELOAD_EVERY_MS * 2; now += 60_000) {
    for (const a of watchDecision(w, { now, frames: ++frames, outputActive: true })) reloads.push([now, a.why]);
  }
  assert.deepEqual(reloads, [[RELOAD_EVERY_MS, 'scheduled (every 4 h)'], [2 * RELOAD_EVERY_MS, 'scheduled (every 4 h)']]);
});

test('chooseScreen picks the sharpest screen with room for 1920x1080 pixels', () => {
  const ext = { left: 0, top: 25, w: 1920, h: 1055, dpr: 1 }, mac = { left: -1512, top: 0, w: 1512, h: 945, dpr: 2 };
  assert.equal(chooseScreen([ext, mac]), mac);
  assert.equal(chooseScreen([ext]), null); // 1x and too short for 1080 under a title bar
  assert.equal(chooseScreen([]), null);
});

test('watchdog: restart the output when it stays stopped for 5 s, not while OBS reconnects or is unreachable', () => {
  const w = { lastFrames: undefined, lastProgressAt: 0, lastReloadAt: 0 };
  assert.deepEqual(watchDecision(w, { now: 1, frames: 1, outputActive: false }), []);
  assert.deepEqual(watchDecision(w, { now: 1 + OUTPUT_GRACE_MS, frames: 1.5, outputActive: false }).map((a) => a.do), ['restart-output']);
  assert.deepEqual(watchDecision(w, { now: 2, frames: 2, outputActive: true, outputReconnecting: true }), []);
  assert.deepEqual(watchDecision(w, { now: 3, frames: 3, outputActive: false, outputReconnecting: true }), []);
  assert.deepEqual(watchDecision(w, { now: 4, frames: 4, outputActive: undefined }), []);
});

test('the OBS and Chrome settings match the acceptance', () => {
  const p = Object.fromEntries(PROFILE_PARAMS.map(([c, n, v]) => [`${c}.${n}`, v]));
  assert.equal(p['AdvOut.Encoder'], 'com.apple.videotoolbox.videoencoder.ave.avc');
  assert.equal(p['AdvOut.Track1Bitrate'], '128');
  assert.equal(p['Audio.SampleRate'], '48000');
  assert.deepEqual(STREAM_ENCODER, { rate_control: 'CBR', bitrate: 8000, keyint_sec: 3, profile: 'high' });
  for (const f of ['--autoplay-policy=no-user-gesture-required', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) assert.ok(CHROME_FLAGS.includes(f));
});

test('findProfileDir finds an OBS profile by its Name= line, whatever its folder is called', () => {
  const root = mkdtempSync(join(tmpdir(), 'obs-profiles-'));
  for (const [dir, name] of [['Untitled', 'Untitled'], ['soulsstream', 'souls-stream']]) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, 'basic.ini'), `[General]\nName=${name}\n\n[Output]\nMode=Simple\n`);
  }
  assert.equal(findProfileDir(root, 'souls-stream'), join(root, 'soulsstream'));
  assert.equal(findProfileDir(root, 'souls'), null);
  assert.equal(findProfileDir(join(root, 'missing'), 'souls-stream'), null);
});
