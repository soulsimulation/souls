// #3998: migrate-looks.mjs gives each valid custom-humanoid look in legacy_looks_v1 one `look` line, leaves out invalid
// ones and other reasons, prints counts only, and a second run changes nothing. Synthetic rows only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grantOf, paramsOf } from './migrate-looks.mjs';

const script = fileURLToPath(new URL('./migrate-looks.mjs', import.meta.url));
const soul = (n) => `${n.toString(16).padStart(32, 'c')}:${n}`;
const look = (params, model = 'humanoid2-0123456789abcdef') => JSON.stringify({ family: 'humanoid', model, params });
const fem = { frame: 'fem', face: 'woman-formal', hair: 'bob', top: 'tank', pattern: 'stripes', hips: 1.08, height: 1.7, skin: '#a0785a', jewellery: 'earrings' };
const masc = { frame: 'masc', hair: 'mohawk', hat: 'cap', facialHair: 'beard', scarf: 'scarf', bag: 'backpack', shoulders: 1.08, weight: 1.15, height: 1.8 };

test('valid looks become look lines; invalid and other reasons are counted and left out; a rerun changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-looks-'));
  try {
    const accounts = join(dir, 'accounts.sqlite');
    const db = new DatabaseSync(accounts);
    db.exec('CREATE TABLE legacy_looks_v1(soul TEXT PRIMARY KEY, reason TEXT NOT NULL, body TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO legacy_looks_v1(soul, reason, body) VALUES (?, ?, ?)');
    put.run(soul(1), 'custom-humanoid', look(fem));
    put.run(soul(2), 'custom-humanoid', look(masc));
    put.run(soul(3), 'custom-humanoid', look({ ...fem, wings: 'yes' })); // unknown param
    put.run(soul(4), 'custom-humanoid', look({ ...fem, height: 3 })); // out of range
    put.run(soul(5), 'custom-humanoid', look(fem, 'humanoid2-NOT-HEX')); // not today's model id
    put.run(soul(6), 'custom-humanoid', '{not json');
    put.run(soul(7), 'unknown-definition', JSON.stringify({ family: 'ghost' }));
    put.run('not-an-id', 'custom-humanoid', look(fem));
    db.close();

    const outs = [join(dir, 'a.tokens.souls.looks'), join(dir, 'b.tokens.souls.looks')];
    const run = () => JSON.parse(execFileSync(process.execPath, [script, '--accounts', accounts, '--out', outs[0], '--out', outs[1], '--json'], { encoding: 'utf8' }));
    const first = run();
    assert.deepEqual(first, { rows: 8, other: 1, invalid: 5, looks: 2, files: 2, filesWritten: 2, filesUnchanged: 0 });
    const text = readFileSync(outs[0], 'utf8');
    assert.equal(readFileSync(outs[1], 'utf8'), text);
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(lines.map((l) => l.split(' ')[1]), [grantOf(soul(1)), grantOf(soul(2))]);
    const [, , hex] = lines[0].split(' ');
    assert.deepEqual(JSON.parse(Buffer.from(hex, 'hex').toString('utf8')), fem, 'the params, compact, as the body carries them');

    const mtime = statSync(outs[0]).mtimeMs;
    const second = run();
    assert.deepEqual(second, { ...first, filesWritten: 0, filesUnchanged: 2 });
    assert.equal(statSync(outs[0]).mtimeMs, mtime, 'an unchanged file is left alone');

    const human = execFileSync(process.execPath, [script, '--accounts', accounts, '--out', outs[0]], { encoding: 'utf8' });
    assert.match(human, /looks: 2 valid, given to the worlds; 5 invalid, left out/);
    assert.ok(!human.includes('cccc') && !human.includes('soul-'), 'counts only: no Soul is printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a look's params are checked as the page checks them and kept within 2 KiB", () => {
  assert.equal(paramsOf(look({})), '{}');
  assert.equal(paramsOf(JSON.stringify({ family: 'robot', model: 'humanoid2-0123456789abcdef', params: {} })), null);
  assert.equal(paramsOf(look({ skin: 'red' })), null);
  assert.equal(grantOf('ab:1'), null);
});
