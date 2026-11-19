// Read-only R15b extraction: complete the original third-run assertions using its retained actual artifacts.
// node v2/client/src/schedule/retained-proof.mjs <fixture-dir> <run-transcript>
// No process, service, clock or credential is opened; only the named synthetic run's log/state/trace/schedule.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, idText } from '../brief/copy.mjs';
import { clockOfFields, worldNow } from '../clock/clock.mjs';
import { encode } from '../history/day.mjs';
import { readSchedule } from './schedule.mjs';
import { calendarOf, nextWorldTime, realDeadline } from './world.mjs';
import { durableReceipt } from './durable-proof.mjs';

const [dir, transcriptFile] = process.argv.slice(2);
assert.ok(dir && transcriptFile, 'provide the retained fixture directory and original run transcript');
const worldFile = join(dir, 'w/log'), runtime = join(dir, 'h/souls/s_r15b/runtime');
// Invoke the unchanged actual test record reader, including its canonical header/chained CRC assertions. Importing
// the test itself would start a new journey, so only its two pure reader declarations are evaluated here.
const source = readFileSync(new URL('./world.test.mjs', import.meta.url), 'utf8');
const readers = source.slice(source.indexOf('function crc32c('), source.indexOf('/** Only a fresh'));
const records = new Function('readFileSync', 'assert', 'decode', `${readers}; return records;`)(readFileSync, assert, decode);
const parts = records(worldFile), effects = parts.flatMap((p) => p.get(2) ?? []);
const stateFile = join(runtime, 'daemon.json'), traceFile = join(runtime, 'trace.jsonl');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const trace = readFileSync(traceFile, 'utf8').trim().split('\n').map(JSON.parse);
const schedule = readSchedule(join(dir, 'h/souls/s_r15b/memory/schedule.md'));
assert.deepEqual(schedule.bad, []);
assert.equal(schedule.entries.length, 2);
const [pub, shop] = schedule.entries;
assert.equal(pub.world, '08:00', 'the exact literal pub time');
const root = idText(effects[0].get(6)), rootFields = new Map(), shopFields = new Map();
const shopId = idText(effects.flatMap((e) => e.get(7) ?? [])
  .find((c) => c.get(1) === 1 && c.get(6)?.get(27) === 'testworld:square').get(2));
const mappings = [];
let calendarBefore;
for (const effect of effects) {
  for (const change of effect.get(7) ?? []) {
    if (change.get(1) !== 4) continue;
    const id = idText(change.get(2));
    if (id === root) rootFields.set(change.get(3), change.get(4));
    if (id === shopId) shopFields.set(change.get(3), change.get(4));
  }
  if (rootFields.has(64) && !calendarBefore) calendarBefore = [60, 61, 62, 63, 64].map((f) => [f, rootFields.get(f)]);
  if ((effect.get(7) ?? []).some((c) => c.get(1) === 4 && c.get(3) === 68 && idText(c.get(2)) === root)) mappings.push(clockOfFields(rootFields));
}
assert.deepEqual([60, 61, 62, 63, 64].map((f) => [f, rootFields.get(f)]), calendarBefore, 'published calendar survives restart');
assert.equal(mappings.length, 2);
const [before, after] = mappings;
assert.deepEqual(before, { world: 0, real: 0, rate: [1, 1] });
assert.deepEqual(after.rate, [2, 1]);
assert.equal(after.world, after.real, 'the real served rate change is continuous');
const transcript = readFileSync(transcriptFile, 'utf8');
const announced = [...transcript.matchAll(/worldd: clock world (-?\d+) real (-?\d+) rate (\d+)\/(\d+)/g)]
  .map((m) => ({ world: Number(m[1]), real: Number(m[2]), rate: [Number(m[3]), Number(m[4])] }));
assert.deepEqual(announced, mappings, 'the durable mappings are the actual served mappings');
const cal = calendarOf({ roots: () => '{"root":"retained"}', record: () => encode(new Map([[6, rootFields]])) });
const target = nextWorldTime('08:00', cal, trace[0].t * 1000), hours = shopFields.get(81);
assert.equal(rootFields.get(60), 86_400);
assert.deepEqual(rootFields.get(62), [[0, 0]]);
assert.equal(rootFields.get(61) + target, 8 * 3_600_000_000, 'the published civil origin resolves to literal 08:00');
assert.deepEqual(hours, [[1, target + 2_000_000, target + 3_600_000_000]]);
assert.equal(shop.worldUs, hours[0][1], 'the second trigger is the actual published opening');
assert.equal(state.schedule.targets[pub.key].worldUs, target, 'the occurrence persisted through the rate change');
assert.ok(state.schedule.targets[pub.key].realMs < realDeadline(before, target), 'rate two advanced the real deadline');
assert.equal(state.sequence, 2);
assert.deepEqual(state.unanswered, []);
assert.deepEqual(state.schedule.missed, []);
assert.equal(state.schedule.dropped, 0);
const meta = JSON.parse(readFileSync(join(dir, 'w/world.json'), 'utf8'));
const actor = `${meta.souls_scope}-1`; // synthetic seed metadata, never a credential/token file
const triggers = [];
for (const [e, at] of [[pub, target], [shop, hours[0][1]]]) {
  const sequence = state.schedule.marks[e.key].sequence;
  assert.equal(state.schedule.targets[e.key].worldUs, at);
  assert.equal(state.schedule.targets[e.key].realMs, realDeadline(after, at));
  const sends = trace.filter((r) => r.k === 'send' && r.seq === sequence);
  assert.equal(sends.length, 1, 'exactly one actual send per occurrence');
  assert.ok(sends[0].t * 1000 >= after.real, 'use the contemporaneous post-restart mapping');
  const lateWorldUs = worldNow(after, sends[0].t * 1000) - at;
  assert.ok(lateWorldUs >= 0 && lateWorldUs <= 50_000, 'the original one-world-tick SEND bar');
  assert.ok(trace.some((r) => r.k === 'answer' && r.seq === sequence && r.achieved === true && r.cause === 'accepted-first'));
  const receipt = durableReceipt(parts, actor, sequence);
  triggers.push({ id: e.id, targetOffsetWorldUs: at - target, sends: sends.length, lateWorldUs,
    answerKind: 1, sequence, receiptEntries: receipt.entries, exactActorIntentCauses: true,
    completionAfterTargetWorldUs: Math.max(...receipt.effects.map((effect) => effect.get(2))) - at });
}
assert.equal(trace.filter((r) => r.k === 'send').length, 2, 'no extra scheduled sends');
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(JSON.stringify({ schema: 'r15b-retained/1', measuredCommit: '7c32b9905357c7edc8e20deb5b489da6a29b70ea',
  originalRun: 3, originalRunStatus: 'failed in durable actor decoder', retainedAssertions: 'PASS', additionalServedRuns: 0,
  publishedCalendar: { daySeconds: rootFields.get(60), localPub: pub.world, openingOffsetWorldUs: shop.worldUs - target },
  publishedRates: mappings.map((m) => m.rate), durableRecords: parts.length, headerAndChainedCrc: 'PASS', triggers,
  digests: { worldLog: digest(worldFile), trace: digest(traceFile), runtimeState: digest(stateFile), originalTranscript: digest(transcriptFile) } }, null, 2));
