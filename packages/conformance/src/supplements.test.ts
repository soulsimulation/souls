import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreLibrary } from '@souls/world-compiler';
import { findingSignature, loadConformanceSupplements } from './supplements.ts';

const records = new URL('../conformance/', import.meta.url);
const finding = { def: 'fixture-new-family@1', hash: 'fixture-hash', field: 'defaults', stage: 'gallery-budget', code: 'triangles', detail: '401 > 400' };
const pin = { ...finding, fields: [finding.field] };
const supplement = { schema: 'catalog-conformance-supplement/1', note: 'Isolated discovery fixture.', findings: [pin] };
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(records, dir, { recursive: true });
  return dir;
}

test('every existing JSON record loads without changing definition/library bytes or the gap baseline', () => {
  const library = coreLibrary(), before = JSON.stringify(library.all());
  const loaded = loadConformanceSupplements();
  assert.deepEqual(loaded.files, readdirSync(records).filter(name => name.endsWith('.json')).sort());
  assert.deepEqual(loaded.qualificationGaps, JSON.parse(readFileSync(new URL('known-20261015.json', records), 'utf8')).qualificationGaps);
  for (const file of loaded.files) {
    const record = JSON.parse(readFileSync(new URL(file, records), 'utf8'));
    for (const pin of record.findings) for (const field of pin.fields) assert.ok(loaded.allowed.has(findingSignature({ ...pin, field })), `${file}: finding was not loaded`);
  }
  assert.equal(JSON.stringify(library.all()), before);
});

test('a newly added valid supplement is discovered without source edits; unrelated or altered findings remain unlisted', t => {
  const dir = fixture(t), before = loadConformanceSupplements(dir);
  assert.equal(before.allowed.has(findingSignature(finding)), false);
  writeFileSync(join(dir, 'new-family.json'), JSON.stringify(supplement));
  const after = loadConformanceSupplements(dir);
  assert.deepEqual(after.files, [...before.files, 'new-family.json'].sort());
  assert.ok(after.allowed.has(findingSignature(finding)));
  for (const key of ['def', 'hash', 'field', 'stage', 'code', 'detail'] as const) assert.equal(after.allowed.has(findingSignature({ ...finding, [key]: 'not-documented' })), false, key);
  assert.deepEqual(after.qualificationGaps, before.qualificationGaps);
});

test('new JSON files cannot evade schema and finding validation by being absent from an allowlist', t => {
  const dir = fixture(t), path = join(dir, 'not-in-a-handwritten-list.json');
  for (const invalid of [null, [], { ...supplement, schema: 'unknown/1' }, { ...supplement, findings: {} }, { ...supplement, findings: [{ ...pin, fields: 'defaults' }] }, { ...supplement, findings: [{ ...pin, hash: 7 }] }, { ...supplement, qualificationGaps: [{ def: 'fixture' }] }]) {
    writeFileSync(path, JSON.stringify(invalid));
    assert.throws(() => loadConformanceSupplements(dir));
  }
  writeFileSync(path, '{invalid JSON');
  assert.throws(() => loadConformanceSupplements(dir), SyntaxError);
});
