// 24 Nov: a moved world's models and pictures. On the old engine the world's own process answered
// `/asset-view/<sha>.glb` and `/assets/<sha>.<ext>` (apps/server/src/god/assets.ts serveAsset); a moved world has no old
// process (D2b, #4612), so its page's requests for the meshes and images of its own scene (a god's uploads: Verdelis's
// dome parts, rna-studio's pictures) were 404 world.new-engine. They are answered here, from the same two places the old
// store read: the release's core assets (worlds/core-assets/*.index.json, a core mesh's smaller rendition from
// renditions.json) and the box's shared upload store (`$ASSET_DIR`, else `<data>/worlds/assets`: `<sha>.<ext>` beside
// `<sha>.meta.json`). An upload's bytes never change under its sha, so it is cached immutably; a core mesh's viewer
// rendition may change in a later release, so it revalidates by ETag as before. The brotli copy the old process kept
// (`<store>/wire/<key>.br`) is sent when there is one and the browser takes it; nothing is compressed here.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = /^\/(asset-view|assets)\/([0-9a-f]{64})\.(glb|png|jpg|json)$/;
const TYPES = { glb: 'model/gltf-binary', png: 'image/png', jpg: 'image/jpeg', json: 'application/json' };
const SHA = /^[0-9a-f]{64}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The core assets' index as the old store merges it: index.json over the `<name>.index.json` sets beside it. */
function coreIndex(root) {
  const dir = join(root, 'worlds', 'core-assets');
  const read = (f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8'))?.assets ?? {}; } catch { return {}; } };
  let extra = {};
  try { for (const f of readdirSync(dir).filter((n) => n.endsWith('.index.json')).sort()) extra = { ...read(f), ...extra }; } catch { /* none */ }
  return { ...extra, ...read('index.json') };
}
function renditions(root) {
  const out = new Map();
  try {
    const idx = JSON.parse(readFileSync(join(root, 'worlds', 'core-assets', 'renditions.json'), 'utf8'));
    if (idx?.schema === 'core-renditions/1') for (const [src, r] of Object.entries(idx.renditions ?? {})) {
      if (SHA.test(src) && SHA.test(r?.sha ?? '') && typeof r.path === 'string' && !r.path.includes('..')) out.set(src, { sha: r.sha, file: join(root, r.path) });
    }
  } catch { /* no renditions */ }
  return out;
}

/** `assetDir`: the shared upload store; `root`: the release (its worlds/core-assets). Returns `serve(req, res, rest)`,
 *  true when `rest` is one of the two asset routes (answered: the file, 304, or 404 no-store), else false. */
export function movedAssets({ assetDir, root }) {
  let core = null, ren = null;
  const metaOf = (sha) => { try { return JSON.parse(readFileSync(join(assetDir, `${sha}.meta.json`), 'utf8')); } catch { return null; } };
  /** The file a request names and how it is cached, or null. */
  function find(view, sha, ext) {
    core ??= coreIndex(root);
    const c = Object.hasOwn(core, sha) ? core[sha] : null;
    if (c) {
      if (c.ext !== ext) return null;
      ren ??= renditions(root);
      const r = ext === 'glb' ? ren.get(sha) : null;
      if (r) return existsSync(r.file) ? { file: r.file, etag: `"${sha}-r${r.sha.slice(0, 16)}"`, key: `${r.sha}.${ext}`, cache: 'public, no-cache' } : null;
      const file = c.path && !String(c.path).includes('..') ? join(root, c.path) : join(assetDir, `${sha}.${ext}`);
      return existsSync(file) ? { file, etag: `"${sha}"`, key: `${sha}.${ext}`, cache: ext === 'glb' || view ? 'public, no-cache' : IMMUTABLE } : null;
    }
    if (metaOf(sha)?.ext !== ext) return null;
    const file = join(assetDir, `${sha}.${ext}`);
    return existsSync(file) ? { file, etag: `"${sha}"`, key: `${sha}.${ext}`, cache: IMMUTABLE } : null;
  }
  return function serve(req, res, rest) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const m = ROUTE.exec(rest);
    if (!m || (m[1] === 'asset-view' && m[3] !== 'glb')) return false;
    const [, ns, sha, ext] = m;
    const hit = find(ns === 'asset-view', sha, ext);
    if (!hit) {
      const body = JSON.stringify({ ok: false, code: 'not-found', message: 'no such asset' });
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)) }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    const headers = { 'content-type': TYPES[ext], etag: hit.etag, 'cache-control': hit.cache, vary: 'accept-encoding', 'access-control-allow-origin': '*' };
    if (String(req.headers['if-none-match'] ?? '').replace(/^W\//, '') === hit.etag) { res.writeHead(304, headers).end(); return true; }
    let file = hit.file;
    if ((ext === 'glb' || ext === 'json') && /\bbr\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const br = join(assetDir, 'wire', `${hit.key}.br`);
      if (existsSync(br)) { file = br; headers['content-encoding'] = 'br'; }
    }
    let size; try { size = statSync(file).size; } catch { return false; }
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  };
}
