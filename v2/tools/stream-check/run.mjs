// The live stream check (Engine v2 V1, #2710): runs `stream-check world` for <seconds> in real time, serves its files
// over HTTP, and has a headless Chrome play the stream from one address (index.html), then scans the parts for words.
// Checks A1 (every tenth part's state hash equal to the writer's), A2 (every part written was played, none refused,
// in order), A3 (median delay behind the world between 1.5 and 2.5 s) and A5 (`stream-check scan`).
// Usage, from v2/: node tools/stream-check/run.mjs <pkg dir> <stream-check binary> <work dir> <seconds> <even|uneven>
// Prints one `result {...}` JSON line; exits 1 when a check fails.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [pkgDir, bin, work, seconds, arm] = process.argv.slice(2);
if (!arm) throw new Error('usage: node run.mjs <pkg dir> <stream-check binary> <work dir> <seconds> <even|uneven>');
const here = dirname(fileURLToPath(import.meta.url));
const www = resolve(work, 'www');
rmSync(www, { recursive: true, force: true });

function findBrowser() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('run: no Chrome or Chromium found; set CHROME');
}

// What the page has reported, summed.
const seen = { played: 0, next: 0, hashes: 0, hashEqual: 0, delays: [], arrivals: [], bytes: 0, retries: 0, errors: [] };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      Object.assign(seen, { played: r.played, next: r.next, hashes: r.hashes, hashEqual: r.hashEqual, bytes: r.bytes, retries: r.retries, errors: r.errors });
      seen.delays.push(...r.delays);
      seen.arrivals.push(...r.arrivals);
      res.end();
    });
    return;
  }
  let file = null;
  if (url.pathname === '/') file = join(here, 'index.html');
  else if (url.pathname.startsWith('/pkg/')) file = join(pkgDir, basename(url.pathname));
  else if (url.pathname.startsWith('/s/')) {
    const f = normalize(join(www, decodeURIComponent(url.pathname.slice(3))));
    if (f.startsWith(www)) file = f;
  }
  if (!file || !existsSync(file)) {
    // A miss is never cached (V2 serves the same way).
    res.writeHead(404, { 'cache-control': 'no-store' }).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

const world = spawn(bin, ['world', work, seconds, arm], { stdio: ['ignore', 'pipe', 'inherit'] });
let streamDir;
let done;
const lines = createInterface({ input: world.stdout });
const started = new Promise((ok) => lines.on('line', (l) => {
  if (l.startsWith('stream ')) ok((streamDir = l.slice(7)));
  if (l.startsWith('done ')) {
    const [parts, entries, sizes] = l.slice(5).split(' ');
    done = { parts: Number(parts), entries: Number(entries), sizes: sizes ? sizes.split(',').map(Number) : [] };
  }
}));
const worldExit = new Promise((ok) => world.once('exit', ok));
await started;

const profile = mkdtempSync(join(tmpdir(), 'v2-stream-check-'));
const args = ['--headless', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
if (process.platform === 'linux') args.push('--no-sandbox');
const address = `http://127.0.0.1:${server.address().port}/?stream=/s/${streamDir}/`;
const browser = spawn(findBrowser(), [...args, address], { stdio: 'ignore', detached: process.platform !== 'win32' });

const code = await worldExit;
if (code !== 0 || !done) throw new Error(`run: the world exited with ${code}`);
// The page plays two seconds behind; give it up to 20 s to reach the last part.
for (let i = 0; i < 100 && seen.played < done.parts; i++) await new Promise((ok) => setTimeout(ok, 200));
await new Promise((ok) => setTimeout(ok, 2500));
try { process.kill(-browser.pid, 'SIGKILL'); } catch { browser.kill('SIGKILL'); }
server.closeAllConnections();
server.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

const scan = execFileSync(bin, ['scan', work], { encoding: 'utf8' }).trim();
const sorted = (a) => [...a].sort((x, y) => x - y);
const q = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
const tenths = Math.floor(done.parts / 10);
const result = {
  arm, seconds: Number(seconds), parts: done.parts, entries: done.entries, played: seen.played,
  hashes: seen.hashes, hashEqual: seen.hashEqual, expectedHashes: tenths, errors: seen.errors, notYetThere: seen.retries,
  delayMs: { p50: q(seen.delays, 0.5), p10: q(seen.delays, 0.1), p90: q(seen.delays, 0.9), max: q(seen.delays, 1) },
  arrivalMs: { p50: q(seen.arrivals, 0.5), p90: q(seen.arrivals, 0.9), max: q(seen.arrivals, 1) },
  bytesPerPart: { mean: Math.round(done.sizes.reduce((a, b) => a + b, 0) / done.sizes.length), p50: q(done.sizes, 0.5), max: q(done.sizes, 1) },
  bytesFetched: seen.bytes, scan,
};
result.a1 = seen.hashes === tenths && seen.hashEqual === tenths;
result.a2 = seen.played === done.parts && seen.errors.length === 0;
result.a3 = result.delayMs.p50 !== null && result.delayMs.p50 >= 1500 && result.delayMs.p50 <= 2500;
result.a5 = /, 0 of \d+ lines said found/.test(scan);
console.log(`result ${JSON.stringify(result)}`);
process.exit(result.a1 && result.a2 && result.a3 && result.a5 ? 0 : 1);
