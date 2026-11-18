// Loads replica's WASM build in a headless Chrome or Chromium from a local page and checks that load_probe returns
// the native value (K1, #2638). Usage: node browser.mjs <pkg dir> <input> <native value>
// The browser is $CHROME, else the first Chrome or Chromium found on PATH or in its usual macOS place.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [pkgDir, input, expected] = process.argv.slice(2);
if (!pkgDir || !input || !expected) throw new Error('usage: node browser.mjs <pkg dir> <input> <native value>');
const TIMEOUT_MS = 30_000;
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
let settle;
const result = new Promise((resolve) => (settle = resolve));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/result') {
    settle(Object.fromEntries(url.searchParams));
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

const profile = mkdtempSync(join(tmpdir(), 'v2-wasm-load-'));
const args = ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];
// Hosted Ubuntu runners forbid the unprivileged user namespaces Chrome's sandbox needs; the page is our own.
if (process.platform === 'linux') args.push('--no-sandbox');
const browser = spawn(findBrowser(), [...args, `http://127.0.0.1:${server.address().port}/?input=${input}`], {
  stdio: 'ignore',
});
browser.on('error', (error) => settle({ error: `browser: could not start: ${error.message}` }));
const timer = setTimeout(() => settle({ error: `browser: no result in ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS);

const outcome = await result;
clearTimeout(timer);
browser.kill();
server.close();
const running = browser.pid !== undefined && browser.exitCode === null && browser.signalCode === null;
if (running) await new Promise((resolve) => browser.once('exit', resolve));
rmSync(profile, { recursive: true, force: true });

if (outcome.error) {
  console.error(`browser: ${outcome.error}`);
  process.exit(1);
}
console.log(`browser: load_probe(${input}) = ${outcome.value} (native ${expected})`);
if (outcome.value !== expected) {
  console.error('browser: the WASM build returned a different value from the native build');
  process.exit(1);
}
