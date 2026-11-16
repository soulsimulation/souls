#!/usr/bin/env node
// Stream one Souls world to X from code, on the stream machine (a Mac running OBS 33 and Chrome).
//
//   node tools/stream/stream.mjs start <world-url> [--record]   open Chrome, set up OBS, start the output, start the watchdog
//   node tools/stream/stream.mjs status                         output state, fps, frames, bitrate, audio, page frame rate
//   node tools/stream/stream.mjs stop                           end the output, close Chrome, give OBS back its own profile
//   node tools/stream/stream.mjs watch                          the watchdog itself (start runs it in the background)
//
// Dependency-free (Node 22: global WebSocket and fetch), so the file can be copied to the stream machine and run there.
// Secrets come from the environment or a file outside the repo and are never printed. Docs: docs/operations/streaming.md.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'souls-stream'; // OBS profile and scene collection; reused, never recreated (OBS cannot delete them over the websocket)
export const WINDOW_INPUT = 'souls-window';
export const AUDIO_INPUT = 'souls-audio';
export const WIDTH = 1920, HEIGHT = 1080, FPS = 30;
export const CSS_WIDTH = 960, CSS_HEIGHT = 540; // a 2x screen turns this into 1920x1080 pixels
export const STALL_MS = 10_000; // page frames stuck this long: reload
export const RELOAD_EVERY_MS = 4 * 3600_000;
export const OUTPUT_GRACE_MS = 5000;
export const CHROME_FLAGS = [
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
];
// Encoder: Apple's hardware H.264 at about 8 Mbps CBR, a keyframe every 3 s; AAC 128 kbps at 48 kHz.
export const PROFILE_PARAMS = [
  ['Output', 'Mode', 'Advanced'],
  ['AdvOut', 'Encoder', 'com.apple.videotoolbox.videoencoder.ave.avc'],
  ['AdvOut', 'ApplyServiceSettings', 'false'],
  ['AdvOut', 'Rescale', 'false'],
  ['AdvOut', 'TrackIndex', '1'],
  ['AdvOut', 'Track1Bitrate', '128'],
  ['AdvOut', 'AudioEncoder', 'CoreAudio_AAC'],
  ['AdvOut', 'RecType', 'Standard'],
  ['AdvOut', 'RecEncoder', 'none'], // the recording reuses the stream encoder, so a --record test checks the stream settings
  ['AdvOut', 'RecAudioEncoder', 'CoreAudio_AAC'],
  ['AdvOut', 'RecFormat2', 'mkv'],
  ['AdvOut', 'RecTracks', '1'],
  ['Audio', 'SampleRate', '48000'],
];
export const STREAM_ENCODER = { rate_control: 'CBR', bitrate: 8000, keyint_sec: 3, profile: 'high' };

const env = process.env;
const stateDir = () => resolve(env.SOULS_STREAM_DIR ?? join(homedir(), '.souls', 'stream'));
const statePath = () => join(stateDir(), 'state.json');
const cdpPort = () => Number(env.SOULS_STREAM_CDP_PORT ?? 9333);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- secrets: environment first, then a KEY=value file outside the repo; values never reach a log
const secretValues = new Set();
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
export function repoRootOf(file) {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}
export function loadSecrets({ environ = env, file = environ.SOULS_STREAM_SECRETS ?? join(homedir(), '.souls', 'stream.env'), repoRoot = repoRootOf(fileURLToPath(import.meta.url)) } = {}) {
  let fromFile = {};
  if (existsSync(file)) {
    const real = realpathSync(file);
    const root = repoRoot && existsSync(repoRoot) ? realpathSync(repoRoot) : null;
    if (root && (real === root || real.startsWith(root + sep))) throw new Error('the secrets file is inside the repository; move it outside (see docs/operations/streaming.md)');
    fromFile = parseEnvFile(readFileSync(real, 'utf8'));
  }
  const pick = (k) => environ[k] || fromFile[k] || '';
  const s = { obsPassword: pick('OBS_WEBSOCKET_PASSWORD'), server: pick('X_STREAM_SERVER'), key: pick('X_STREAM_KEY') };
  for (const v of Object.values(s)) if (v) secretValues.add(v);
  return s;
}
export function redact(text) {
  let t = String(text);
  for (const v of secretValues) t = t.split(v).join('***');
  return t;
}
export const log = (msg) => console.log(redact(`${new Date().toISOString()} ${msg}`));

