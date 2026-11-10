// #1773: collect gathers a recorded session into a private folder: the client's record, the serve log, only the
// transcripts recorded in that very folder within the session, the end states the record names, versions and a manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProject, collect, parseArgs } from './collect.mjs';

const cli = fileURLToPath(new URL('../world-launcher/soul/eden.mjs', import.meta.url));
const TOKEN = 'sim_s_ada_PLANTEDTOKEN0123';

function world() {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname.replace(/^\/w\/t/, '');
      const answer = p === '/v1/edge/act' ? { accepted: true, receipt: { id: 'r_1', capability: 'walk:yes', phase: 'completed', endedTick: 9 } }
        : p === '/v1/edge/inbox/m_1' ? { message: { id: 'm_1', state: 'closed', text: 'walk to the mill' } }
        : p === '/v1/edge/receipts/r_1' ? { receipt: { id: 'r_1', phase: 'completed' }, auth: req.headers.authorization === `Bearer ${TOKEN}` }
        : p === '/v1/config' ? { build: 'b-test', soulClient: { version: '2.29.0', sha256: 'x' } } : {};
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/w/t`, close: () => { server.closeAllConnections?.(); server.close(); } })));
}
const run = (cwd, ...args) => new Promise((ok) => { const c = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, EDEN_NO_NOW: '1' } }); c.on('close', ok); });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const quiet = async (fn) => { const w = process.stderr.write; let err = ''; process.stderr.write = (c) => { err += c; return true; }; try { return { out: await fn(), err }; } finally { process.stderr.write = w; } };

async function session() {
  const w = await world(), base = realpathSync(mkdtempSync(join(tmpdir(), 'collect-'))), folder = join(base, 'soul'), other = join(base, 'elsewhere'), claude = join(base, 'claude');
  mkdirSync(folder); mkdirSync(other);
  writeFileSync(join(folder, '.eden-agent.json'), JSON.stringify({ world: w.url, soul: 's_ada', token: TOKEN }), { mode: 0o600 });
  writeFileSync(join(folder, '.eden-record-on'), '');
  await run(folder, 'act', 'walk:yes', '--for', 'm_1');
  writeFileSync(join(folder, '.eden-serve.log'), `2026-11-10T06:00:00.000Z serving, token ${TOKEN}\n`);
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const project = join(claude, 'projects', claudeProject(folder));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'mine.jsonl'), jsonl([
    { type: 'user', cwd: folder, timestamp: iso(now - 60_000), message: { role: 'user', content: 'walk Ada to the mill' } },
    { type: 'assistant', cwd: folder, timestamp: iso(now - 30_000), message: { content: [{ type: 'thinking', thinking: 'find the mill id' }, { type: 'tool_use', input: { command: 'node eden.mjs act walk:yes --for m_1' } }] } },
    { type: 'user', cwd: folder, timestamp: iso(now - 20_000), message: { content: [{ type: 'tool_result', content: `cat .eden-agent.json -> ${TOKEN}` }] } },
  ]));
  mkdirSync(join(project, 'mine', 'subagents'), { recursive: true });
  writeFileSync(join(project, 'mine', 'subagents', 'agent-1.jsonl'), jsonl([{ type: 'user', cwd: folder, timestamp: iso(now - 25_000), message: { content: 'sub' } }]));
  // an old session in the same folder, long before this one
  writeFileSync(join(project, 'old.jsonl'), jsonl([{ type: 'user', cwd: folder, timestamp: iso(now - 86_400_000), message: { content: 'OLDSESSION' } }]));
  utimesSync(join(project, 'old.jsonl'), (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
  // a decoy from another folder: another project's directory, and one sharing this folder's directory name
  const decoy = join(claude, 'projects', claudeProject(other)); mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'decoy.jsonl'), jsonl([{ type: 'user', cwd: other, timestamp: iso(now - 10_000), message: { content: 'DECOYCHAT' } }]));
  writeFileSync(join(project, 'collision.jsonl'), jsonl([{ type: 'user', cwd: `${folder}-x`, timestamp: iso(now - 10_000), message: { content: 'DECOYCHAT' } }]));
  // Codex sessions are named by date: one from this folder, one from another
  writeFileSync(join(base, 'codex-mine.jsonl'), jsonl([{ type: 'session_meta', timestamp: iso(now - 5_000), payload: { cwd: folder } }, { type: 'response_item', timestamp: iso(now - 4_000), payload: { type: 'message', role: 'user', content: 'codex chat' } }]));
  writeFileSync(join(base, 'codex-other.jsonl'), jsonl([{ type: 'session_meta', timestamp: iso(now - 5_000), payload: { cwd: other } }, { type: 'response_item', timestamp: iso(now - 4_000), payload: { type: 'message', role: 'user', content: 'DECOYCHAT' } }]));
  return { w, base, folder, claude, done: () => { w.close(); rmSync(base, { recursive: true, force: true }); } };
}
const bundleText = (dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, f)).filter((f) => { try { return readFileSync(f) && true; } catch { return false; } }).map((f) => readFileSync(f, 'utf8')).join('\n');

test('a session collected: records, serve log, this folder\'s transcripts only, end states, versions, a private manifest', { timeout: 60_000 }, async () => {
  const s = await session();
  try {
    const out = join(s.base, 'bundle');
    const { out: r, err } = await quiet(() => collect(parseArgs([s.folder, '--out', out, '--claude-dir', s.claude, '--transcript', join(s.base, 'codex-mine.jsonl'), '--transcript', join(s.base, 'codex-other.jsonl')])));
    assert.equal(r.transcripts, 3, 'this session, its subagent and the named Codex session');
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(m.private, true); assert.equal(m.schema, 'soul-session-bundle/1');
    assert.equal(readFileSync(join(out, '.gitignore'), 'utf8'), '*\n');
    const paths = m.files.map((f) => f.path);
    for (const p of ['client/record.jsonl', 'client/serve.log', 'world/end-states.json', 'world/config.json', 'versions.json', 'README.md']) assert.ok(paths.includes(p), p);
    assert.deepEqual(readdirSync(join(out, 'transcripts')).map((f) => f.replace(/^\d+-/, '')).sort(), ['claude-code-agent-1.jsonl', 'claude-code-mine.jsonl', 'codex-codex-mine.jsonl']);
    const all = bundleText(out);
    assert.ok(!all.includes('PLANTEDTOKEN'), 'no token anywhere in the bundle');
    assert.ok(!all.includes('DECOYCHAT'), 'no other folder\'s transcript');
    assert.ok(!all.includes('OLDSESSION'), 'no session outside the window');
    assert.ok(all.includes('walk Ada to the mill') && all.includes('find the mill id'), 'the owner\'s chat and the reasoning');
    assert.ok(m.secrets.replaced >= 2, 'the transcript\'s and the serve log\'s token replaced and counted');
    assert.match(err, /codex-other\.jsonl: its recorded working directory is not the collected folder/);
    const ends = JSON.parse(readFileSync(join(out, 'world/end-states.json'), 'utf8'));
    assert.equal(ends.receipts.r_1.body.receipt.phase, 'completed'); assert.equal(ends.receipts.r_1.body.auth, true);
    assert.equal(ends.messages.m_1.body.message.state, 'closed');
    const v = JSON.parse(readFileSync(join(out, 'versions.json'), 'utf8'));
    assert.deepEqual(v.client.recorded, ['2.29.0']); assert.equal(v.world.build, 'b-test');
  } finally { s.done(); }
});

test('no transcript found: says so and what to pass, and still collects', { timeout: 60_000 }, async () => {
  const s = await session();
  try {
    const out = join(s.base, 'bundle'), empty = join(s.base, 'no-claude');
    const { out: r, err } = await quiet(() => collect(parseArgs([s.folder, '--out', out, '--claude-dir', empty, '--no-fetch'])));
    assert.equal(r.transcripts, 0);
    assert.match(err, /--transcript <file>/);
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.match(m.transcripts.note, /No transcript/); assert.match(readFileSync(join(out, 'README.md'), 'utf8'), /No transcript was found/);
    assert.deepEqual(readdirSync(join(out, 'transcripts')), []);
  } finally { s.done(); }
});

test('refused: no --out, a folder that is not empty, a folder with no record', { timeout: 60_000 }, async () => {
  const s = await session();
  try {
    assert.throws(() => parseArgs([s.folder]), /--out <dir>/);
    mkdirSync(join(s.base, 'full')); writeFileSync(join(s.base, 'full', 'x'), '');
    await assert.rejects(collect(parseArgs([s.folder, '--out', join(s.base, 'full'), '--no-fetch'])), /not empty/);
    rmSync(join(s.folder, '.eden-record'), { recursive: true });
    await assert.rejects(collect(parseArgs([s.folder, '--out', join(s.base, 'b2'), '--no-fetch'])), /No session record.*\.eden-record-on/);
    assert.ok(!existsSync(join(s.base, 'b2')));
  } finally { s.done(); }
});
