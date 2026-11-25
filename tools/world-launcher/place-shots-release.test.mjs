// deploy/place-shots.sh against a fake origin (its world list) and a fake drawer, copying into a local folder (--dest)
// in place of the host: which worlds it takes, that --dry-run writes nothing, that pictures arrive with their index,
// and that a second run draws nothing new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, 'deploy/place-shots.sh');

test('place-shots.sh draws each moved world\'s missing pictures once and copies them with their index', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'place-shots-release-'));
  const dest = join(tmp, 'host'), cache = join(tmp, 'cache'), draws = join(tmp, 'draws.log');
  // the drawer: counts its runs; draws one picture for its world unless the index already names it, or --plan
  const drawer = join(tmp, 'draw.mjs');
  writeFileSync(drawer, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), out = a[a.indexOf('--out') + 1], page = a[a.indexOf('--page') + 1];
const index = existsSync(out + '/index.json') ? JSON.parse(readFileSync(out + '/index.json', 'utf8')) : { schema: 'place-shots/1', shots: {} };
const missing = index.shots.e_1 ? 0 : 1;
console.error('1 places, ' + missing + ' to draw');
if (a.includes('--plan')) process.exit(0);
appendFileSync(${JSON.stringify(draws)}, page + ' ' + missing + '\\n');
if (missing) { writeFileSync(out + '/' + 'a'.repeat(64) + '.webp', 'RIFF'); index.shots.e_1 = { target: 't', sha: 'a'.repeat(64), bytes: 4 }; writeFileSync(out + '/index.json', JSON.stringify(index)); }
console.log(JSON.stringify({ places: 1, drawn: missing }));
`);
  const server = createServer((req, res) => {
    if (req.url === '/__sim/worlds.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ worlds: [{ slug: 'eden', engine: 'new' }, { slug: 'old-one', engine: 'old' }, { slug: 'mars', engine: 'new' }] })); return; }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const env = { ...process.env, PLACE_SHOTS_ORIGIN: `http://127.0.0.1:${server.address().port}`, PLACE_SHOTS_CACHE: cache, PLACE_SHOTS_DRAW: `${process.execPath} ${drawer}`, SIM_DEPLOY_ENV: join(tmp, 'none.env') };
  try {
    const dry = await run('bash', [SCRIPT, '--dry-run', '--dest', dest], { env });
    assert.match(dry.stdout, /== eden[\s\S]*1 to draw[\s\S]*== mars/); assert.doesNotMatch(dry.stdout, /old-one/, 'only moved worlds');
    assert.equal(existsSync(dest), false, '--dry-run copies nothing'); assert.equal(existsSync(draws), false, '--dry-run draws nothing');

    const first = await run('bash', [SCRIPT, '--dest', dest], { env });
    assert.match(first.stdout, /done$/m);
    for (const slug of ['eden', 'mars']) {
      assert.deepEqual(readdirSync(join(dest, slug)).sort(), ['a'.repeat(64) + '.webp', 'index.json'], slug);
      assert.equal(JSON.parse(readFileSync(join(dest, slug, 'index.json'), 'utf8')).shots.e_1.sha, 'a'.repeat(64));
    }
    // a second run, from a fresh cache: the host's index comes back first, so nothing is drawn again
    const again = await run('bash', [SCRIPT, '--slugs', 'eden', '--dest', dest], { env: { ...env, PLACE_SHOTS_CACHE: join(tmp, 'cache2') } });
    assert.match(again.stdout, /0 to draw/);
    assert.deepEqual(readFileSync(draws, 'utf8').trim().split('\n').map((l) => l.split(' ')[1]), ['1', '1', '0']);
    await assert.rejects(run('bash', [SCRIPT, '--slugs', 'Bad Slug', '--dest', dest], { env }), /--slugs/);
  } finally { server.close(); }
});
