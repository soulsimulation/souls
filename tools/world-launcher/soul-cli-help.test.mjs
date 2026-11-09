// #1471: `help <topic>` prints one section of the folder's world's reference (/schema.md), the topics the skill's core names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP_TOPICS, referenceSection } from './soul/eden.mjs';

const soul = fileURLToPath(new URL('./soul/', import.meta.url));
const cli = join(soul, 'eden.mjs');
const notes = readFileSync(join(soul, 'schema-notes.md'), 'utf8'), core = readFileSync(join(soul, 'skill.md'), 'utf8');

async function folder(t, reference = notes) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-help-')), asked = [];
  const server = createServer((req, res) => { asked.push(req.url); if (req.url === '/w/test/schema.md' && reference !== null) { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(reference); } else { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}/w/test`, soul: 's', token: 'synthetic-help-token' }), { mode: 0o600 });
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => done({ code, out, err }));
  });
  return { dir, asked, run };
}

test('A3/A5: the topics the core names are the CLI\'s, and each is a section of the reference', () => {
  assert.deepEqual(/`help <topic>`: ([a-z, ]+)\./.exec(core)[1].split(', '), HELP_TOPICS);
  for (const t of HELP_TOPICS) {
    const s = referenceSection(notes, t);
    assert.ok(s && s.startsWith('## ') && s.split('\n').length > 2, `${t}: ${s}`);
    assert.doesNotMatch(s.split('\n').slice(1).join('\n'), /^#{1,2} /m, `${t} stops at the next heading`);
  }
  assert.match(referenceSection(notes, 'messages'), /^## Messages still open/, 'a whole word: not "When an owner message ends a wait"');
  assert.match(referenceSection(notes, 'memory'), /^## Your memory, and your owner's choice/, 'punctuation is not part of the word');
  assert.equal(referenceSection(notes, 'nothing'), null);
});

test('A3: help <topic> prints that section of this world\'s reference as text', async (t) => {
  const f = await folder(t);
  const r = await f.run('help', 'rides');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, referenceSection(notes, 'rides'));
  assert.match(r.out, /never say you landed at the building/);
  assert.deepEqual(f.asked, ['/w/test/schema.md']);
  const plain = await f.run('help');
  assert.equal(plain.code, 0);
  assert.match(plain.out, /help \[topic\].*refusals, rides, plans, messages, listening, talking, memory/);
});

test('A3: an unknown topic lists the topics and asks nothing; a missing section or world says so, exit 1', async (t) => {
  const f = await folder(t, '# A reference\n\n## Looking\n\nOnly this.\n');
  const u = await f.run('help', 'flying');
  assert.equal(u.code, 1); assert.match(u.err, /no help topic "flying"\. Topics: refusals, rides/);
  assert.deepEqual(f.asked, []);
  const m = await f.run('help', 'plans');
  assert.equal(m.code, 1); assert.match(m.err, /this world's reference has no "plans" section; all of it is at http.*\/schema\.md/);
  const g = await folder(t, null);
  const d = await g.run('help', 'plans');
  assert.equal(d.code, 1); assert.match(d.err, /could not read this world's reference .*HTTP 404/);
  assert.equal(d.out, '');
});
