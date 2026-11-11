import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {soulClientManifest, SOUL_CLIENT_MIN} from './soul-client-manifest.ts';

test('the manifest describes the file served, and follows it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-client-')), file = join(dir, 'eden.mjs'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  assert.equal(soulClientManifest(undefined), undefined); assert.equal(soulClientManifest(file), undefined);
  const text = 'const VERSION = "3.1.0";\n'; writeFileSync(file, text);
  assert.deepEqual(soulClientManifest(file), {contract: 'eden-edge/1', version: '3.1.0', bytes: text.length, sha256: createHash('sha256').update(text).digest('hex'), minVersion: SOUL_CLIENT_MIN});
  writeFileSync(file, 'no version here, a little longer');
  assert.equal(soulClientManifest(file), undefined, 'a file that names no version describes nothing');
});

test('the shipping CLI is described', () => {
  const file = fileURLToPath(new URL('../../../tools/world-launcher/soul/eden.mjs', import.meta.url));
  assert.equal(soulClientManifest(file)!.version, /const VERSION = "([0-9.]+)"/.exec(readFileSync(file, 'utf8'))![1]);
});

test('#1875: the skill served beside the CLI is described with it, so upgrade can verify both', t => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-client-')), cli = join(dir, 'eden.mjs'), skill = join(dir, 'skill.md'); t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(cli, 'const VERSION = "3.2.0";\n');
  assert.equal(soulClientManifest(cli, skill)!.skill, undefined, 'no skill file, no skill');
  const text = '---\nname: souls\nmetadata:\n  version: "3.2.0"\n---\n'; writeFileSync(skill, text);
  assert.deepEqual(soulClientManifest(cli, skill)!.skill, {version: '3.2.0', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')});
  writeFileSync(skill, '# a skill that names no version, longer');
  assert.equal(soulClientManifest(cli, skill)!.skill, undefined, 'a skill that names no version is left alone');
});

test('#1875 A1: the shipping skill carries the shipping CLI\'s version', () => {
  const dir = fileURLToPath(new URL('../../../tools/world-launcher/soul/', import.meta.url));
  const m = soulClientManifest(join(dir, 'eden.mjs'), join(dir, 'skill.md'))!;
  assert.equal(m.skill!.version, m.version);
});
