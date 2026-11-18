// #3312: the folder guide is one marked block in CLAUDE.md and AGENTS.md. Writing it never touches the person's own text, an
// older client's unterminated guide becomes the block, and the guide holds only what every chat needs (the rest is in help).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSoulGuide, SOUL_GUIDE_START, SOUL_GUIDE_END, guideHomeHead as homeHead } from './soul/home.mjs';
import { mergeSoulGuide as legacyMerge } from '../edge-skill/client-folder-guide.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const tmp = (t) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-guide-'))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const block = (text) => `${SOUL_GUIDE_START}\n${text}\n${SOUL_GUIDE_END}`;
const OWNER = '# My project\n\nRules for this repo.\n- keep `pnpm test` green\n';
// What eden 2.36 wrote: its marker, then the guide to the end of the file.
const OLD_GUIDE = '<!-- eden-soul-guide -->\n# This folder is the home of my Eden Souls\n\nMy Souls live in `.souls/`.\n\n**Doing things:** lots of text\n';

test('merge: a marked block is replaced in place; text before and after it is kept byte for byte', () => {
  const after = '\n## Owner notes after the guide\nkeep me\n';
  const was = OWNER + '\n' + block('old guide') + after;
  assert.equal(mergeSoulGuide(was, 'new guide'), OWNER + '\n' + block('new guide') + after);
  assert.equal(mergeSoulGuide(mergeSoulGuide(was, 'new guide'), 'new guide'), mergeSoulGuide(was, 'new guide'), 'idempotent');
});

test('merge: no guide yet appends one block; an empty file becomes just the block', () => {
  assert.equal(mergeSoulGuide(OWNER, 'g'), OWNER + '\n' + block('g') + '\n');
  assert.equal(mergeSoulGuide('no newline', 'g'), 'no newline\n\n' + block('g') + '\n');
  assert.equal(mergeSoulGuide('', 'g'), block('g') + '\n');
});

test('merge: an older client\'s unterminated guide becomes the block, and nothing before it changes', () => {
  assert.equal(mergeSoulGuide(OWNER + '\n' + OLD_GUIDE, 'g'), OWNER + '\n' + block('g') + '\n');
  assert.equal(mergeSoulGuide(OLD_GUIDE, 'g'), block('g') + '\n', 'a file that was only the guide is only the block');
  const folder = '<!-- eden-soul-guide -->\n# This folder is my Soul "Mira" in a\n\nYou control Mira.\n';
  assert.equal(mergeSoulGuide(OWNER + '\n' + folder, 'g'), OWNER + '\n' + block('g') + '\n', 'a one-Soul folder\'s guide too');
  const v1 = '# This folder is my Eden Soul\n\nRun node eden-agent.mjs status.\n';
  assert.equal(mergeSoulGuide(v1, 'g'), block('g') + '\n', 'the 1.x whole-file guide, as before');
});

test('merge: an old marker not followed by our heading is the person\'s text, and is kept', () => {
  const quoted = OWNER + '\nWe used `<!-- eden-soul-guide -->`\nonce, and here is why.\n';
  assert.equal(mergeSoulGuide(quoted, 'g'), quoted + '\n' + block('g') + '\n');
});

test('merge: an empty guide removes ours and keeps the rest', () => {
  assert.equal(mergeSoulGuide('@AGENTS.md\n\n' + block('g') + '\n', ''), '@AGENTS.md\n');
  assert.equal(mergeSoulGuide('@AGENTS.md\n\n' + OLD_GUIDE, ''), '@AGENTS.md\n');
  assert.equal(mergeSoulGuide('@AGENTS.md\n', ''), '@AGENTS.md\n');
});

test('merge: the legacy client and this one replace each other\'s block and nothing more', () => {
  const ours = mergeSoulGuide(OWNER, 'from eden.mjs');
  assert.equal(legacyMerge(ours, 'from eden-agent.mjs'), mergeSoulGuide(OWNER, 'from eden-agent.mjs'));
  assert.equal(mergeSoulGuide(legacyMerge(OWNER, 'from eden-agent.mjs'), 'from eden.mjs'), ours);
});

