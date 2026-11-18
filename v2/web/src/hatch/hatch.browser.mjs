// The code hatch in a page (Engine v2 F8, #2823): replica's WASM build in a headless Chrome or Chromium runs the
// world's 1,000 chess-move cases, at the kit's budget and over it, and must give the world's table byte for byte (same
// verdicts, same counted steps, the same named refusal). Needs v2/tools/ci.sh's WASM build (target/wasm-load/pkg) and
// the cases the world's test wrote (target/tmp/hatch). The browser is $CHROME, else Chrome or Chromium on PATH or in
// its usual macOS place. Run: node v2/web/src/hatch/hatch.browser.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../../../target/', import.meta.url));
const pkg = `${target}wasm-load/pkg/`;
const doc = readFileSync(`${target}tmp/hatch/run.json`, 'utf8');
const want = readFileSync(`${target}tmp/hatch/native.txt`, 'utf8');

function browser() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      if (existsSync(join(dir, n))) return join(dir, n);
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('no Chrome or Chromium found; set CHROME');
}

// The page: loads the build, runs the document, and posts the table back.
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import init, { hatch_run_cases } from '/pkg/replica.js';
let body;
try {
  await init();
  body = hatch_run_cases(await (await fetch('/run.json')).text());
} catch (e) { body = 'error ' + e; }
await fetch('/result', { method: 'POST', body });
</script>`;

let settle;
const result = new Promise((resolve) => (settle = resolve));
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => (res.end(), settle(body)));
    return;
  }
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (path === '/run.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(doc);
  const file = path.startsWith('/pkg/') ? join(pkg, basename(path)) : null;
  if (!file || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const profile = mkdtempSync(join(tmpdir(), 'v2-hatch-'));
const args = ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];
if (process.platform === 'linux') args.push('--no-sandbox');
const chrome = spawn(browser(), [...args, `http://127.0.0.1:${server.address().port}/`], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
});
chrome.on('exit', (how) => settle(`error the browser exited (${how}) before a result`));
const timer = setTimeout(() => settle('error no result in 90 s'), 90_000);
const got = await result;
clearTimeout(timer);
try {
  process.kill(process.platform === 'win32' ? chrome.pid : -chrome.pid);
} catch {}
server.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 3 });

const rows = got.trim().split('\n').map((l) => l.split(' '));
const yes = rows.filter((w) => w[0] === '20000' && w[2] === '1').length;
const over = rows.filter((w) => w[2] === 'refused' && w[3] === 'hatch-over-budget').length;
const table = createHash('sha256').update(got).digest('hex').slice(0, 16);
console.log(`page (WASM in ${basename(browser())}): ${rows.length} rows, ${yes} yes, ${over} hatch-over-budget, table ${table}`);
if (got !== want) {
  console.error(`the page's table differs from the world's: ${got.slice(0, 200)}`);
  process.exit(1);
}