// ---------- obs-websocket 5
export const obsAuth = (password, salt, challenge) => {
  const sha = (s) => createHash('sha256').update(s).digest('base64');
  return sha(sha(password + salt) + challenge);
};
export async function connectObs({ password, url = env.OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455', events = 0, timeoutMs = 5000 } = {}) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const handlers = new Set();
  let n = 0, closed = false;
  const identified = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('OBS websocket did not answer')), timeoutMs);
    ws.onerror = () => { clearTimeout(t); rej(new Error('OBS websocket unreachable')); };
    ws.onclose = (ev) => {
      closed = true; clearTimeout(t);
      rej(new Error(ev.code === 4009 ? 'OBS websocket refused the password' : `OBS websocket closed (${ev.code})`));
      for (const p of pending.values()) p({ requestStatus: { result: false, code: -1, comment: 'connection closed' } });
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.op === 0) {
        const a = m.d.authentication;
        if (a && !password) { clearTimeout(t); rej(new Error('OBS websocket needs a password: set OBS_WEBSOCKET_PASSWORD')); ws.close(); return; }
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: events, ...(a ? { authentication: obsAuth(password, a.salt, a.challenge) } : {}) } }));
      } else if (m.op === 2) { clearTimeout(t); res(); }
      else if (m.op === 7) { pending.get(m.d.requestId)?.(m.d); pending.delete(m.d.requestId); }
      else if (m.op === 5) for (const h of handlers) h(m.d.eventType, m.d.eventData ?? {});
    };
  });
  await identified;
  const raw = (requestType, requestData = {}, ms = 15000) => new Promise((res) => {
    if (closed) return res({ requestStatus: { result: false, code: -1, comment: 'connection closed' } });
    const requestId = String(++n);
    const t = setTimeout(() => { pending.delete(requestId); res({ requestStatus: { result: false, code: -2, comment: 'timed out' } }); }, ms);
    pending.set(requestId, (d) => { clearTimeout(t); res(d); });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  });
  const call = async (type, data) => {
    const r = await raw(type, data);
    if (!r.requestStatus.result) throw new Error(`OBS ${type} failed: ${r.requestStatus.code} ${r.requestStatus.comment ?? ''}`.trim());
    return r.responseData ?? {};
  };
  return { raw, call, on: (h) => handlers.add(h), close: () => ws.close(), get closed() { return closed; } };
}
// OBS freezes for about 30 s after launch and answers 207 (not ready) until it is done.
async function obsWhenReady(password, { events = 0, launch = false } = {}) {
  let launched = false;
  for (let i = 0; i < 60; i++) {
    let obs;
    try { obs = await connectObs({ password, events }); } catch (e) {
      if (/password/.test(e.message)) throw e;
      if (launch && !launched && process.platform === 'darwin') {
        log('OBS is not answering; launching it');
        execFileSync('open', ['-a', 'OBS', '--args', '--disable-shutdown-check']);
        launched = true;
      }
      await wait(2000); continue;
    }
    const r = await obs.raw('GetSceneCollectionList');
    if (r.requestStatus.result) return obs;
    obs.close(); await wait(2000);
  }
  throw new Error('OBS did not become ready in 2 minutes');
}

