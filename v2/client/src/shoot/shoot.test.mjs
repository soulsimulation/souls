// G10 (#2800): `shoot` is anonymous, says why when there is no browser and answers in words, and sends the creator's
// list picture. The browser itself is driven in the proof (a local world, a warm profile), not here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_BROWSER, anonymous, pageOf, parseShoot, runShoot, setListPicture } from './shoot.mjs';

test('the arguments: a name, --eyes, the output, the size; picture needs its world, directory and person', () => {
  const o = parseShoot(['the', 'west', 'chair', '--out', 'c.jpg', '--size', '640x360']);
  assert.deepEqual([o.name, o.out, o.size, o.eyes], ['the west chair', 'c.jpg', [640, 360], false]);
  assert.equal(parseShoot(['Oriel', '--eyes']).out, 'shot-Oriel.png');
  assert.throws(() => parseShoot([]), { code: 'usage' });
  assert.throws(() => parseShoot(['x', '--out', 'x.gif']), { code: 'usage' });
  assert.throws(() => parseShoot(['picture', 'a.png', '--world', 'w']), { code: 'usage' });
  assert.equal(parseShoot(['picture', 'a.png', '--world', 'w', '--directory', 'http://d', '--as', 'ann']).picture, 'a.png');
});

test('the browser opens the page anonymous: no sign-in parameter, no credentials, the moment kept', () => {
  const u = new URL(anonymous('https://u:p@soul.example/v2/?stream=/s/a/&directory=https://d&gateway=wss://g&as=ann&token=x#w=eden&l=ab&t=5'));
  assert.deepEqual([...u.searchParams.keys()].sort(), ['shot', 'stream']);
  assert.equal(u.username + u.password, '');
  assert.equal(u.hash, '#w=eden&l=ab&t=5', "V9's link places the shot in time");
});

test('the page: --page, SOULS_PAGE, else the home\'s one world', () => {
  const home = mkdtempSync(join(tmpdir(), 'g10-'));
  assert.throws(() => pageOf({}, home), { code: 'which-page' });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { eden: { url: 'https://soul.example/eden', page: 'https://soul.example/v2/?world=eden' } } }));
  assert.equal(pageOf({}, home), 'https://soul.example/v2/?world=eden');
  assert.equal(pageOf({}, home, { SOULS_PAGE: 'https://x/' }), 'https://x/');
  assert.equal(pageOf({ page: 'https://y/' }, home), 'https://y/');
});

test('A3: with no browser, the answer is words and why', async () => {
  const home = mkdtempSync(join(tmpdir(), 'g10-'));
  mkdirSync(home, { recursive: true });
  const asked = [];
  const ask = async (req) => (asked.push(req.op), req.op === 'look' ? { room: { name: 'room 1' }, here: ['lamp 7'] } : { found: [{ name: 'lamp 7' }] });
  const words = await runShoot(['lamp', '--page', 'https://soul.example/v2/'], { home, ask, pw: null });
  assert.equal(words.picture, null);
  assert.equal(words.why, NO_BROWSER);
  assert.deepEqual(words.words, { brief: { room: { name: 'room 1' }, here: ['lamp 7'] }, found: { found: [{ name: 'lamp 7' }] } });
  assert.deepEqual(asked.sort(), ['find', 'look']);
  const none = await runShoot(['lamp', '--page', 'https://soul.example/v2/'], { home, pw: null });
  assert.equal(none.words, null);
  assert.match(none.note, /no Soul/);
});

test('picture: the shot goes to the directory as base64url, signed in as the creator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g10-')), file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let sent;
  const get = async (url, init) => ((sent = { url, init }), { ok: true, json: async () => ({ world: { picture: 'data:image/png;base64,iVBORw==' } }) });
  const r = await setListPicture({ directory: 'http://127.0.0.1:9/', world: 'mine', as: 'ann', file }, get);
  assert.equal(sent.url, 'http://127.0.0.1:9/v1/worlds/settings');
  assert.equal(sent.init.headers.authorization, 'Bearer test:ann');
  assert.deepEqual(JSON.parse(sent.init.body), { world: 'mine', picture: 'iVBORw' });
  assert.equal(r.ok, true);
  const refused = async () => ({ ok: false, status: 403, json: async () => ({ refused: 'not-the-creator' }) });
  await assert.rejects(setListPicture({ directory: 'http://d/', world: 'mine', as: 'bob', file }, refused), { code: 'not-the-creator' });
});
