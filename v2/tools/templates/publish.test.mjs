// A template published from a seed's public support (`templates`, installed as publish-template) is one the same
// build's `worldd fork --template` accepts: its sealed header's kind pins are the seed's boot pins. The world is a rack
// bay and an upright, kinds whose entries join parts, so their pins follow their entries (0.135): published from the
// facts alone (`import_eden::load`), those pins differed and the fork was refused `template-pins-mismatch` (0.142, the
// Mars camp's rack, shade and loading yards). Drives the built programs, as the ops tests do:
//   cargo build -p worldd -p templates && node --test tools/templates/publish.test.mjs   (from v2/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const V2 = resolve(import.meta.dirname, '../..'), KINDS = resolve(V2, '../content/kinds');
const BIN = join(process.env.CARGO_TARGET_DIR ? resolve(V2, process.env.CARGO_TARGET_DIR) : join(V2, 'target'), 'debug');

/** A rack bay and an upright standing on the ground: no slots in the facts (import-eden's joining fixture). */
const FACTS = {
  format: 'souls/import-eden/1',
  kinds: [
    { ref: 't-bay@1', hash: 'aa', name: 'mars:rack_bay', form: 'point' },
    { ref: 't-upright@1', hash: 'bb', name: 'mars:rack_upright', form: 'point' },
  ],
  things: [
    { id: 'e_bay', def: 't-bay@1', ref: 't-bay@1', parent: null, pose: [0, 0, 0, 0], world: [0, 0, 0, 0], scale_ppm: 1000000 },
    { id: 'e_upright', def: 't-upright@1', ref: 't-upright@1', parent: null, pose: [3000, 0, 0, 0], world: [3000, 0, 0, 0], scale_ppm: 1000000 },
  ],
  doors: [],
  places: [],
  ground: { tileM: 2, tiles: [{ tx: 0, tz: 0, heights: 'AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA', classes: 'AAECAw==' }] },
  bake: { things: 2 },
  byRef: { 't-bay@1': 1, 't-upright@1': 1 },
};

const run = (program, args) => spawnSync(join(BIN, program), args, { encoding: 'utf8', timeout: 120_000 });

test('a template published from a seed forks with the same build, and is never written over', () => {
  for (const p of ['worldd', 'templates']) assert.ok(existsSync(join(BIN, p)), `${join(BIN, p)}: cargo build -p worldd -p templates first`);
  const d = mkdtempSync(join(tmpdir(), 'tpl-publish-'));
  try {
    const facts = join(d, 'facts.json'), entries = join(d, 'entries'), support = join(d, 'support'), out = join(d, 'out');
    writeFileSync(facts, JSON.stringify(FACTS));
    mkdirSync(entries);
    for (const f of readdirSync(join(KINDS, 'construction')).filter((f) => f.endsWith('.json'))) copyFileSync(join(KINDS, 'construction', f), join(entries, f));
    copyFileSync(join(KINDS, 'body/humanoid.json'), join(entries, 'humanoid.json'));

    const seeded = run('worldd', ['seed', '--facts', facts, '--entries', entries, '--souls', '0', '--at', '0,0', '--dir', support]);
    assert.equal(seeded.status, 0, `seed: ${seeded.stderr}`);

    const published = run('templates', [facts, out, '--name', 'yard', '--support', support]);
    assert.equal(published.status, 0, `publish: ${published.stderr}`);
    assert.match(published.stdout, /^template yard: lineage [0-9a-f]{32}/);
    for (const f of ['template', 'header', 'boot', 'facts.json', 'entry.json', 'ckpt']) assert.ok(existsSync(join(out, 'yard', f)), f);
    assert.ok(existsSync(join(out, 'yard.source')), 'its source checkpoint beside it');
    assert.ok(!existsSync(join(out, '.yard.partial')), 'renamed into place when whole');
    const again = run('templates', [facts, out, '--name', 'yard', '--support', support]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /template-exists/);
    assert.match(run('templates', [facts, out, '--name', 'Yard', '--support', support]).stderr, /template-name-invalid/);

    const template = join(out, 'yard'), forked = join(d, 'forked');
    const fork = run('worldd', ['fork', '--from', join(template, 'ckpt'), '--template', template, '--to', forked, '--through', `${'ab'.repeat(16)}:1`, '--scope', 'cd'.repeat(16)]);
    assert.equal(fork.status, 0, `fork: ${fork.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(forked, 'world.json'), 'utf8')).fork, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