// ---------- Chrome DevTools protocol (localhost only)
export async function cdpPage(port = cdpPort()) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('the stream Chrome has no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let n = 0, closed = false;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot attach to the stream Chrome')); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
  ws.onclose = () => { closed = true; for (const p of pending.values()) p({ error: { message: 'closed' } }); pending.clear(); };
  const send = (method, params = {}, ms = 5000) => new Promise((res) => {
    const id = ++n;
    const t = setTimeout(() => { pending.delete(id); res({ error: { message: 'timed out' } }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    try { ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(t); res({ error: { message: 'closed' } }); }
  });
  const evaluate = async (expression, ms = 3000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
    return r.error || r.result?.exceptionDetails ? undefined : r.result?.result?.value;
  };
  return { page, send, evaluate, close: () => ws.close(), get closed() { return closed; } };
}
async function cdpReady(port, ms = 30000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(500)) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return true; } catch {}
  }
  return false;
}
async function closeChrome(port) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await wait(1000); ws.close();
    return true;
  } catch { return false; }
}
// The page's own counter (#2492) when it has one, else a requestAnimationFrame counter this tool adds over CDP.
export const FRAMES_EXPR = `(() => { const s = window.__soulsStream; if (s && typeof s.frames === 'number') return { frames: s.frames, source: 'page' };
  if (!window.__soulsStreamProbe) { window.__soulsStreamProbe = { frames: 0 }; const f = () => { window.__soulsStreamProbe.frames++; requestAnimationFrame(f); }; requestAnimationFrame(f); }
  return { frames: window.__soulsStreamProbe.frames, source: 'probe' }; })()`;

export function streamUrl(worldUrl) {
  const u = new URL(worldUrl);
  u.searchParams.set('stream', '1');
  return u.toString();
}

// ---------- pure helpers (tested)
export function pickWindow(items, marker) {
  return items.find((w) => w.itemName?.includes(marker)) ?? null;
}
// Crop whatever sits above the page (the title bar) and fit the page to the canvas. OBS may capture the window at a
// different scale than the page renders at, so the scale comes from the widths (the page spans the window's width).
export function captureTransform(sourceWidth, sourceHeight, pageWidth, pageHeight) {
  const cropTop = Math.max(0, Math.round(sourceHeight - pageHeight * (sourceWidth / pageWidth)));
  return { cropTop, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: WIDTH, boundsHeight: HEIGHT, positionX: 0, positionY: 0, alignment: 5 };
}
// The screen to put the window on: one where a page of 1920x1080 device pixels fits under a title bar, sharpest first.
export function chooseScreen(screens) {
  const fits = screens.filter((s) => s.w * s.dpr >= WIDTH && (s.h - 40) * s.dpr >= HEIGHT);
  return fits.sort((a, b) => b.dpr - a.dpr)[0] ?? null;
}
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const pos = rest.filter((a) => !a.startsWith('--'));
  for (const f of flags) if (f !== '--record') throw new Error(`unknown option ${f}`);
  if (!['start', 'status', 'stop', 'watch'].includes(cmd)) throw new Error('usage: stream.mjs start <world-url> [--record] | status | stop | watch');
  if (cmd === 'start' && (pos.length !== 1 || !/^https?:\/\//.test(pos[0]))) throw new Error('usage: stream.mjs start <world-url> [--record]');
  return { cmd, url: pos[0], record: flags.has('--record') };
}
// One watchdog step: what to do, given what was seen. `w` is the watchdog's memory, updated in place.
export function watchDecision(w, { now, frames, outputActive, outputReconnecting }) {
  const actions = [];
  if (frames !== undefined && frames !== w.lastFrames) { w.lastFrames = frames; w.lastProgressAt = now; }
  if (now - w.lastReloadAt >= RELOAD_EVERY_MS) actions.push({ do: 'reload', why: 'scheduled (every 4 h)' });
  else if (now - Math.max(w.lastProgressAt, w.lastReloadAt) >= STALL_MS) actions.push({ do: 'reload', why: `page frames stalled for ${Math.round((now - w.lastProgressAt) / 1000)} s` });
  // An output that is down (not reconnecting by itself) for OUTPUT_GRACE_MS gets restarted; one bad read does nothing.
  if (outputActive === false && !outputReconnecting) {
    w.outputDownSince ??= now;
    if (now - w.outputDownSince >= OUTPUT_GRACE_MS) { actions.push({ do: 'restart-output', why: 'output stopped or disconnected' }); w.outputDownSince = undefined; }
  } else if (outputActive !== undefined) w.outputDownSince = undefined;
  for (const a of actions) if (a.do === 'reload') w.lastReloadAt = now;
  return actions;
}

// ---------- state
const readState = () => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : null);
const writeState = (s) => { mkdirSync(stateDir(), { recursive: true }); writeFileSync(statePath(), JSON.stringify(s, null, 2) + '\n'); };
const obsProfilesDir = () => env.OBS_PROFILES_DIR ?? join(homedir(), 'Library', 'Application Support', 'obs-studio', 'basic', 'profiles');
// OBS names a profile's folder after the profile with some characters dropped ("souls-stream" lives in "soulsstream"),
// so find it by the Name= line in its basic.ini.
export function findProfileDir(root, name) {
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const ini = join(root, d, 'basic.ini');
    if (existsSync(ini) && readFileSync(ini, 'utf8').split(/\r?\n/).some((l) => l.trim() === `Name=${name}`)) return join(root, d);
  }
  return null;
}
const outputCalls = (record) => (record
  ? { status: 'GetRecordStatus', start: 'StartRecord', stop: 'StopRecord', label: 'recording' }
  : { status: 'GetStreamStatus', start: 'StartStream', stop: 'StopStream', label: 'stream' });

