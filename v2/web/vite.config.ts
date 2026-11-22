// Engine v2's page (V5, #2714). Carried over from apps/web/vite.config.ts by copying the parts that apply (a relative
// base, an ES worker, a modern target); nothing is imported from today's app.
//
// - `replica` is the WASM build v2/tools/ci.sh makes (`wasm-bindgen --target web` into v2/target/wasm-load/pkg);
//   `V2_REPLICA_PKG` points elsewhere. Vite copies its .wasm file into the build as an asset.
// - `V2_STREAM_DIR`, in `vite` (dev) and `vite preview`, serves a stream writer's folder (stream-check's `www`) under
//   /s/, uncached, as V2 will serve it. The page plays the stream named by its `stream` parameter, e.g.
//   /?stream=/s/<lineage>/<zone>/<epoch>/<node>/<level>/<audience>/
// - `V2_DIRECTORY`, in `vite` and `vite preview`, passes /v1/ to directoryd at that origin (W3's list of worlds, at
//   /src/worlds/).
// - `V2_GATEWAY`, in `vite` and `vite preview`, passes /v2/ (the socket and the creator's session exchange) to gatewayd
//   at that origin (W5's creator's panel, at /src/panel/).
// - The changelog (O23, #3324): changelog.html is the repo's CHANGELOG.md rendered at build time
//   (src/changelog/page.ts, carried from apps/web), and changelog.md is its Markdown twin; the origin serves both
//   (v2/tools/origin/site.mjs). `V2_CHANGELOG_FILE` names another copy: the release builds the page from CHANGELOG.md
//   with the shipping release's section compiled in (tools/changelog/compile.mjs --out), so the page shows it.
// - Kinds (#3871): each content kind's state fields and looks, as `assets/kinds/<namespace>/<name>.json`, for the things the
//   page draws from their kind's entry (kind-entries.ts).
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { bodyAssets } from './body-assets.ts';
import { kindEntries } from './kind-entries.ts';
import { changelogHtml } from './src/changelog/page.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = resolve(here, process.env.V2_REPLICA_PKG ?? '../target/wasm-load/pkg');

function streamFiles(): Plugin {
  const root = process.env.V2_STREAM_DIR ? resolve(process.env.V2_STREAM_DIR) : null;
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    if (!root || !req.url?.startsWith('/s/')) return next();
    const file = normalize(resolve(root, decodeURIComponent(req.url.slice(3).split('?')[0])));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'cache-control': 'no-store' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  };
  return {
    name: 'v2-stream-files',
    configureServer: (s) => void s.middlewares.use(serve),
    configurePreviewServer: (s) => void s.middlewares.use(serve),
  };
}

function changelogPage(): Plugin {
  const file = resolve(here, process.env.V2_CHANGELOG_FILE ?? '../../CHANGELOG.md');
  const journal = resolve(here, '../../tools/changelog/public-journal.json');
  return {
    name: 'v2-changelog-page',
    configureServer: (s) => void s.watcher.add([file, journal]),
    transformIndexHtml(html, ctx) {
      if (!/(^|\/)changelog\.html$/.test(ctx.path)) return;
      const page = changelogHtml(html, readFileSync(file, 'utf8'), '/', JSON.parse(readFileSync(journal, 'utf8')));
      return page.replace('</title>', '</title>\n    <link rel="alternate" type="text/markdown" href="/changelog.md" />');
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'changelog.md', source: readFileSync(file, 'utf8') });
    },
  };
}

const proxy = {
  ...(process.env.V2_DIRECTORY ? { '/v1/': process.env.V2_DIRECTORY } : {}),
  ...(process.env.V2_GATEWAY ? { '/v2/': { target: process.env.V2_GATEWAY, ws: true } } : {}),
};

export default defineConfig({
  base: './',
  resolve: { alias: { replica: resolve(pkg, 'replica.js') } },
  server: { fs: { allow: [here, pkg] }, proxy },
  preview: { proxy },
  worker: { format: 'es' },
  build: {
    target: 'es2022', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 1024,
    rollupOptions: { input: { main: resolve(here, 'index.html'), pairing: resolve(here, 'src/pairing/card.html'), worlds: resolve(here, 'src/worlds/index.html'), home: resolve(here, 'src/home/index.html'), account: resolve(here, 'src/account/index.html'), changelog: resolve(here, 'changelog.html'), panel: resolve(here, 'src/panel/index.html') } },
  },
  plugins: [streamFiles(), changelogPage(), bodyAssets(process.env.V2_BODY_ASSETS), kindEntries()],
});
