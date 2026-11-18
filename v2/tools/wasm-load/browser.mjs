// Loads replica's WASM build in a headless Chrome or Chromium from a local page and checks that load_probe returns
// the native value (K1, #2638). Usage: node browser.mjs <pkg dir> <input> <native value>
// The browser is $CHROME, else the first Chrome or Chromium found on PATH or in its usual macOS place.
// A browser that gives no result in time, or exits without one, is tried once more with a fresh profile; a page that
// reports an error or a different value fails at once. Each failed try logs the last request the page made.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [pkgDir, input, expected] = process.argv.slice(2);
if (!pkgDir || !input || !expected) throw new Error('usage: node browser.mjs <pkg dir> <input> <native value>');
const TIMEOUT_MS = 90_000;
const TRIES = 2;
const here = dirname(fileURLToPath(import.meta.url));

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('browser: no Chrome or Chromium found; set CHROME');
}

// The current try: its settle function and the requests its page has made, with the seconds since the try started.
let current = null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  current?.seen.push(`${url.pathname} at ${current.elapsed()} s`);
  if (url.pathname === '/result') {
    current?.settle(Object.fromEntries(url.searchParams));
    res.end();
    return;
  }
  // Only two kinds of file are served: the page, and files directly in the package directory.
  const file = url.pathname === '/' ? join(here, 'index.html')
    : url.pathname.startsWith('/pkg/') ? join(pkgDir, basename(url.pathname)) : null;
  if (!file || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const executable = findBrowser();

// One try in a fresh profile. Resolves to { value } or { error }, with retry set when the browser itself stalled or
// died rather than the page reporting something.
async function attempt(n) {
  const started = Date.now();
  let settle;
  const result = new Promise((resolve) => (settle = resolve));
  current = { settle, seen: [], elapsed: () => ((Date.now() - started) / 1000).toFixed(1) };
  const { seen } = current;

  const profile = mkdtempSync(join(tmpdir(), 'v2-wasm-load-'));
  const args = ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];
  // Hosted Ubuntu runners forbid the unprivileged user namespaces Chrome's sandbox needs; the page is our own.
  if (process.platform === 'linux') args.push('--no-sandbox');
  // Its own process group, so that the whole browser (renderer, GPU and helper processes) can be stopped together.
  const browser = spawn(executable, [...args, `http://127.0.0.1:${server.address().port}/?input=${input}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  browser.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  const exited = new Promise((resolve) => browser.once('exit', (code, signal) => resolve(signal ?? code)));
  browser.on('error', (error) => settle({ error: `could not start: ${error.message}`, retry: true }));
  exited.then((how) => settle({ error: `the browser exited (${how}) before a result`, retry: true }));
  const timer = setTimeout(() => settle({ error: `no result in ${TIMEOUT_MS / 1000} s`, retry: true }), TIMEOUT_MS);

  const outcome = await result;
  clearTimeout(timer);
  current = null;
  if (browser.pid !== undefined && browser.exitCode === null && browser.signalCode === null) {
    try {
      process.kill(process.platform === 'win32' ? browser.pid : -browser.pid, 'SIGKILL');
    } catch {
      browser.kill('SIGKILL');
    }
    await exited;
  }
  // Helper processes may still be letting go of the profile; a profile left in the temp dir fails nothing.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) =>
    console.warn(`browser: try ${n}: could not remove the profile (${error.code ?? error.message}); left in place`));

  const took = ((Date.now() - started) / 1000).toFixed(1);
  if (outcome.error) {
    console.error(`browser: try ${n}: ${outcome.error} (after ${took} s)`);
    console.error(`browser: try ${n}: the page's requests: ${seen.length ? seen.join(', ') : 'none (the page never loaded)'}`);
    const tail = outcome.retry ? stderr.trim().split('\n').slice(-10).join('\n') : '';
    if (tail) console.error(`browser: try ${n}: the browser's last stderr lines:\n${tail}`);
  } else {
    console.log(`browser: try ${n}: result after ${took} s`);
  }
  return outcome;
}

let outcome;
for (let n = 1; n <= TRIES; n++) {
  outcome = await attempt(n);
  if (!outcome.retry) break;
}
server.closeAllConnections();
server.close();

if (outcome.error) {
  console.error(`browser: ${outcome.error}`);
  process.exit(1);
}
console.log(`browser: load_probe(${input}) = ${outcome.value} (native ${expected})`);
if (outcome.value !== expected) {
  console.error('browser: the WASM build returned a different value from the native build');
  process.exit(1);
}