async function switchTo(obs, kind, name) {
  const [list, set, cur] = kind === 'profile'
    ? ['GetProfileList', 'SetCurrentProfile', (r) => r.currentProfileName]
    : ['GetSceneCollectionList', 'SetCurrentSceneCollection', (r) => r.currentSceneCollectionName];
  // OBS can sit on a switch for a while (just after an output stops, or while loading a big collection): retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cur((await obs.raw(list)).responseData ?? {}) === name) return;
    await obs.raw(set, kind === 'profile' ? { profileName: name } : { sceneCollectionName: name });
    for (let i = 0; i < 20; i++) { if (cur((await obs.raw(list)).responseData ?? {}) === name) return; await wait(500); }
  }
  throw new Error(`OBS did not switch ${kind} to ${name}`);
}

// ---------- commands
async function start({ url, record }) {
  const secrets = loadSecrets();
  if (!record && !(secrets.server && secrets.key)) throw new Error('streaming needs X_STREAM_SERVER and X_STREAM_KEY (environment or secrets file); use --record to test without them');
  if (readState()) throw new Error('a stream is already set up here; run `stop` first');
  const port = cdpPort();
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });

  // 1. Chrome: its own profile, an app window on the stream URL, no throttling when covered or in the background.
  if (await closeChrome(port)) { log('closed a stream Chrome left from before'); await wait(1500); }
  const target = streamUrl(url);
  execFileSync('open', ['-na', 'Google Chrome', '--args', `--user-data-dir=${join(dir, 'chrome')}`, `--app=${target}`,
    `--window-size=${CSS_WIDTH},${CSS_HEIGHT}`, '--window-position=40,40', `--remote-debugging-port=${port}`, ...CHROME_FLAGS]);
  if (!(await cdpReady(port))) throw new Error('the stream Chrome did not open its debugging port');
  writeState({ url, target, record, port, user: null, startedAt: new Date().toISOString() });
  log(`chrome open on ${target}`);
  const page = await cdpPage(port);
  const loaded = `location.origin === ${JSON.stringify(new URL(target).origin)} && document.readyState === 'complete'`;
  for (let i = 0; i < 60 && !(await page.evaluate(loaded)); i++) await wait(500);
  // Make the page area exactly 1920x1080 device pixels (960x540 CSS on a 2x screen): grow the window by whatever the
  // title bar takes.
  const { windowId } = (await page.send('Browser.getWindowForTarget')).result ?? {};
  await page.send('Browser.grantPermissions', { origin: new URL(target).origin, permissions: ['windowManagement'] });
  let screens = [];
  for (let i = 0; i < 3 && !screens.length; i++, await wait(500)) screens = (await page.evaluate(`getScreenDetails().then((d) => d.screens.map((s) => ({ left: s.availLeft, top: s.availTop, w: s.availWidth, h: s.availHeight, dpr: s.devicePixelRatio })))`, 5000)) ?? [];
  const screen = chooseScreen(screens);
  if (screen && windowId) {
    await page.send('Browser.setWindowBounds', { windowId, bounds: { left: screen.left + 20, top: screen.top + 20 } });
    await wait(1000);
  } else log(`warning: no screen fits a page of ${WIDTH}x${HEIGHT} device pixels (${screens.length} screens seen); the picture will be scaled`);
  for (let i = 0; i < 3 && windowId; i++) {
    const vp = await page.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
    const want = vp && { w: Math.round(WIDTH / vp.dpr), h: Math.round(HEIGHT / vp.dpr) };
    if (!vp || (vp.w === want.w && vp.h === want.h)) break;
    const { bounds } = (await page.send('Browser.getWindowBounds', { windowId })).result;
    await page.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + want.w - vp.w, height: bounds.height + want.h - vp.h } });
    await wait(500);
  }
  const vp = await page.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
  log(`page ${vp.w}x${vp.h} css at ${vp.dpr}x = ${vp.w * vp.dpr}x${vp.h * vp.dpr} pixels`);

  // 2. OBS: wait until it answers, remember the user's own profile and collection, switch to ours.
  const obs = await obsWhenReady(secrets.obsPassword, { launch: true });
  const profiles = await obs.call('GetProfileList');
  const colls = await obs.call('GetSceneCollectionList');
  const user = { profile: profiles.currentProfileName, collection: colls.currentSceneCollectionName };
  if (user.profile === NAME || user.collection === NAME) throw new Error(`OBS is already on ${NAME}; switch it back to your own profile and collection first`);
  writeState({ ...readState(), user });
  log(`obs ready; your profile "${user.profile}" and collection "${user.collection}" come back on stop`);

  if (!profiles.profiles.includes(NAME)) await obs.call('CreateProfile', { profileName: NAME });
  await switchTo(obs, 'profile', NAME);
  for (const [parameterCategory, parameterName, parameterValue] of PROFILE_PARAMS) await obs.call('SetProfileParameter', { parameterCategory, parameterName, parameterValue });
  if (env.SOULS_STREAM_RECORD_DIR) await obs.call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFilePath', parameterValue: env.SOULS_STREAM_RECORD_DIR });
  await obs.call('SetVideoSettings', { baseWidth: WIDTH, baseHeight: HEIGHT, outputWidth: WIDTH, outputHeight: HEIGHT, fpsNumerator: FPS, fpsDenominator: 1 });
  // Encoder settings live in the profile's streamEncoder.json (there is no websocket request for them); OBS reads it
  // when the profile is activated, so write it and switch away and back.
  const profileDir = findProfileDir(obsProfilesDir(), NAME);
  if (!profileDir) throw new Error(`OBS profile folder not found (set OBS_PROFILES_DIR)`);
  writeFileSync(join(profileDir, 'streamEncoder.json'), JSON.stringify(STREAM_ENCODER));
  await switchTo(obs, 'profile', user.profile);
  await switchTo(obs, 'profile', NAME);
  if (!record) {
    await obs.call('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: secrets.server, key: secrets.key, use_auth: false } });
  }
  log('obs profile set: 1920x1080 at 30 fps, hardware H.264 8 Mbps CBR, keyframe 3 s, AAC 128 kbps 48 kHz');

  if (!colls.sceneCollections.includes(NAME)) await obs.call('CreateSceneCollection', { sceneCollectionName: NAME });
  await switchTo(obs, 'collection', NAME);
  await wait(1000);
  const scene = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
  for (const it of (await obs.call('GetSceneItemList', { sceneName: scene })).sceneItems ?? []) await obs.raw('RemoveSceneItem', { sceneName: scene, sceneItemId: it.sceneItemId });
  for (const name of [WINDOW_INPUT, AUDIO_INPUT]) await obs.raw('RemoveInput', { inputName: name });
  await wait(500);
  for (const i of (await obs.call('GetInputList')).inputs ?? []) await obs.raw('SetInputMute', { inputName: i.inputName, inputMuted: true }); // no room mic or desktop audio

  // 3. Window capture of that Chrome window. Listing windows is safe; listing apps for audio crashes OBS 33, so audio is set by bundle id.
  const vid = await obs.call('CreateInput', { sceneName: scene, inputName: WINDOW_INPUT, inputKind: 'screen_capture', inputSettings: { type: 1, show_cursor: false } });
  let win = null;
  for (let i = 0; i < 5 && !win; i++) {
    const marker = `souls-stream-${randomBytes(3).toString('hex')}`;
    await page.evaluate(`document.title = ${JSON.stringify(marker)}`);
    await wait(1000);
    const items = (await obs.call('GetInputPropertiesListPropertyItems', { inputName: WINDOW_INPUT, propertyName: 'window' })).propertyItems ?? [];
    win = pickWindow(items, marker);
  }
  if (!win) throw new Error('could not find the stream Chrome window in OBS (is screen recording allowed for OBS?)');
  await obs.call('SetInputSettings', { inputName: WINDOW_INPUT, inputSettings: { type: 1, window: win.itemValue, show_cursor: false } });
  let tr = {};
  for (let i = 0; i < 20 && !(tr.sourceHeight > 0); i++) { await wait(500); tr = (await obs.call('GetSceneItemTransform', { sceneName: scene, sceneItemId: vid.sceneItemId })).sceneItemTransform; }
  const t = captureTransform(tr.sourceWidth, tr.sourceHeight, vp.w, vp.h);
  await obs.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: vid.sceneItemId, sceneItemTransform: t });
  log(`window capture ${tr.sourceWidth}x${tr.sourceHeight}, title bar cropped ${t.cropTop} px, scaled to ${WIDTH}x${HEIGHT}`);
  await obs.call('CreateInput', { sceneName: scene, inputName: AUDIO_INPUT, inputKind: 'sck_audio_capture', inputSettings: { type: 1, application: 'com.google.Chrome' } });
  await obs.raw('SetInputMute', { inputName: AUDIO_INPUT, inputMuted: false });
  page.close();

  // 4. Start the output, then the watchdog in the background.
  const oc = outputCalls(record);
  await obs.call(oc.start);
  log(`${oc.label} started`);
  obs.close();
  const logPath = join(dir, 'watch.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch'], { detached: true, stdio: ['ignore', fd, fd], env });
  child.unref();
  writeState({ ...readState(), watchPid: child.pid });
  log(`watchdog running (pid ${child.pid}); its log is ${logPath}`);
}