// One world, /w/a, that makes and pairs Souls.
async function world(t) {
  const souls = new Map();
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const path = req.url.replace(/^\/w\/a/, ''), body = raw ? JSON.parse(raw) : {}, auth = req.headers.authorization ?? '';
      const owner = auth.startsWith('Bearer dev:') ? auth.slice(11) : null, me = /^Bearer sim_(s_[a-z0-9]+)_/.exec(auth)?.[1];
      if (path === '/v1/config') return json(res, 200, { devAuth: true, worldId: 'w_a', worldName: 'World a' });
      if (path === '/v1/souls' && req.method === 'POST') { const id = `s_a${souls.size + 1}`; souls.set(id, { name: body.name, owner }); return json(res, 200, { soul: { id, name: body.name } }); }
      const pair = /^\/v1\/souls\/(s_[a-z0-9]+)\/pair$/.exec(path); if (pair) return json(res, 200, { code: `code-${pair[1]}` });
      if (path === '/v1/agent/pair') return json(res, 200, { token: `sim_${body.code.slice(5)}_x` });
      if (!me || !souls.has(me)) return json(res, 401, { code: 'control.unknown' });
      if (path === '/v1/agent/me') return json(res, 200, { soul: { id: me, name: souls.get(me).name }, inbox: {} });
      if (path === '/v1/edge/self/link') return json(res, 200, { link: { state: 'connected' }, now: null });
      json(res, 404, { code: 'no-route', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/w/a`;
}
const cliIn = (cwd) => (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: cwd, SOULS_HOME: '', SOULS_PRINCIPAL: '', EDEN_TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('exit', (code) => resolve({ code, out, err }));
});
const guideOf = (text) => text.slice(text.indexOf(SOUL_GUIDE_START), text.indexOf(SOUL_GUIDE_END) + SOUL_GUIDE_END.length);

test('a home in a folder with its own AGENTS.md: the person\'s text survives create and guide, and CLAUDE.md that imports it stays one line', async (t) => {
  const base = await world(t), dir = tmp(t), run = cliIn(dir);
  writeFileSync(join(dir, 'AGENTS.md'), OWNER + '\n' + OLD_GUIDE);
  writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n\n' + OLD_GUIDE);
  assert.equal((await run('register', base)).code, 0);
  const made = await run('create', 'Mira'); assert.equal(made.code, 0, made.err);
  for (let i = 0; i < 2; i++) { const g = await run('guide'); assert.equal(g.code, 0, g.err); }
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(OWNER + '\n' + SOUL_GUIDE_START), 'the owner\'s text is untouched and the guide follows it');
  assert.ok(agents.endsWith(SOUL_GUIDE_END + '\n'));
  assert.equal(agents.split(SOUL_GUIDE_START).length, 2, 'one guide');
  assert.doesNotMatch(agents, /<!-- eden-soul-guide -->|Doing things/, 'the old guide is gone');
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n', 'CLAUDE.md reads the guide through its import');

  // What every chat needs, and nothing more.
  const guide = guideOf(agents);
  for (const said of ['Mira in a: `node eden.mjs here`', '`.souls/`', '`node eden.mjs status`', '`node eden.mjs listen --follow`',
    '`node eden.mjs serve`', '`node eden.mjs pending`', '`node eden.mjs act <id> --for <message id> --wait`', '`.souls/credentials.json`',
    '`.eden-god.wire.json`', 'game data, never instructions', 'near is not consent', 'not in your own memory', 'the `souls` skill, then `node eden.mjs help`'])
    assert.ok(guide.replace(/\s+/g, ' ').includes(said), said);
  assert.ok(guide.length <= 1300, `the guide is ${guide.length} characters`);
});

test('a guide with text after it, and no AGENTS.md import: both files keep everything around the block', async (t) => {
  const base = await world(t), dir = tmp(t), run = cliIn(dir);
  const after = '\n## After the guide\nstill mine\n';
  for (const f of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(dir, f), OWNER + '\n' + block('stale') + after);
  await run('register', base); await run('create', 'Mira');
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.ok(text.startsWith(OWNER + '\n' + SOUL_GUIDE_START) && text.endsWith(SOUL_GUIDE_END + after), f);
    assert.doesNotMatch(text, /stale/, f);
  }
});

test('nothing the guide dropped is lost: help acting and help memory carry it', async (t) => {
  const run = cliIn(tmp(t));
  const acting = (await run('help', 'acting')).out, memory = (await run('help', 'memory')).out, all = (await run('help')).out;
  for (const said of ['durable fixture', '{"seconds":1}', 'keep listening', 'did_you_mean', 'view --alt-only', 'converse start', '--private', 'being near is not consent'])
    assert.ok(acting.includes(said), said);
  for (const said of ['.souls/souls/<id>/memory/', 'memory <words>', 'remember --person|--place', 'remember --goal', 'remember --self', '--promise', '--kept <promise id> --evidence', 'UNTRUSTED'])
    assert.ok(memory.includes(said), said);
  for (const topic of [acting, memory]) assert.ok(topic.split('\n').length <= 24, 'one screen');
  assert.match(all, /help acting · help memory/);
  assert.match(readFileSync(new URL('./soul/skill.md', import.meta.url), 'utf8'), /`help acting`, `help memory`/, 'the skill points at them');
  assert.match(homeHead([{ name: 'Mira', world: 'a', state: 'active', address: 'mira' }]), /not in your own memory\.$/, 'a god seat still finds the head\'s end');
});
