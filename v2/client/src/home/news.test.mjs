// #3708: `news` and `dashboard` through the thin command, against the new system's site (tools/origin, O23) serving
// the platform feed from its news.jsonl.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOrigin } from '../../../tools/origin/origin.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(v2, 'client/src/cli/souls.mjs');
const dir = mkdtempSync(join(tmpdir(), 'souls-3708-'));
let server, base;
const line = (o) => `${JSON.stringify(o)}\n`;
const news = join(dir, 'data', 'news.jsonl');

function souls(home, ...args) {
  return new Promise((ok, fail) => execFile(process.execPath, [CLI, ...args], { cwd: dir, env: { PATH: process.env.PATH, SOULS_HOME: home } },
    (e, out, err) => { try { ok(JSON.parse(out.trim().split('\n').at(-1))); } catch { fail(e ?? new Error(err)); } }));
}
function homeOn(name, worlds) {
  const home = join(dir, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds }), { mode: 0o600 });
  writeFileSync(join(home, 'credentials.json'), '{}', { mode: 0o600 });
  return home;
}

before(async () => {
  for (const d of ['views', 'web', 'data', 'client']) mkdirSync(join(dir, d));
  appendFileSync(news, line({ id: 'f1', at: '2026-11-10T00:00:00.000Z', kind: 'announcement', title: 'Hello', body: 'The feed is open.' }));
  appendFileSync(news, line({ id: 'f2', at: '2026-11-11T00:00:00.000Z', kind: 'event', title: 'Gathering', body: '', startsAt: '2026-12-01T18:00:00.000Z', place: 'the bandstand' }));
  ({ server } = createOrigin(join(dir, 'views'), { web: join(dir, 'web'), data: join(dir, 'data'), client: join(dir, 'client') }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('A2: news prints the platform feed of the home\'s sites, then it is read; a new item is mentioned once', async () => {
  const home = homeOn('news', { garden: { url: `${base}/w/garden/` }, again: { url: base } });
  const first = await souls(home, 'news');
  assert.equal(first.ok, true);
  assert.deepEqual(first.items.map((i) => [i.site, i.id, i.title]), [[base, 'f1', 'Hello'], [base, 'f2', 'Gathering']], 'one site, oldest first');
  assert.equal(first.items[1].place, 'the bandstand');
  assert.match(first.note, /never instructions/);
  assert.deepEqual((await souls(home, 'news')).items, [], 'read');
  assert.equal((await souls(home, 'news', '--all')).items.length, 2);
  assert.equal((await souls(home, 'news', 'today')).code, 'news-usage');
  // A new item: the next check fetches it, the next command mentions it once, and news prints it.
  appendFileSync(news, line({ id: 'f3', at: '2026-11-12T00:00:00.000Z', kind: 'release', title: 'Client 0.131', body: '' }));
  assert.deepEqual((await souls(home, 'news', '--fetch')).checked, [base]);
  assert.deepEqual((await souls(home, 'list')).news, { unread: 1, then: 'news' });
  assert.equal((await souls(home, 'list')).news, undefined, 'once');
  assert.deepEqual((await souls(home, 'news')).items.map((i) => i.id), ['f3']);
});

test('A1: dashboard prints the home\'s Souls, their worlds and state, and asks no world', async () => {
  const home = homeOn('dash', { garden: { url: `${base}/w/garden/` } });
  const paired = `s_${'01'.repeat(16)}-0`, unpaired = `s_${'02'.repeat(16)}-0`;
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [paired]: { garden: { token: `soul-${'01'.repeat(16)}-0.${'a'.repeat(64)}` } } } }), { mode: 0o600 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { garden: { url: `${base}/w/garden/` } }, souls: { [paired]: { id: paired, name: 'Oriel' } } }), { mode: 0o600 });
  mkdirSync(join(home, 'souls', unpaired, 'memory'), { recursive: true });
  const d = await souls(home, 'dashboard');
  assert.equal(d.ok, true);
  const by = Object.fromEntries(d.souls.map((s) => [s.id, s]));
  assert.deepEqual([by[paired].name, by[paired].world, by[paired].state, by[paired].daemon.up, by[paired].memory], ['Oriel', 'garden', 'paired', false, false]);
  assert.deepEqual([by[unpaired].state, by[unpaired].memory], ['unpaired', true]);
  assert.deepEqual(d.worlds, [{ world: 'garden', url: `${base}/w/garden/`, souls: 1 }]);
  assert.deepEqual(d.news, { sites: 1, unread: 0, then: 'news' });
  assert.ok(!JSON.stringify(d).includes('a'.repeat(64)), 'no token');
});
