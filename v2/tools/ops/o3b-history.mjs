// The rewind page plays a moment a running world archived (Engine v2 O3b, #3458, A3), end to end on a local store
// stand-in: `worldd serve --store <folder>` archives its history under `h/<world>/<lineage>/` in the folder (O9's
// folder store), and the page (V9's history, `v2/web/src/history`) opens a link to a moment there, served by vite with
// `V2_STREAM_DIR` set to the folder. Checks that the page seeks to the moment and draws it: the state hash it reports
// and the bodies drawn. Run from `v2/`, after `npm ci --prefix web` and the WASM build (`tools/ci.sh` makes both):
//
//   O3B_KEEP=1 cargo test -p worldd --test serve o3b -- --nocapture   # prints "A3: history ... world W lineage L at T"
//   node tools/ops/o3b-history.mjs <store folder> <world> <lineage> <at µs> [screenshot.png]
//
// Playwright comes from the repo's install (`pnpm install`; `PLAYWRIGHT_ROOT` names another checkout that has one).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [store, world, lineage, at, shot] = process.argv.slice(2);
if (!store || !world || !lineage || !at) {
  console.error('usage: node tools/ops/o3b-history.mjs <store folder> <world> <lineage> <at µs> [screenshot.png]');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const repo = resolve(v2, '..');

const platform = await import(pathToFileURL(join(repo, 'tools/playtest/lib/platform.mjs')).href);
platform.browsersPath();
const pw = platform.resolvePlaywright({ serverRoot: process.env.PLAYWRIGHT_ROOT ?? repo });
if (!pw) throw new Error('Playwright not found: run `pnpm install --frozen-lockfile`, or set PLAYWRIGHT_ROOT');

// The page, served by vite with the store folder under /s/.
const vite = spawn(process.execPath, [join(v2, 'web/node_modules/vite/bin/vite.js'), '--port', '0', '--host', '127.0.0.1'], {
  cwd: join(v2, 'web'),
  env: { ...process.env, V2_STREAM_DIR: resolve(store) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const origin = await new Promise((ok, fail) => {
  let out = '';
  const timer = setTimeout(() => fail(new Error(`vite: no address in 60 s: ${out}`)), 60_000);
  vite.stdout.on('data', (b) => {
    out += b;
    const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(/http:\/\/127\.0\.0\.1:\d+/);
    if (m) clearTimeout(timer), ok(m[0]);
  });
  vite.once('exit', (code) => fail(new Error(`vite exited (${code}): ${out}`)));
});

let code = 1;
const browser = await pw.chromium.launch({ headless: true, args: platform.launchArgs({ gpu: 'swiftshader' }).args });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error(`page: ${e.message}`));
  const link = `${origin}/#w=${encodeURIComponent(world)}&l=${encodeURIComponent(lineage)}&t=${at}`;
  console.log(`open ${link.replace(origin, '<page>')}`);
  await page.goto(link);
  await page.waitForFunction(() => globalThis.v2?.history?.opened?.hash, null, { timeout: 60_000 });
  // A few frames, so the moment is drawn.
  await page.waitForTimeout(3_000);
  const got = await page.evaluate(() => ({
    opened: globalThis.v2.history.opened,
    status: document.getElementById('status')?.textContent ?? '',
  }));
  const drawn = Number(got.status.match(/bodies drawn\s+(\d+)/)?.[1] ?? 0);
  console.log(`moment ${at}: state hash ${got.opened.hash}, ready in ${Math.round(got.opened.readyMs ?? 0)} ms, ` +
    `${got.opened.bytes} bytes fetched, ${drawn} bodies drawn`);
  console.log(got.status.trim());
  if (shot) await page.screenshot({ path: shot });
  code = drawn > 0 ? 0 : 1;
  if (code) console.error('o3b-history: the moment drew no body');
} finally {
  await browser.close();
  vite.kill();
}
process.exit(code);
