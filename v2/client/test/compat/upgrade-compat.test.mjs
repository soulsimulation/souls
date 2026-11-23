// The frozen upgrade answers, from v2/ alone (Engine v2 R18, #2821; moved from tools/world-launcher/
// soul-upgrade-compat.test.mjs, #1938, to outlive X8). Exact deployed2.36.1 and prepared2.36.2, committed gzipped, run against a
// world serving the new answers (frozen-world.mjs): it prints the refusals, and a home it keeps, with two paired Souls and
// a month of memory, comes across by `upgrade`: the same two Souls, one approval each, no third, every memory file's
// hash unchanged; `upgrade --rollback` brings today's client back. Nothing here reads outside v2/ or a real home.
// R18_REPORT=1 prints the run's transcript and the hashes, for the PR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { frozenWorld } from './frozen-world.mjs';
import { readSeat, soulsWithTokens } from '../../src/home/home.mjs';

const RELEASED = fileURLToPath(new URL('./released/', import.meta.url));
const UPGRADE = new URL('../../src/upgrade/upgrade.mjs', import.meta.url);
// 2.36.1: exact deployed public artifacts, verified against /v1/config. 2.36.2: source snapshot prepared
// for0.131 (SOURCES.json at7bc4a175a), retained compatibility coverage, not today's deployed client.
const RECORDED = {
  '2.36.1': { 'eden.mjs': '73e920198d96021794ec8376866c635841d772cf2454f03debe746f021c085a2', 'skill.md': '1dc936cc633e4a2df80d468db3aa8ea2cfa50050f20d52303e51db43ec932234' },
  '2.36.2': { 'eden.mjs': '0fbdb04f80ec9714cb3fffaa61c7a52665e17d5703bce93bd22f575acd24b951', 'skill.md': '866eaed23d89a0469d8d3c0c34768034cc85e0243efd6feffbbcc48292623131' },
};
const released = (file, version = '2.36.2') => gunzipSync(readFileSync(join(RELEASED, version, `${file}.gz`)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const report = process.env.R18_REPORT === '1';
const transcript = [];

const scratch = fileURLToPath(new URL('../../../../.local/compat-upgrade/', import.meta.url));
mkdirSync(scratch, { recursive: true });
const tmp = (t, p) => { const d = realpathSync(mkdtempSync(join(scratch, p))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
/** `node eden.mjs <args>` in a folder, as an agent runs it: the JSON it prints, its exit, its stderr. */
const run = (dir, args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, SOULS_PRINCIPAL: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; });
  c.on('exit', (code) => {
    let d = null; try { d = JSON.parse(out); } catch { try { d = JSON.parse(out.trim().split('\n').pop()); } catch { /* words */ } }
    transcript.push({ args: `eden.mjs ${args.join(' ')}`, code, out: d ?? out.trim() });
    resolve({ code, d, err });
  });
});

test('C1: exact deployed2.36.1 and prepared2.36.2 artifacts retain their recorded bytes', () => {
  for (const [version, files] of Object.entries(RECORDED)) for (const [file, hash] of Object.entries(files)) assert.equal(sha(released(file, version)), hash, `${version}/${file}`);
});

/** A one-Soul folder of today's client, pointed at a world. */
function legacyFolder(t, url) {
  const d = tmp(t, 'souls-compat-old-');
  writeFileSync(join(d, 'eden.mjs'), released('eden.mjs'));
  writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({ world: url, accountAuth: true, soul: 's_ada', token: 'sim_ada' }));
  return d;
}

test('C2: the released client prints the refusal of a client below the world\'s minimum', async (t) => {
  const w = await frozenWorld({ client: Buffer.from('const VERSION = "3.0.0";\n') }); t.after(() => w.close());
  const { code, err } = await run(legacyFolder(t, w.url), ['here']);
  assert.equal(code, 1);
  assert.match(err, /This Soul client is too old for this world: it needs 3\.0\.0 or newer, and this is 2\.36\.2\. Run: node eden\.mjs upgrade\n/);
});

// --- R18: a home of today's client comes across ------------------------------------------------------------------------

const DAY = 86_400_000, START = Date.parse('2026-10-15T08:00:00.000Z');
const SOULS = [['s_ada', 'Ada'], ['s_bo', 'Bo']];

