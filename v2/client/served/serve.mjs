#!/usr/bin/env node
// Answers the served client's addresses from a folder build.mjs wrote (Engine v2 R17, #2818), under any world's
// address: `<world>/eden.mjs`, `/eden.mjs.sha256`, `/skill.md`, `/creator.md`, `/instructions.md`, `/safety.md`, `/replica.js`, `/replica_bg.wasm`, and
// `<world>/v1/config` as `{soulClient}`. Plain 200s with no redirect and no sign-in (docs/architecture/api.md,
// "Soul client upgrade", frozen). Whatever answers a world's address mounts `answer` (R18 #2821); on a machine the
// release puts the folder at /usr/local/lib/souls/client (v2/tools/ops/release/release.sh `move`).
//
//   node v2/client/served/serve.mjs <served dir> [--port <n>] [--upstream <origin>]
//     a local stand-in: anything else is passed to --upstream (a directory, say), else 404. Prints `listening <url>`.

import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  'eden.mjs': 'text/javascript; charset=utf-8', 'replica.js': 'text/javascript; charset=utf-8',
  'replica_bg.wasm': 'application/wasm', 'skill.md': 'text/markdown; charset=utf-8',
  'creator.md': 'text/markdown; charset=utf-8', 'instructions.md': 'text/markdown; charset=utf-8',
  'safety.md': 'text/markdown; charset=utf-8', 'eden.mjs.sha256': 'text/plain; charset=utf-8',
};

/** The answer for `path` (no query), or null when it is not one of the served addresses. */
export function answer(dir, path) {
  path = path.replace(/\/llms\.txt$/, '/instructions.md'); // The world's short agent guide is the current instructions.
  const config = /\/v1\/config$/.test(path), name = /\/([a-z0-9_.]+)$/.exec(path)?.[1];
  if (!config && !TYPES[name]) return null;
  try {
    if (config) return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify({ soulClient: JSON.parse(readFileSync(join(dir, 'soul-client.json'), 'utf8')) })) };
    return { status: 200, type: TYPES[name], body: readFileSync(join(dir, name)) };
  } catch {
    return null;
  }
}

// tools/lib/is-main.mjs, inlined: this file is bundled or copied alone. A start through a symlink still runs main.
const startedAsScript = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedAsScript()) {
  const args = process.argv.slice(2), dir = args[0];
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const upstream = opt('--upstream');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const a = req.method === 'GET' || req.method === 'HEAD' ? answer(dir, url.pathname) : null;
    if (a) {
      res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : a.body);
    }
    if (!upstream) { res.writeHead(404); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(new URL(req.url, upstream), { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'text/plain' }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.listen(Number(opt('--port') ?? 0), '127.0.0.1', () => console.log(`listening http://127.0.0.1:${server.address().port}`));
}
