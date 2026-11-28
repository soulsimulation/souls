// The new-engine playtest world and seats (0.135 P1): the parts that need no running world. The world itself is run by
// smoke.mjs (`node tools/playtest/arena/new-engine/smoke.mjs`).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addresses, runArgs, WORLD } from './world.mjs';
import { lastJson, pairArgs, seatEnv } from './seat.mjs';
import { noOldServer } from './smoke.mjs';
import { frontDoor, genesisFor, templateName, withRoute, bindCanonicalAppearance, canonicalAppearanceNamed } from './old-page.mjs';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const routes = { schema: 'souls/world-routes/1', worlds: { dev: { gateway: 'http://127.0.0.1:7802', stream: '/s/w/dev/x/', history: '/s/w/dev/history/', canonical: true } } };
  // the slug's own name in its stream's path (the page's world name, the one an agent pairs with); dev stays routed
  const routed = withRoute(routes, 'my-hello-hamlet').worlds;
  assert.deepEqual(routed['my-hello-hamlet'], { gateway: 'http://127.0.0.1:7802', stream: '/s/w/my-hello-hamlet/x/', history: '/s/w/my-hello-hamlet/history/', canonical: false });
  assert.deepEqual(routed.dev, routes.worlds.dev);
  assert.ok(frontDoor('root * /srv/sim-worlds/production/apps/web/dist', { base: 'http://127.0.0.1:9000', launcher: 1, directory: 'd', origin: 'o', web: '/web', slugs: '/s', caddyDir: '/c' }).endsWith('apps/web/dist'), '/pair from this checkout\'s build');
  assert.equal(templateName('worlds/templates/hello-hamlet.json'), 'hello-hamlet');
});

test("a cast's and a battery's old words in the new client's, and what the stream says back", async () => {
  const { newWords, placePathOf, mailboxSoul } = await import('./director.mjs');
  const { placeIds, receiptsOf, kindName } = await import('./battery.mjs');
  assert.deepEqual(newWords(['act', 'walk to the pond hall', '--wait', '100']), ['act', '?the pond hall', '--wait']);
  assert.deepEqual(newWords(['act', 'walk:lab-presentation-hall', '--wait', '60']), ['act', '?lab-presentation-hall', '--wait']);
  assert.deepEqual(newWords(['act', '{{prev.found[0].act}}']), ['act', '!{{prev.found[0].id}}', '--wait'], 'the found thing\'s own offer, waited for');
  assert.deepEqual(newWords(['act', 'walk:pond']), ['act', '?pond', '--wait'], 'an act waits for the world\'s verdict');
  const { offerOf } = await import('./director.mjs');
  const seat = (offers) => ({ cli: async (...w) => (w[0] === 'inspect' ? { offers } : null) });
  assert.equal(await offerOf(seat([{ name: 'walk', act: 'walk:t-1' }, { name: 'sit', act: 'sit:t-1' }]), 't-1'), 'sit:t-1');
  assert.equal(await offerOf(seat([{ name: 'walk', act: 'walk:t-1' }]), 't-1'), 't-1', 'a thing that offers only a walk is walked to');
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

test("whatson-interest: a notice board in the genesis, and a notice's interest read from the stream's links", async () => {
  const { placeBoard } = await import('./battery.mjs');
  const { calendarKind } = await import('./director.mjs');
  const { linksOf } = await import('../../observer/new-engine/stream.mjs');
  const facts = placeBoard({ kinds: [], things: [] }, { name: 'the green notice board', at: [4, 3], yaw: 90 });
  assert.equal(facts.kinds[0].name, 'eden:notice_board', 'the board is of the notice board entry\'s kind');
  assert.deepEqual(facts.things[0].pose, [4000, 0, 3000, 90000]);
  assert.equal(facts.things[0].name, 'the green notice board');
  assert.equal(placeBoard(facts, { at: [0, 0] }).kinds.length, 1, 'one kind row for any number of boards');
  const scope = Uint8Array.from([0xab, 0x12]), audience = new Map([[1, 1]]);
  const record = new Map([[1, [scope, 5]], [2, 'eden:calendar_entry@1220'], [9, [[2, 'eden:poster@1', [scope, 2], audience], [3, 'eden:interested@1', [Uint8Array.from([0xcd]), 0], audience], 'not a link']]]);
  assert.deepEqual(linksOf(record), [{ type: 'eden:poster', end: 'ab12-2' }, { type: 'eden:interested', end: 'cd-0' }]);
  assert.deepEqual(linksOf(new Map([[1, [scope, 1]]])), [], 'a record with no links');
  assert.ok(calendarKind('eden:calendar_entry@1220ab') && !calendarKind('eden:notice_board@1'));
});


test('canonical appearance binds only the ordinary boot world without changing other bindings', t => {
 const scratch=new URL('../../../../.local/appearance-binding-',import.meta.url);mkdirSync(new URL('../../../../.local/',import.meta.url),{recursive:true});
 const dir=mkdtempSync(scratch);t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'binding.json');
 const original={worlds:[{canonicalSlug:'meal',oldWorldId:'meal-1'},{canonicalSlug:'other',oldWorldId:'other-1'}]};writeFileSync(file,JSON.stringify(original));
 const appearance={file:join(dir,'public.json'),sha256:'a'.repeat(64),world:'meal',stream:'/s/meal/'};
 assert.equal(canonicalAppearanceNamed('{"v2Stream":"/s/meal/"}',appearance),false,'old stream config alone is not ready');
 const descriptor={url:`/w/meal/v2/appearance/${appearance.sha256}.json`,sha256:appearance.sha256,world:'meal',stream:'/s/meal/'};
 assert.equal(canonicalAppearanceNamed(JSON.stringify({v2Appearance:descriptor}),appearance),true);assert.equal(canonicalAppearanceNamed(JSON.stringify({v2Appearance:{...descriptor,stream:'/s/stale/'}}),appearance),false);
 bindCanonicalAppearance(file,'meal',appearance);const bound=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(bound.worlds[0].appearance,appearance);assert.deepEqual(bound.worlds[1],original.worlds[1]);
 assert.throws(()=>bindCanonicalAppearance(file,'other',appearance),/appearance-binding/);assert.throws(()=>bindCanonicalAppearance(file,'absent',appearance),/appearance-binding/);
});
