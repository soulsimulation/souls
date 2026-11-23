// The home's guide (Engine v2 R19, #3327). Pairing writes it as one marked block in the folder's AGENTS.md; the
// owner's text before and after it is kept byte for byte, and a second write changes nothing (A1). For one Soul it is
// under 1,300 characters and names only commands this client has (A2). The directory is a stub on this machine; the
// home is under the repository's ignored .local/.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOCAL, OPS } from '../cli/souls.mjs';
import { guideText, writeGuide } from '../home/guide.mjs';
import { pair } from './pair.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(resolve(here, '../../../..'), '.local', `r19-guide-${randomBytes(4).toString('hex')}`);
after(() => rmSync(dir, { recursive: true, force: true }));
const START = '<!-- eden-soul-guide:start -->', END = '<!-- eden-soul-guide:end -->';

/** A directory that approves at once, handing out the grant `soul-<scope>-<n>`. */
async function directory(scope, n) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pair/request') return res.end(JSON.stringify({ code: 'BCDF-GHJK', link: 'x', interval: 1 }));
      res.end(JSON.stringify({ token: `soul-${scope}-${n}.${'cd'.repeat(32)}`, grant: `soul-${scope}-${n}` }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return server;
}
const pairOne = async (home, scope, n = 0) => {
  const server = await directory(scope, n);
  try {
    return await pair({ home, directory: `http://127.0.0.1:${server.address().port}`, world: 'eden', gateway: 'ws://x', device: 'd', label: 'l', unit: 1, sleep: async () => {} });
  } finally { server.close(); }
};

test('A1: pairing writes the guide as a marked block; the text around it is kept byte for byte; a second write changes nothing', async () => {
  const folder = join(dir, 'a1'), home = join(folder, '.souls');
  mkdirSync(folder, { recursive: true });
  const before = '# My project\n\nOwner rules, with a trailing space \n\n';
  const after = '\n\n## Kept after\n\nMore of the owner\'s text.\n';
  writeFileSync(join(folder, 'AGENTS.md'), `${before}${START}\nan older client's guide\n${END}${after}`);
  writeFileSync(join(folder, 'CLAUDE.md'), '@AGENTS.md\n');

  const out = await pairOne(home, 'ab'.repeat(16));
  assert.deepEqual(out.guide, ['AGENTS.md'], 'CLAUDE.md imports AGENTS.md, so it gets no second copy');
  const text = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  const start = text.indexOf(START), end = text.indexOf(END) + END.length;
  assert.equal(text.slice(0, start), before, 'before the block: byte for byte');
  assert.equal(text.slice(end), after, 'after the block: byte for byte');
  assert.match(text.slice(start, end), new RegExp(`- s_${'ab'.repeat(16)}-0 in eden: \`node souls.mjs look\``));
  assert.equal(readFileSync(join(folder, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');

  assert.deepEqual(writeGuide(home), [], 'a second write writes nothing');
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), text);

  // A second Soul paired here: the block names both, and the owner's text is still as it was.
  await pairOne(home, 'ef'.repeat(16), 3);
  const two = readFileSync(join(folder, 'AGENTS.md'), 'utf8');
  assert.ok(two.startsWith(before) && two.endsWith(after));
  assert.match(two, /look --soul s_e/);
  assert.match(two, /Several live here/);
});

test('A1: a folder with no AGENTS.md gets the block alone; a SOULS_HOME that is not .souls writes into itself', async () => {
  const home = join(dir, 'bare');
  await pairOne(home, '12'.repeat(16));
  const text = readFileSync(join(home, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith(`${START}\n# This folder is the home of my Souls`) && text.endsWith(`${END}\n`));
  assert.equal(readFileSync(join(home, 'CLAUDE.md'), 'utf8'), text);
});

test('A2: for one Soul the guide is under 1,300 characters and names only commands this client has', () => {
  const one = guideText([{ id: `s_${'ab'.repeat(16)}-0`, name: 'Oriel', world: 'eden' }]);
  assert.ok(one.length < 1300, `${one.length} characters`);
  const has = new Set([...OPS, ...LOCAL]);
  const named = [...one.matchAll(/node souls\.mjs (\w+)/g)].map((m) => m[1]);
  for (const cmd of ['status', 'look', 'act', 'memory', 'remember']) assert.ok(named.includes(cmd), `names ${cmd}`);
  for (const cmd of named) assert.ok(has.has(cmd), `${cmd} is a command of souls.mjs`);
  assert.doesNotMatch(one, /eden\.mjs|listen|pending|here`|serve/, 'no command of the shipping line');
  if (process.env.R19_REPORT === '1') console.log(`guide for one Soul: ${one.length} characters\n${one}`);
});
