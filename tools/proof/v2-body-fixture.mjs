// One fixed native body/viewer fixture; operational mappings remain private.
import { isMain } from '../lib/is-main.mjs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, extname } from 'node:path';
import { createConnection } from 'node:net';
import { checkPort, portFree } from '../../e2e/local-smoke.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = name => { throw Error('proof.v2-bodies-' + name); };
const inside = (root, name) => { const file = resolve(root, name), rel = relative(root, file); if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('path'); return file; };
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const proofFiles = new Set(['tools/proof/owned-attempt.mjs', 'tools/proof/owned-attempt.test.mjs', 'tools/proof/v2-body-fixture.mjs', 'tools/proof/drivers/v2-body-presets.mjs', 'docs/testing/e2e.md']);
export function verifyBodyArtifacts(root, pin) {
  if (!pin?.file || !/^[a-f0-9]{64}$/.test(pin.hash)) fail('artifact-pin');
  const file = inside(root, pin.file); if (hash(readFileSync(file)) !== pin.hash) fail('artifact-pin');
  const m = json(file); if (m.schema !== 'v2-body-proof-artifacts/1' || !/^[a-f0-9]{40}$/.test(m.sourceHead)) fail('schema');
  const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', m.sourceHead, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (changed.some(file => !proofFiles.has(file))) fail('source-difference');
  for (const [file, expected] of Object.entries(m.source)) if (hash(readFileSync(inside(root, file))) !== expected) fail('source');
  for (const required of ['v2/crates/worldd/src/serve.rs', 'v2/crates/gatewayd/src/main.rs', 'v2/web/src/crowd/bodies.ts', 'v2/client/src/daemon/daemon.mjs', 'v2/tools/testworld/src/lib.rs']) if (!m.source[required]) fail('source-missing');
  for (const name of ['worldd', 'gatewayd', 'testworld']) {
    if (basename(m.bins?.[name]?.path ?? '') !== name) fail('binary');
    const file = inside(root, m.bins[name].path), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || hash(readFileSync(file)) !== m.bins[name].hash) fail('binary');
  }
  for (const name of ['web', 'pkg', 'prepared']) {
    if (!m[name]?.files || !Object.keys(m[name].files).length) fail('artifact-files');
    const folder = lstatSync(inside(root, m[name].path)); if (!folder.isDirectory() || folder.isSymbolicLink()) fail('artifact-directory');
    for (const [file, expected] of Object.entries(m[name].files)) { const p = inside(inside(root, m[name].path), file), info = lstatSync(p); if (!info.isFile() || info.isSymbolicLink() || hash(readFileSync(p)) !== expected) fail('artifact-file'); }
  }
  if (!m.web.files['index.html'] || !m.pkg.files['replica_bg.wasm'] || !m.prepared.files['bodies.json']) fail('artifact-missing');
  return m;
}
export async function startV2BodyFixture({ checkout, data, log, port, artifacts, signal, onSpawn, timeoutMs = 30_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) fail('timeout');
  const until = Date.now() + timeoutMs, root = resolve(checkout), target = resolve(data), m = verifyBodyArtifacts(root, artifacts);
  const remaining = () => { signal?.throwIfAborted(); const n = until - Date.now(); if (n <= 0) fail('boot-timeout'); return n; };
  for (const p of [port, port + 1]) { checkPort(p); if (!await portFree(p)) fail('port'); remaining(); }
  mkdirSync(join(target, 'tmp'), { mode: 0o700 });
  const env = { ...process.env, BRAIN_MODE: 'fake', SOULS_JOIN_DELIVERY_TRACE: '0', SOULS_GROUND_HANDOFF_TRACE: '0', TMPDIR: join(target, 'tmp') };
  const children = [];
  const launch = (file, args, transient = false) => { remaining(); const fd = openSync(log, 'a', 0o600); let child; try { child = spawn(file, args, { cwd: target, env, stdio: ['ignore', fd, fd] }); onSpawn(child, { transient }); } finally { closeSync(fd); } if (!transient) children.push(child); return child; };
  const finite = (file, args) => new Promise((ok, reject) => {
    const child = launch(file, args, true), timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('proof.v2-bodies-seed-timeout')); }, remaining());
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', (code, sig) => { clearTimeout(timer); if (code === 0 && !sig) ok(); else reject(Error('proof.v2-bodies-seed-exit')); });
  });
  await finite(inside(root, m.bins.testworld.path), ['--seed', '1', '--things', '0', '--out', 'facts']);
  await finite(inside(root, m.bins.worldd.path), ['seed', '--facts', 'facts/testworld-s1-t0.facts.json', '--dir', 'world', '--souls', '1', '--at', '-35,30', '--bodies', inside(root, m.prepared.path + '/bodies.json'), '--body', 'pip']);
  const world = join(target, 'world'), meta = json(join(world, 'world.json'));
  launch(inside(root, m.bins.worldd.path), ['serve', '--dir', 'world', '--socket', 'world.sock', '--store', 'folder:store', '--machine', 'proof:bodies']);
  launch(inside(root, m.bins.gatewayd.path), ['--listen', `127.0.0.1:${port + 1}`, '--world', 'world.sock', '--tokens', 'world/tokens', '--build', '1220' + '00'.repeat(32)]);
  const config = join(target, 'origin.json'); writeFileSync(config, JSON.stringify({ root, data: target, web: inside(root, m.web.path), port, world: meta.name }), { mode: 0o600 });
  launch(process.execPath, [join(root, 'tools/proof/v2-body-fixture.mjs'), '--origin', config]);
  let pointer;
  while (remaining()) {
    if (children.some(c => c.exitCode !== null || c.signalCode !== null)) fail('service-exited');
    try {
      pointer = json(join(world, 'views/world.json'));
      const response = await fetch(`http://127.0.0.1:${port}/s/${pointer.stream.replace(/^views\//, '')}pointer`, { signal: AbortSignal.timeout(Math.min(250, remaining())) });
      if (response.ok && lstatSync(join(target, 'world.sock')).isSocket()) {
        await new Promise((ok, reject) => { const socket = createConnection({ host: '127.0.0.1', port: port + 1 });
          socket.setTimeout(Math.min(250, remaining()), () => socket.destroy(Error('gateway-not-ready')));
          socket.once('connect', () => { socket.destroy(); ok(); }); socket.once('error', reject); });
        break;
      }
    } catch (error) { if (signal?.aborted) throw error; }
    await new Promise(r => setTimeout(r, Math.min(25, remaining())));
  }
  // Component-only placement metadata: the deployed producer is tracked separately in #3661.
  const publicStream = /^views\/([a-f0-9]{32})\/([a-f0-9]{32}-(?:0|[1-9][0-9]*))\/(0|[1-9][0-9]*)\/([a-f0-9]{32}-(?:0|[1-9][0-9]*))\/1\/everyone\/$/.exec(pointer.stream);
  if (!publicStream || publicStream[2] !== publicStream[4] || meta.name !== `${publicStream[1]}-${publicStream[2]}` || pointer.history !== 'history/') fail('public-placement');
  const history = join(world, 'history'); mkdirSync(history, { recursive: true, mode: 0o700 });
  writeFileSync(join(history, 'live'), pointer.stream.slice('views/'.length, -1) + '\n', { flag: 'wx', mode: 0o600 });
  const base = `http://127.0.0.1:${port}`, home = join(target, 'home'); mkdirSync(home, { mode: 0o700 });
  // Only the fresh seed's own secret is read; it is never a command argument or a report field.
  const token = readFileSync(join(world, 'souls.tokens'), 'utf8').trim(); if (!/^soul-[a-f0-9]{32}-1\.[a-f0-9]{64}$/.test(token)) fail('seed-token');
  const soul = 's_' + token.slice(5, token.indexOf('.'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { proof: { url: base, gateway: `ws://127.0.0.1:${port + 1}/v2/ws` } } }), { mode: 0o600 });
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [soul]: { proof: { token } } } }), { mode: 0o600 });
  const recipe = { kind: 'v2-bodies', checkout: root, home, soul, world: meta.name, lineage: pointer.stream.split('/')[1], pkg: inside(root, m.pkg.path), catalogue: inside(root, m.prepared.path + '/bodies.json'),
    startAgent() { const fd = openSync(log, 'a', 0o600); try { const c = spawn(process.execPath, [join(root, 'v2/client/src/daemon/daemon.mjs'), '--home', home, '--soul', soul, '--pkg', inside(root, m.pkg.path)], { cwd: target, env, stdio: ['ignore', fd, fd] }); onSpawn(c); return c; } finally { closeSync(fd); } },
    registerCommand(c) { onSpawn(c, { transient: true }); } };
  return { child: children[0], children, base, viewer: base + '/?stream=' + encodeURIComponent('/s/' + pointer.stream.replace(/^views\//, '')), dataDir: target, recipe };
}
// Fixed static origin: actual built web, actual public view and public archive export only.
if (isMain(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--origin') fail('entry');
  const c = json(process.argv[3]), views = join(c.data, 'world/views'), history = join(c.data, 'world/history');
  const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url, 'http://fixture'); if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
      if (u.pathname === '/favicon.ico') return res.writeHead(204).end();
      let path;
      if (u.pathname.startsWith('/s/h/')) { const [, , , world, lineage, ...rest] = u.pathname.split('/'); if (world !== c.world || lineage !== c.world.split('-')[0]) fail('history-path'); path = inside(history, decodeURIComponent(rest.join('/'))); }
      else if (u.pathname.startsWith('/s/')) path = inside(views, decodeURIComponent(u.pathname.slice(3)));
      else path = inside(c.web, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1)));
      const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) fail('static-file'); const bytes = readFileSync(path);
      res.writeHead(200, { 'content-type': type[extname(path)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404, { 'cache-control': 'no-store' }).end(); }
  });
  server.listen(c.port, '127.0.0.1'); const stop = () => server.close(() => process.exit(0)); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
