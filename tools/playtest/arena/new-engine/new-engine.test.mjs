// The new-engine playtest world and seats (0.135 P1): the parts that need no running world. The world itself is run by
// smoke.mjs (`node tools/playtest/arena/new-engine/smoke.mjs`).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addresses, runArgs, WORLD } from './world.mjs';
import { lastJson, pairArgs, seatEnv } from './seat.mjs';
import { noOldServer } from './smoke.mjs';
import { frontDoor, genesisFor, templateName, withRoute } from './old-page.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("a scene's own genesis, or a template with things added, is the run's own template for both sides", () => {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-'));
  try {
    assert.equal(genesisFor({ template: 'worlds/templates/hello-hamlet.json', dir }).templatesDir, null, 'a committed template is used as it is');
    const g = genesisFor({ template: 'worlds/templates/hello-hamlet.json', add: [{ op: 'place', def: 'core:bench' }], dir });
    assert.equal(g.name, 'hello-hamlet'); assert.equal(g.templatesDir, join(dir, 'templates'));
    assert.deepEqual(JSON.parse(readFileSync(g.template, 'utf8')).batches.at(-1).ops, [{ op: 'place', def: 'core:bench' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run.sh is given its port, folder and facts, and its programs are where its header says', () => {
  assert.deepEqual(runArgs({ dir: '/x/world', port: 7400, facts: '/x/g.facts.json' }), ['--port', '7400', '--dir', '/x/world', '--facts', '/x/g.facts.json']);
  assert.deepEqual(runArgs({ dir: '/x/world', port: 7400 }), ['--port', '7400', '--dir', '/x/world']);
  const a = addresses(7400);
  assert.equal(a.page, `http://127.0.0.1:7400/w/${WORLD}/`);
  assert.equal(a.directory, 'http://127.0.0.1:7401');
  assert.equal(a.gateway, 'ws://127.0.0.1:7402/v2/ws');
});

test('a seat pairs as the e2e test pairs, with only the client in its environment', () => {
  const world = { ...addresses(7400), world: WORLD };
  assert.deepEqual(pairArgs(world, 'alder'), ['--directory', 'http://127.0.0.1:7401', '--world', 'dev', '--gateway', 'ws://127.0.0.1:7402/v2/ws',
    '--device', 'playtest machine', '--label', 'alder', '--advert', 'http://127.0.0.1:7400/w/dev/views/world.json']);
  const env = seatEnv('/h/.souls', '/pkg');
  assert.equal(env.SOULS_HOME, '/h/.souls');
  assert.equal(env.BRAIN_MODE, 'fake');
  assert.ok(!Object.keys(env).some((k) => /KEY|TOKEN|ANTHROPIC|OPENAI/.test(k)), 'no model key reaches a seat');
});

test('a command answer is its last JSON line', () => {
  assert.deepEqual(lastJson('{"step":"approve"}\n{"ok":true,"soul":"s1"}\n'), { ok: true, soul: 's1' });
  assert.deepEqual(lastJson('{"ok":true}\nnot json\n'), { ok: true });
  assert.equal(lastJson('nothing'), null);
});

test('the run is refused when the old server or launcher is among its programs', () => {
  assert.equal(noOldServer(['/b/worldd serve --dir /w', 'caddy run']), true);
  assert.equal(noOldServer(['node apps/server/src/main.ts']), false);
  assert.equal(noOldServer(['node tools/world-launcher/launcher.mjs --port 1']), false);
});

test("the old page: the production front door with this run's addresses, and the template's world routed like run.sh's", () => {
  const front = 'https://soul.game {\n reverse_proxy localhost:@@PRODUCTION_PORT@@\n reverse_proxy localhost:7310\n reverse_proxy localhost:7320\n reverse_proxy localhost:7330\n root /usr/local/lib/souls/web\n root /var/lib/souls-routes/slugs\n}';
  const c = frontDoor(front, { base: 'http://127.0.0.1:9000', launcher: 9001, directory: '127.0.0.1:7801', origin: '127.0.0.1:7803', web: '/web', slugs: '/slugs', caddyDir: '/caddy' });
  assert.ok(c.includes('http://127.0.0.1:9000 {') && c.includes('127.0.0.1:9001') && c.includes('127.0.0.1:7801') && c.includes('root /web') && c.includes('root /slugs'));
  assert.ok(!/soul\.game|@@PRODUCTION_PORT@@|localhost:73[123]0|\/usr\/local|\/var\/lib/.test(c), 'no production address is left');
  const routes = { schema: 'souls/world-routes/1', worlds: { dev: { gateway: 'http://127.0.0.1:7802', stream: '/s/w/dev/x/', canonical: true } } };
  assert.deepEqual(withRoute(routes, 'hello-hamlet').worlds['hello-hamlet'], { gateway: 'http://127.0.0.1:7802', stream: '/s/w/dev/x/', canonical: false });
  assert.equal(templateName('worlds/templates/hello-hamlet.json'), 'hello-hamlet');
});

test("a cast's and a battery's old words in the new client's, and what the stream says back", async () => {
  const { newWords, placePathOf, mailboxSoul } = await import('./director.mjs');
  const { placeIds, receiptsOf, kindName } = await import('./battery.mjs');
  assert.deepEqual(newWords(['act', 'walk to the pond hall', '--wait', '100']), ['act', '?the pond hall', '--wait']);
  assert.deepEqual(newWords(['act', 'walk:lab-presentation-hall', '--wait', '60']), ['act', '?lab-presentation-hall', '--wait']);
  assert.deepEqual(newWords(['act', '{{prev.found[0].act}}']), ['act', '{{prev.found[0].id}}']);
  assert.deepEqual(newWords(['say', 'Hello']), ['say', 'Hello']);
  assert.match(newWords(['act', 'sit-ground:here']).skip, /sit-ground/);
  assert.match(newWords(['plan', '["walk:cottage"]', '--for', '{id}']).skip, /plan/);
  assert.equal(mailboxSoul('s_ab12-0'), 'soul-ab12-0');
  const nodes = new Map([['b.0', { id: 'b.0', parent: 'f.45' }], ['f.45', { id: 'f.45', parent: 'h.44' }], ['h.44', { id: 'h.44', parent: 'g.1', placeName: 'lab-pond-hall' }], ['g.1', { id: 'g.1', parent: null }]]);
  assert.deepEqual(placePathOf(nodes, 'b.0'), ['lab-pond-hall']);
  assert.deepEqual(placeIds(['lab-pond-hall']), ['g-lab-pond-hall']);
  assert.equal(kindName('eden:bench@1220ab'), 'core-bench');
  const r = receiptsOf([{ at: 5, words: ['act', 't-1', '--wait'], answer: { phase: 'done', receipt: { verbs: ['dev:sit'], target: 't-1' } } }, { at: 1, words: ['act', 'x'], answer: { receipt: { verbs: ['dev:walk'] } } }], 2);
  assert.deepEqual(r.map((x) => [x.capability, x.phase]), [['sit:t-1', 'completed']]);
});
