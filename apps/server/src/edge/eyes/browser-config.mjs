// The worker's browser says who it is in its user agent, so the launcher's proxy does not count its long-lived viewer
// socket as somebody watching. Spoofing it only makes the spoofer's own visit count as passive, nothing else.
import {existsSync, readdirSync} from 'node:fs';
export const EYES_UA_TAG = 'EdenEyes/1';
export const isEyesAgent = ua => typeof ua === 'string' && ua.includes(EYES_UA_TAG);
/** Niceness of the worker and its browser (EDGE_EYES_NICE, 0..19, default 10): world ticks always win the CPU. */
export function eyesNice(env = process.env) {const n = Number(env.EDGE_EYES_NICE ?? 10); return Number.isInteger(n) && n >= 0 && n <= 19 ? n : 10;}
/** Extra Chromium switches (EDGE_EYES_CHROME_ARGS, space separated; only --switches), e.g. to shrink idle thread pools. */
export const eyesExtraArgs = (env = process.env) => String(env.EDGE_EYES_CHROME_ARGS ?? '').split(/\s+/).filter(a => a.startsWith('--'));
/** CPU list the worker and its browser are pinned to (EDGE_EYES_CPUS, taskset syntax like '0' or '0-1'; unset = no pinning). */
export function eyesCpus(env = process.env) {const c = String(env.EDGE_EYES_CPUS ?? '').trim(); return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(c) ? c : null;}
// Separate pure launch policy so CPU portability and the laptop's hardware-only boundary are testable without Chrome.
export function eyesWorkerProblem(platform = process.platform) {
  return platform === 'darwin' ? 'persistent Eyes service is disabled on the shared Mac; qualify captures on a remote CPU host' : null;
}
export function eyesBrowserModes(env = process.env, platform = process.platform) {
  const requested = env.EDGE_EYES_GPU || 'auto';
  if (!['auto', 'metal', 'gl', 'swiftshader'].includes(requested)) throw new Error('EDGE_EYES_GPU must be auto, metal, gl or swiftshader');
  // A persistent worker cannot hold the shared Mac's finite Chrome lease between captures.
  const problem = eyesWorkerProblem(platform); if (problem) throw new Error(problem);
  return requested === 'auto' ? ['swiftshader'] : [requested];
}
/** Exit code of a worker that found no Chromium at all: the server backs off long instead of retrying every 2 min. */
export const EYES_EXIT_NO_BROWSER = 3;
/** The Chromium the worker launches (#1340). `expected` is Playwright's own executable for this release
 *  (chromium.executablePath()). In order: EDGE_EYES_CHROME, an explicit executable; Playwright's expected one (path null:
 *  Playwright's default launch); else the newest other `chromium-<rev>` already installed beside it, so a release that
 *  bumps Playwright keeps Eyes working until the new revision is installed. Never downloads. No usable browser gives
 *  `problem`, with the one install command. */
export function eyesExecutable(expected, env = process.env, {exists = existsSync, list = (d) => readdirSync(d)} = {}) {
  // `note`/`problem` are public (/v1/edge/view/status, a Soul's EyesUnavailable): revisions and setting names only, never
  // a path. `log` carries the paths and the install command, for the worker's stderr and the operator's check tool.
  if (env.EDGE_EYES_CHROME) return exists(env.EDGE_EYES_CHROME) ? {path: env.EDGE_EYES_CHROME, source: 'EDGE_EYES_CHROME', note: 'an explicit Chromium', log: `EDGE_EYES_CHROME ${env.EDGE_EYES_CHROME}`}
    : {path: null, problem: 'no-browser: the explicit Chromium does not exist', log: `EDGE_EYES_CHROME ${env.EDGE_EYES_CHROME} does not exist`};
  if (!expected) return {path: null, problem: 'no-browser: Playwright names no Chromium', log: 'Playwright names no Chromium executable'};
  if (exists(expected)) return {path: null, source: 'playwright', note: "Playwright's own Chromium", log: `Playwright's ${expected}`};
  const m = /^(.*)[\\/]chromium-(\d+)([\\/].*)$/.exec(expected);
  if (!m) return {path: null, problem: 'no-browser: Playwright\'s Chromium is missing', log: `Playwright's Chromium is missing at ${expected}`};
  const [, dir, rev, rest] = m;
  const install = `install it: PLAYWRIGHT_BROWSERS_PATH=${dir} pnpm --filter mars-campus-viewer exec playwright install chromium (in the release, as the worlds' user)`;
  let names = []; try {names = list(dir);} catch {/* no browsers folder */}
  const revs = names.map((n) => /^chromium-(\d+)$/.exec(n)?.[1]).filter((r) => r && r !== rev).map(Number).sort((a, b) => b - a);
  for (const r of revs) for (const sub of [rest, rest.replace('chrome-linux64', 'chrome-linux'), rest.replace(/chrome-linux(?!64)/, 'chrome-linux64')]) {
    const p = `${dir}/chromium-${r}${sub}`;
    if (exists(p)) return {path: p, source: 'fallback', note: `fallback: expected chromium-${rev}, using chromium-${r}`, log: `Playwright expects ${expected}, which is not installed; using ${p} (${install})`};
  }
  return {path: null, problem: `no-browser: expected chromium-${rev}`, log: `no Chromium for Eyes: Playwright expects chromium-${rev} at ${expected}; ${install}`};
}
// Chrome (full, channel 'chromium') starts chrome_crashpad_handler, which needs a writable XDG config dir; under the
// world unit's ProtectHome=true $HOME is unreadable, so the handler exits ("--database is required") and the browser closes
// at launch. `home` is a worker-owned writable dir (under the unit's PrivateTmp) used as XDG_CONFIG_HOME/XDG_CACHE_HOME.
export function eyesBrowserLaunch(mode, env = process.env, platform = process.platform, home = null, executablePath = null) {
  const problem = eyesWorkerProblem(platform); if (problem) throw new Error(problem);
  const flags = {
    metal: ['--ignore-gpu-blocklist'],
    gl: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'],
    swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  };
  if (!flags[mode]) throw new Error('invalid Eyes renderer mode');
  // an explicit executable replaces the channel (Playwright takes one or the other)
  return {headless: true, ...(executablePath ? {executablePath} : env.EDGE_EYES_HEADLESS_SHELL === '1' ? {} : {channel: 'chromium'}),
    ...(home ? {env: {...env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home}} : {}),
    // Playwright adds --no-sandbox by default (chromiumSandbox: false); say it explicitly on Linux, where the unit's
    // NoNewPrivileges and no unprivileged user namespaces leave Chromium no usable sandbox.
    args: [...flags[mode], ...(platform === 'linux' ? ['--no-sandbox'] : []), '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      ...eyesExtraArgs(env)]};
}
