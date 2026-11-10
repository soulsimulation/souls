import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from './conformance.ts';

type PinnedFinding = Omit<Finding, 'field'> & { fields: string[] };
type QualificationGap = { def: string; kind: string; reason: string };
const schemas = new Set(['library-conformance/1', 'library-conformance-integration/1', 'library-conformance-supplement/1', 'catalog-conformance-supplement/1']);
const baselineFile = 'known-20261015.json';

export const findingSignature = (f: Finding) => JSON.stringify([f.def, f.hash, f.field, f.stage, f.code, f.detail]);

/** Every JSON record participates; only the original baseline owns the rendering-gap list. */
export function loadConformanceSupplements(directory: string | URL = new URL('../conformance/', import.meta.url)) {
  const dir = directory instanceof URL ? fileURLToPath(directory) : directory;
  const files = globSync('*.json', { cwd: dir }).sort();
  const allowed = new Set<string>();
  let qualificationGaps: QualificationGap[] | undefined;
  for (const file of files) {
    const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${file}: expected a conformance record`);
    const record = value as Record<string, unknown>;
    assert.ok(typeof record.schema === 'string' && schemas.has(record.schema), `${file}: unsupported conformance schema`);
    assert.ok(Array.isArray(record.findings), `${file}: findings must be an array`);
    for (const value of record.findings) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${file}: invalid finding`);
      const finding = value as Record<string, unknown>;
      for (const key of ['def', 'hash', 'stage', 'code', 'detail']) assert.ok(typeof finding[key] === 'string' && finding[key].length > 0, `${file}: finding.${key} must be a nonempty string`);
      assert.ok(Array.isArray(finding.fields) && finding.fields.length > 0 && finding.fields.every(field => typeof field === 'string' && field.length > 0), `${file}: finding.fields must contain strings`);
      const pin = finding as PinnedFinding;
      for (const field of pin.fields) allowed.add(findingSignature({ ...pin, field }));
    }
    if (record.qualificationGaps !== undefined) {
      assert.ok(Array.isArray(record.qualificationGaps), `${file}: qualificationGaps must be an array`);
      for (const gap of record.qualificationGaps) {
        assert.ok(gap && typeof gap === 'object' && ['def', 'kind', 'reason'].every(key => typeof gap[key] === 'string'), `${file}: invalid qualification gap`);
      }
    }
    if (file === baselineFile) {
      assert.equal(record.schema, 'library-conformance/1', `${file}: baseline schema changed`);
      assert.ok(Array.isArray(record.qualificationGaps), `${file}: missing baseline qualification gaps`);
      qualificationGaps = record.qualificationGaps as QualificationGap[];
    }
  }
  assert.ok(qualificationGaps, `Missing ${baselineFile} rendering-gap baseline`);
  return { files, allowed, qualificationGaps };
}