/** A month of memory in today's layout, made up: memory/log, the projections, people, journal days, MEMORY.md. */
function monthOfMemory(dir, me, name) {
  const lines = [];
  for (let day = 0; day < 30; day++) {
    for (let k = 0; k < 6; k++) {
      const at = new Date(START + day * DAY + k * 3_600_000).toISOString();
      lines.push(JSON.stringify({ v: 1, at, world: 'eden', soul: me, kind: 'speech', from: k % 2 ? 's_bo' : 's_cal', text: `Day ${day}, hour ${k}.` }));
    }
    mkdirSync(join(dir, 'memory', 'journal'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'journal', `${new Date(START + day * DAY).toISOString().slice(0, 10)}.md`), `# Day ${day}\n\n${name} sat at the cafe.\n`);
  }
  mkdirSync(join(dir, 'memory', 'log'), { recursive: true });
  mkdirSync(join(dir, 'memory', 'people'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'log', 'memory-events.jsonl'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'memory', 'people', 's_cal.md'), '# Cal (s_cal)\n\nMet at the square.\n');
  writeFileSync(join(dir, 'memory', 'knowledge.md'), `# What ${name} knows\n\nThe cafe is quiet before nine.\n`);
  writeFileSync(join(dir, 'MEMORY.md'), `# ${name}\n\nI like slow mornings.\n`);
}

