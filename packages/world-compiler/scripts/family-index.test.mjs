import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {CORE, checkFamilyIndex, renderFamilyIndex} from './family-index.mjs';
import {FAMILY_KITS} from '../src/core-kit/index.ts';
import {FAMILY_KITS as historical} from '../src/core-kit/legacy.ts';

test('checked static index rebuilds without writes and preserves the historical corpus prefix', () => {
  const before = readFileSync(join(CORE, 'index.ts'));
  assert.equal(checkFamilyIndex(), true);
  assert.deepEqual(readFileSync(join(CORE, 'index.ts')), before);
  assert.deepEqual(FAMILY_KITS.slice(0, historical.length), historical);
  assert.equal(createHash('sha256').update(JSON.stringify(historical)).digest('hex'), '5e0c95e6cbdc63bb889df639378785204ad1539fb2eaaefc9c286a691a9753b8');
});

test('new family modules are discovered, ordered and actually imported; stale checks never write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'core-family-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const core = join(root, 'core-kit'); mkdirSync(join(core, 'families'), {recursive: true});
  writeFileSync(join(core, 'legacy.ts'), "export const FAMILY_KITS = [{name:'legacy'}];\n");
  writeFileSync(join(root, 'core-mesh-lods.json'), '{}');
  const output = join(core, 'index.ts'); writeFileSync(output, renderFamilyIndex(core));
  const before = readFileSync(output);
  writeFileSync(join(core, 'families/zebra.family.ts'), "export default [{name:'zebra',make:{kind:'gen'}}];\n");
  writeFileSync(join(core, 'families/amber.family.ts'), "export default [{name:'amber',make:{kind:'gen'}}];\n");
  writeFileSync(join(core, 'families/notes.txt'), 'not a family');
  assert.equal(checkFamilyIndex(core), false);
  assert.deepEqual(readFileSync(output), before);
  writeFileSync(output, renderFamilyIndex(core));
  assert.equal(checkFamilyIndex(core), true);
  const built = await import(pathToFileURL(output).href);
  assert.deepEqual(built.FAMILY_KITS.map(def => def.name), ['legacy', 'amber', 'zebra']);
});
