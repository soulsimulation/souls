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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';

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
    rollupOptions: { input: { main: resolve(here, 'index.html'), worlds: resolve(here, 'src/worlds/index.html'), home: resolve(here, 'src/home/index.html'), panel: resolve(here, 'src/panel/index.html') } },
  },
  plugins: [streamFiles()],
});