/** sha256 of every memory file of each Soul, by its path under the old id; `now` names the folder each is in now. */
function memoryHashes(home, now = {}) {
  const out = {};
  const walk = (dir, as) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${as}/${e.name}`);
      else if (e.isFile()) out[`${as}/${e.name}`] = sha(readFileSync(p));
    }
  };
  for (const [id] of SOULS) {
    const at = join(home, 'souls', now[id] ?? id);
    walk(join(at, 'memory'), `souls/${id}/memory`);
    out[`souls/${id}/MEMORY.md`] = sha(readFileSync(join(at, 'MEMORY.md')));
  }
  return out;
}

for (const version of Object.keys(RECORDED)) test(`R18: released-shape${version} keeps distinct world identity, memory and rollback`, async (t) => {
  const hashes = RECORDED[version], alias = 'my-eden', worldId = 'world-internal-7';
  const d = tmp(t, 'souls-r18-'), home = join(d, '.souls'), env = { SOULS_HOME: home };
  // The new client, as the world serves it at /eden.mjs: its version line, and the upgrade by name. R17's bundle takes
  // this one's place once the world serves it.
  const client = Buffer.from(`#!/usr/bin/env node\nconst VERSION = "3.0.0";\nconst [cmd, ...rest] = process.argv.slice(2);\nif (cmd !== 'upgrade') { console.log(JSON.stringify({ ok: false, code: 'not-in-this-stand-in' })); process.exit(1); }\nconst { main } = await import(${JSON.stringify(UPGRADE.href)});\nconsole.log(JSON.stringify(await main(rest)));\n`);
  // X11's table: each former id, the new Soul it became and its owner.
  const grant = () => `soul-${randomBytes(16).toString('hex')}-0`;
  const imported = { [worldId]: { s_ada: { account: 'acct-1', grant: grant() }, s_bo: { account: 'acct-1', grant: grant() } } };
  const w = await frozenWorld({ slug: 'public-eden', client, imported }); t.after(() => w.close());

  // The home, as today's client keeps it: made by `init`, then two Souls paired in Eden.
  writeFileSync(join(d, 'eden.mjs'), released('eden.mjs', version));
  assert.equal((await run(d, ['init'], env)).code, 0);
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  delete config.awaitingFirstWorld;
  Object.assign(config, { currentWorld: alias, trustedOrigins: [w.origin], worlds: { [alias]: { url: w.url, name: 'Eden', worldId } } });
  const creds = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
  for (const [id, name] of SOULS) {
    config.souls[id] = { name, world: alias, state: 'active' };
    creds.souls[id] = { [alias]: { token: `sim_${randomBytes(16).toString('hex')}` } };
    const dir = join(home, 'souls', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'soul.json'), JSON.stringify({ id, name, world: w.url }));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ world: w.url }));
    monthOfMemory(dir, id, name);
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
  const listed = await run(d, ['list'], env);
  assert.deepEqual(listed.d.souls.map((s) => s.name).sort(), ['Ada', 'Bo'], 'today\'s client reads the home it keeps');
  const before = memoryHashes(home);
  assert.equal(Object.keys(before).length, 2 * 34, 'a month of memory per Soul: 30 journal days, the log, a person, knowledge, MEMORY.md');

  // Step 0 and the frozen path: today's client upgrades itself to what the world serves.
  const up = await run(d, ['upgrade', alias], env);
  assert.equal(up.code, 0, up.err);
  assert.deepEqual([up.d.upgraded, up.d.from, up.d.to], [true, version, '3.0.0'], up.err);
  assert.equal(sha(readFileSync(join(home, 'bin', `eden-${version}.mjs`))), hashes['eden.mjs'], 'today\'s client is kept for a rollback');

  // The new client's `upgrade`: one approval each.
  const asked = await run(d, ['upgrade'], env);
  assert.equal(asked.code, 0, asked.err);
  assert.deepEqual(asked.d.asks.map((a) => a.formerly).sort(), ['s_ada', 's_bo']);
  for (const a of asked.d.asks) assert.deepEqual(w.approve(a.code, 'acct-1'), { approved: true, soul: imported[worldId][a.formerly].grant });
  const log = join(home, 'upgrade.log');
  for (const until = Date.now() + 15_000; !readFileSync(log, 'utf8').includes('"done":true');) {
    assert.ok(Date.now() < until, readFileSync(log, 'utf8'));
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop());
  transcript.push({ args: '(the detached upgrade, upgrade.log)', out: done });
  assert.equal(done.ok, true, JSON.stringify(done));

  // A1: the same two Souls, one approval each, no third.
  const now = Object.fromEntries(done.souls.map((s) => [s.formerly, s.soul]));
  assert.deepEqual(Object.keys(now).sort(), ['s_ada', 's_bo']);
  assert.deepEqual(soulsWithTokens(home).sort(), Object.values(now).sort(), 'the home holds the two Souls, by their new ids');
  for (const [old, id] of Object.entries(now)) {
    assert.equal(id, `s_${imported[worldId][old].grant.slice('soul-'.length)}`);
    assert.equal(readSeat(home, id).gateway, `ws://${new URL(w.url).host}/w/public-eden/v2/ws`);
    assert.equal(existsSync(join(home, 'souls', old)), false, 'the old folder took the new id');
  }
  assert.deepEqual(w.counts, { requests: 2, newSouls: 0, approvals: 2, delivered: 2 });
  const again = await run(d, ['upgrade'], env);
  assert.equal(again.d.upgraded, false, 'a second upgrade asks for nothing');
  assert.equal(w.counts.requests, 2);
  const crossedConfig=JSON.parse(readFileSync(join(home,'config.json')));
  assert.deepEqual(Object.keys(crossedConfig.worlds),[alias]);
  assert.equal(crossedConfig.worlds[alias].worldId,worldId);
  assert.ok([...w.requests.values()].every(request=>request.world===worldId),'former approval sends internal identity, never alias/public slug');
  const aliases = JSON.parse(readFileSync(join(home, 'aliases.json'), 'utf8'));
  assert.deepEqual(aliases, { version: 'souls-aliases/1', ids: now });

  // A2: every memory file's hash unchanged, under the new ids.
  const after = memoryHashes(home, now);
  assert.deepEqual(after, before);

  // A4: `upgrade --rollback` brings today's client back, with its Souls.
  const back = await run(d, ['upgrade', '--rollback'], env);
  assert.equal(back.code, 0, back.err);
  assert.deepEqual([back.d.rolledBack, back.d.from, back.d.to], [true, '3.0.0', version]);
  assert.equal(sha(readFileSync(join(home, 'bin', 'eden.mjs'))), hashes['eden.mjs']);
  assert.equal(sha(readFileSync(join(d, 'eden.mjs'))), hashes['eden.mjs']);
  assert.equal((await run(d, ['version'], env)).d.version, version);
  assert.equal(JSON.parse(readFileSync(join(home,'config.json'))).worlds[alias].worldId,worldId,'rollback retains local alias and internal identity');
  const relisted = await run(d, ['list'], env);
  assert.deepEqual(relisted.d.souls.map((s) => `${s.name}:${s.id}`).sort(), ['Ada:s_ada', 'Bo:s_bo']);
  for (const id of Object.values(now)) assert.equal(existsSync(join(home, 'souls', id)), false);
  assert.deepEqual(memoryHashes(home), before);
  if (report) console.log(JSON.stringify({ transcript, hashes: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, [v, after[k] === v]])) }, null, 1).replaceAll(d, '<test home folder>'));
});
