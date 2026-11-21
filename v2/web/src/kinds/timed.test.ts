// The page's timed values against SA-F5a's shared cases (packages/form-rules/cases/timed), read as data (#3871).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossing, valueAt } from './timed.ts';

const DIR = join(import.meta.dirname, '../../../../packages/form-rules/cases/timed');
const KINDS = join(import.meta.dirname, '../../../../packages/form-rules/cases/kinds/test');
// A whole number beyond a safe integer is read as a big integer, as the cases' own reader (form-rules load.ts) reads it.
const parse = (text: string) => JSON.parse(text, ((_k: string, v: unknown, c?: { source?: string }) =>
  typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(c?.source ?? '') ? BigInt(c!.source!) : v) as (k: string, v: unknown) => unknown);
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

for (const file of readdirSync(DIR)) {
  const doc = parse(readFileSync(join(DIR, file), 'utf8'));
  for (const c of doc.cases) {
    test(`timed ${file}: ${c.name}`, () => {
      const kind = JSON.parse(readFileSync(join(KINDS, `${c.kind.split(':')[1]}.json`), 'utf8'));
      const def = kind.state[c.field];
      for (const [now, want] of c.values as [unknown, unknown][]) assert.equal(show(valueAt(def, c.stored, now)), show(want), `at ${show(now)}`);
      for (const x of (c.crossings ?? []) as Record<string, unknown>[]) {
        const { from_us, expect, ...level } = x;
        assert.equal(show(crossing(def, c.stored, level, from_us)), show(expect), show(x));
      }
    });
  }
}
