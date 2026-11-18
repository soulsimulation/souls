// SA-D7 (#2888): what is heard is a recorded fact, driven by a field or an event, and a tune is content by reference.
//   node --test packages/form-rules/src/sounds.test.ts
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTable, checkTunes, looks, pickTune, soundsOn, tuneAt, tuneLength, tuneNotes, type LookRow, type Tune } from './looks.ts';

const DIR = join(import.meta.dirname, '../cases/looks/kinds');
const kinds = readdirSync(DIR).map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { kind: string; state: Record<string, { type: string }>; looks: { table: LookRow[] } });
const doc = JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/tunes/tunes.json'), 'utf8'));
const tunes: Tune[] = doc.tunes;
const piano = kinds.find((k) => k.kind === 'looks:piano')!;

test('A1: a piano plays its tune while "playing" is set, and stops when it is not', () => {
  const on = looks({ table: piano.looks.table, state: { playing: true }, t_us: 1000000 }), off = looks({ table: piano.looks.table, state: { playing: false } });
  assert.equal(on['@self'].sounds?.length, 1);
  assert.equal(on['@self'].sounds![0].sound, 'tune');
  assert.deepEqual(off, {});
  // the same piano, set and unset again
  assert.deepEqual(looks({ table: piano.looks.table, state: { playing: false } }), off);
});

test('A2: two viewers at the same world time are at the same point of the tune, and hear the same notes', () => {
  const t = pickTune(tunes, 'calm', 'piano:1')!;
  for (const now of [0, 1, 123456789, 98765432100, 4503599627370495 - 1]) {
    const a = { at: tuneAt(t, now, 5000), notes: tuneNotes(t, now, now + 3000000, 5000) }, b = { at: tuneAt(t, now, 5000), notes: tuneNotes(t, now, now + 3000000, 5000) };
    assert.deepEqual(a, b);
    assert.ok(a.at >= 0 && a.at < tuneLength(t));
  }
  // a viewer who arrives late sees the same notes as one who was there: a window of the same loop, whatever its cut
  const whole = tuneNotes(t, 1000000, 30000000), late = tuneNotes(t, 17000000, 30000000);
  assert.deepEqual(whole.filter((n) => n.onset_us >= 17000000), late);
  // the loop repeats exactly
  assert.deepEqual(tuneNotes(t, 0, tuneLength(t)).map((n) => [n.midi, n.len_us]), tuneNotes(t, tuneLength(t), 2 * tuneLength(t)).map((n) => [n.midi, n.len_us]));
  assert.equal(tuneAt(t, tuneLength(t) * 7 + 250000), 250000);
  assert.deepEqual(tuneNotes(t, 0, 0), []);
});

test('A3: a mood tag picks a tune from a list of at least twelve, the same way each time, spread over the things that ask', () => {
  assert.ok(tunes.length >= 12);
  assert.deepEqual(checkTunes(doc), []);
  const moods = [...new Set(tunes.flatMap((t) => t.moods))];
  assert.ok(moods.length >= 12);
  for (const m of moods) {
    const t = pickTune(tunes, m, 'a');
    assert.ok(t?.moods.includes(m), m);
    assert.equal(pickTune(tunes, m, 'a')?.id, t?.id);
  }
  assert.equal(pickTune(tunes, 'sad', 'x')!.id, 'tune:slow_rain');
  assert.equal(pickTune(tunes, 'no-such-mood', 'x'), undefined);
  // two moods carried by two tunes: different pianos land on both
  assert.equal(new Set(Array.from({ length: 20 }, (_, i) => pickTune(tunes, 'lonely', `p${i}`)!.id)).size, 2);
  assert.ok(checkTunes({ tunes: [{ id: 'a b', moods: [], step_us: 0, steps: 2, notes: [[10, 0, 1]] }] }).length >= 4);
});

test('A4: every sounding kind states its reach, and an unstated or wrong one is refused', () => {
  let sounding = 0;
  for (const k of kinds) {
    assert.deepEqual(checkTable(k.looks.table, k.state), [], k.kind);
    for (const r of k.looks.table.filter((r) => r.do === 'sound')) { sounding++; assert.ok(Number.isInteger(r.reach_mm) && r.reach_mm! > 0, k.kind); }
  }
  assert.ok(sounding >= 3);
  const ok = { do: 'sound', sound: 'bell', field: 'x', at: { true: 500 }, reach_mm: 5000 };
  assert.deepEqual(checkTable([ok]), []);
  const bad = (r: object) => checkTable([{ ...ok, ...r }]);
  assert.ok(bad({ reach_mm: undefined }).some((m) => m.includes('reach_mm')));
  assert.ok(bad({ reach_mm: 1.5 }).some((m) => m.includes('reach_mm')));
  assert.ok(bad({ sound: 'kazoo' }).some((m) => m.includes('.sound')));
  assert.ok(bad({ event: 'struck' }).some((m) => m.includes('one of the two')));
  assert.ok(bad({ at: { true: 1500 } }).some((m) => m.includes('loudness')));
  assert.ok(bad({ sound: 'tune' }).some((m) => m.includes('names its tune or its mood')));
  assert.ok(bad({ mood: 'sad' }).some((m) => m.includes('only a tune')));
  assert.ok(bad({ link: 'a b' }).some((m) => m.includes('link')));
  assert.ok(bad({ mode: 'echo' }).some((m) => m.includes('mode')));
  assert.ok(checkTable([{ ...ok, field: undefined, event: 'e', level: 5000, at: undefined }]).some((m) => m.includes('level')));
});

test('an event makes its sound heard once at its stated level; a field does not', () => {
  const gong = kinds.find((k) => k.kind === 'looks:gong')!.looks.table;
  assert.deepEqual(soundsOn(gong, 'struck'), [{ sound: 'bell', loop: false, volume_permille: 800, reach_mm: 40000 }]);
  assert.deepEqual(soundsOn(gong, 'other'), []);
  assert.deepEqual(soundsOn(piano.looks.table, 'playing'), []);
  assert.deepEqual(looks({ table: gong, state: { swing: 0 } }).disc.sounds, undefined);
});

test('a thing that carries sound names its link, and a range field sets the loudness', () => {
  const radio = kinds.find((k) => k.kind === 'looks:radio')!.looks.table;
  const heard = looks({ table: radio, state: { volume: 1000 } }).speaker.sounds![0];
  assert.equal(heard.link, 'link:broadcast');
  assert.equal(heard.volume_permille, 900);
  assert.equal(heard.tune, 'tune:sunday_stroll');
  assert.ok(tunes.some((t) => t.id === heard.tune));
});
