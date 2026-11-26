import test from 'node:test';
import assert from 'node:assert/strict';
import { ends } from './analyze.mjs';

test('ends: each act from its send to its first answer and to its end (receipt, or a refusal after acceptance)', () => {
  const trace = [
    'sent 0 1 1000 eden:walk -', 'first 0 1 1000 1130 accepted', 'ack 0 1 5000',
    'sent 0 2 2000 eden:say -', 'first 0 2 2000 2030 receipt', 'ack 0 2 2030',
    'sent 1 1 1000 eden:take -', 'first 1 1 1000 1040 out-of-reach',
    'sent 1 2 3000 eden:walk -', 'first 1 2 3000 3120 accepted', 'end 1 2 9000 blocked',
    'sent 1 3 4000 eden:walk -', 'first 1 3 4000 4100 accepted', 'open 1 3 4000',
  ].join('\n');
  const e = ends(trace);
  assert.deepEqual([e.acts, e.noEnd], [5, 1]);
  assert.deepEqual(e.byVerb['eden:walk'], { acts: 3, firstP50Ms: 120, firstP99Ms: 130, endP50Ms: 6000, endP99Ms: 6000, noEnd: 1 });
  assert.deepEqual([e.byVerb['eden:say'].endP50Ms, e.byVerb['eden:take'].endP50Ms], [30, 40]);
});