async function status() {
  const s = readState();
  if (!s) { console.log('no stream set up here'); return; }
  const secrets = loadSecrets();
  const obs = await connectObs({ password: secrets.obsPassword, events: 1 << 16 }); // InputVolumeMeters
  let peak = 0, samples = 0;
  obs.on((type, d) => {
    if (type !== 'InputVolumeMeters') return;
    for (const i of d.inputs) if (i.inputName === AUDIO_INPUT) { samples++; for (const c of i.inputLevelsMul) peak = Math.max(peak, c[1] ?? 0); }
  });
  const oc = outputCalls(s.record);
  let page = null;
  try { page = await cdpPage(s.port); } catch {}
  const o0 = await obs.call(oc.status);
  const f0 = page && (await page.evaluate(FRAMES_EXPR));
  const t0 = Date.now();
  await wait(3000);
  const o1 = await obs.call(oc.status);
  const f1 = page && (await page.evaluate(FRAMES_EXPR));
  const dt = (Date.now() - t0) / 1000;
  const st = await obs.call('GetStats');
  const kbps = o1.outputActive ? Math.round(((o1.outputBytes - o0.outputBytes) * 8) / dt / 1000) : 0;
  const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) + ' dBFS peak' : samples ? 'silent' : 'no meter data';
  const pageRate = f0 && f1 ? `${((f1.frames - f0.frames) / dt).toFixed(1)} frames/s (${f1.source === 'page' ? '__soulsStream.frames' : 'rAF probe; page has no __soulsStream'})` : 'page not reachable';
  const lines = [
    `${oc.label}: ${o1.outputActive ? (o1.outputReconnecting ? 'reconnecting' : 'active') : 'stopped'}  elapsed ${o1.outputTimecode ?? '-'}  world ${s.url}`,
    `obs fps ${st.activeFps?.toFixed(1)}  render skipped ${st.renderSkippedFrames}/${st.renderTotalFrames}  encoder skipped ${st.outputSkippedFrames}/${st.outputTotalFrames}` +
      (s.record ? '' : `  dropped ${o1.outputSkippedFrames}/${o1.outputTotalFrames}  congestion ${(o1.outputCongestion ?? 0).toFixed(2)}`),
    `bitrate ${kbps} kbps  audio ${db}  cpu ${st.cpuUsage?.toFixed(1)}%`,
    `page ${pageRate}`,
  ];
  console.log(redact(lines.join('\n')));
  page?.close(); obs.close();
}

async function stop() {
  const s = readState();
  if (!s) { console.log('no stream set up here'); return; }
  if (s.watchPid) { try { process.kill(s.watchPid, 'SIGTERM'); log(`watchdog ${s.watchPid} stopped`); } catch {} }
  const secrets = loadSecrets();
  const obs = await obsWhenReady(secrets.obsPassword);
  const oc = outputCalls(s.record);
  const r = await obs.raw(oc.stop);
  if (r.responseData?.outputPath) log(`recording saved to ${r.responseData.outputPath}`);
  for (let i = 0; i < 40 && (await obs.call(oc.status)).outputActive; i++) await wait(500);
  await wait(1000);
  log(`${oc.label} stopped`);
  if (await closeChrome(s.port)) log('chrome closed');
  if (s.user) {
    await switchTo(obs, 'collection', s.user.collection);
    await switchTo(obs, 'profile', s.user.profile);
    log(`obs back on profile "${s.user.profile}" and collection "${s.user.collection}"`);
  }
  obs.close();
  rmSync(statePath());
}

// The watchdog: reload the page when its frames stall for 10 s and every 4 h; restart the output if it stops.
async function watch() {
  const s = readState();
  if (!s) throw new Error('no stream set up here');
  const secrets = loadSecrets();
  const oc = outputCalls(s.record);
  const w = { lastFrames: undefined, lastProgressAt: Date.now(), lastReloadAt: Date.now() };
  let obs = null, page = null, warnedProbe = false, stopping = false;
  process.on('SIGTERM', () => { stopping = true; log('watchdog: stop requested'); page?.close(); obs?.close(); process.exit(0); });
  log(`watchdog: watching ${s.target}`);
  while (!stopping) {
    if (!obs || obs.closed) { try { obs = await connectObs({ password: secrets.obsPassword }); log('watchdog: connected to obs'); } catch (e) { obs = null; log(`watchdog: obs not reachable (${e.message})`); } }
    if (page?.closed) { page = null; log('watchdog: lost the chrome page; reattaching'); }
    if (!page) { try { page = await cdpPage(s.port); await page.send('Page.enable'); } catch { page = null; log('watchdog: chrome not reachable'); } }
    const f = page ? await page.evaluate(FRAMES_EXPR) : undefined;
    if (f?.source === 'probe' && !warnedProbe) { warnedProbe = true; log('watchdog: warning: the page has no __soulsStream counter; using a requestAnimationFrame probe instead'); }
    let out;
    if (obs) { const r = await obs.raw(oc.status); out = r.requestStatus.result ? r.responseData : undefined; }
    const actions = watchDecision(w, { now: Date.now(), frames: f?.frames, outputActive: out?.outputActive, outputReconnecting: out?.outputReconnecting });
    for (const a of actions) {
      if (a.do === 'reload' && page) {
        log(`watchdog: reload page: ${a.why}`);
        const r = await page.send('Page.reload', { ignoreCache: false });
        if (r.error) { log(`watchdog: reload over CDP failed (${r.error.message}); navigating instead`); page.close(); page = null; try { page = await cdpPage(s.port); await page.send('Page.navigate', { url: s.target }); } catch { page = null; } }
        w.lastFrames = undefined;
      } else if (a.do === 'restart-output' && obs) {
        log(`watchdog: restart ${oc.label}: ${a.why}`);
        const r = await obs.raw(oc.start);
        log(r.requestStatus.result ? `watchdog: ${oc.label} restarted` : `watchdog: restart failed: ${r.requestStatus.code} ${r.requestStatus.comment ?? ''}`);
      }
    }
    await wait(2000);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const run = { start, status, stop, watch }[args.cmd];
  run(args).catch((e) => { console.error(redact(`${new Date().toISOString()} error: ${e.message}`)); process.exit(1); });
}
