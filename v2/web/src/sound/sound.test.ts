// V21 (#2765): the world heard, as a function of the record and the time. A1's timing is measured on the page
// (`v2sound.lags()`); these check what decides it: the rows read from a part, where a sound starts and how far into
// it a moment is, footsteps from samples, the cap, the switch remembered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from 'cborg';
import { happenedIn, happenedInPart, unpack } from './record.ts';
import { heardAt, KINDS, lastingOf, MAX_SHOTS, soundsOf, Steps, STRIDE, type Sounding } from './plan.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { loop, LOOP_SECONDS, shot, SHOTS } from './synth.ts';
import { lags } from './sound.ts';

const id = (n: number) => [new Uint8Array([0xab, 0xcd]), n];
const door = 'abcd.7', body = 'abcd.9', ground = 'abcd.1';
const kinds: Record<string, string> = { [door]: 'core:door@1', [ground]: 'eden:ground@1' };
const entry = (at: number, node: number, changes: unknown[], events?: unknown[]) =>
  new Map<number, unknown>([[1, 0], [2, at], [6, id(node)], [7, changes], ...(events ? [[8, events] as [number, unknown]] : [])]);
const set = (node: number, field: number, to: unknown) => new Map<number, unknown>([[1, 4], [2, id(node)], [3, field], [4, to]]);
const here = (): [number, number, number] => [0, 0, 0];

test('unpack reads replica\'s packing: literals, a match, the end', () => {
  const abc = [...'abc'].map((c) => c.charCodeAt(0));
  assert.equal(new TextDecoder().decode(unpack(new Uint8Array([12, 3, ...abc, 6, 3, 0, 0]))), 'abcabcabcabc');
  assert.throws(() => unpack(new Uint8Array([12, 3, ...abc, 6, 4, 0, 0])), /outside/);
});

test('a part\'s rows: each field set and named event at its entry\'s time', () => {
  const entries = [entry(1_000_000, 7, [set(7, 6, 1)]), entry(1_500_000, 9, [], [new Map([[1, 'souls:seated']])]), entry(2_000_000, 7, [set(7, 6, 0)])];
  const rows = happenedIn(entries);
  assert.deepEqual(rows, [{ at: 1_000_000, node: door, field: 6, to: 1 }, { at: 1_500_000, node: body, name: 'souls:seated' }, { at: 2_000_000, node: door, field: 6, to: 0 }]);
  const file = encode(new Map<number, unknown>([[1, 0], [6, packed(encode(new Map<number, unknown>([[1, new Uint8Array(32)], [2, entries]])))]]));
  assert.deepEqual(happenedInPart(file), rows);
  const s = soundsOf(rows, (n) => kinds[n]);
  assert.deepEqual(s.map((x) => [x.at, x.shot.sound]), [[1_000_000, 'door-open'], [1_500_000, 'thud'], [2_000_000, 'door-shut']]);
});

/** Literals only, which unpack reads as replica packs them. */
function packed(raw: Uint8Array): Uint8Array {
  const v = (n: number) => { const o: number[] = []; while (n >= 0x80) (o.push((n & 0x7f) | 0x80), (n >>>= 7)); o.push(n); return o; };
  return new Uint8Array([...v(raw.length), ...v(raw.length), ...raw, 0]);
}

test('A1: a sound is heard from its world time, the same live and in replay', () => {
  const shots = soundsOf([{ at: 5_000_000, node: door, field: 6, to: 1 }], (n) => kinds[n]);
  assert.deepEqual(heardAt(4_700_000, 200_000, [0, 0, 0], shots, [], here), [], 'not yet');
  const [h] = heardAt(4_850_000, 200_000, [0, 0, 0], shots, [], here);
  assert.equal(h.at, 5_000_000, 'scheduled at its time, ahead of it');
  assert.equal(h.offset, 0);
  // Replay reads the same rows from a bundle; asked the same time, the plan is the same.
  assert.deepEqual(heardAt(4_850_000, 200_000, [0, 0, 0], soundsOf([{ at: 5_000_000, node: door, field: 6, to: 1 }], (n) => kinds[n]), [], here), [h]);
});

test('A2: a seek into a sound starts it part-way; a finished one stays silent', () => {
  const shots = soundsOf([{ at: 5_000_000, node: door, field: 6, to: 1 }], (n) => kinds[n]);
  const [mid] = heardAt(5_400_000, 0, [0, 0, 0], shots, [], here);
  assert.equal(mid.offset, 0.4, 'heard from 0.4 s in');
  assert.deepEqual(heardAt(5_000_000 + SHOTS['door-open'] * 1e6, 0, [0, 0, 0], shots, [], here), [], 'ended');
  assert.deepEqual(heardAt(60_000_000, 0, [0, 0, 0], shots, [], here), []);
  // A loop's phase is world time modulo its length: any way of reaching a moment hears the same point of it.
  const fountain = lastingOf('f', 'core:fountain@3', [3, 0, 0]);
  const [a] = heardAt(9_500_000, 0, [0, 0, 0], [], fountain, here);
  assert.equal(a.loop, true);
  assert.ok(Math.abs(a.offset - (9.5 % LOOP_SECONDS)) < 1e-9);
});

test('footsteps where a walking body\'s path crosses each stride, timed between its samples', () => {
  const steps = new Steps();
  const walk = (at: number, x: number) => [body, ground, null, at, x, 0, 0] as const;
  // 1.4 m/s for 2 s: four strides of 0.7 m.
  const out = steps.add([walk(0, 0), walk(1_000_000, 1_400_000), walk(2_000_000, 2_800_000)]);
  assert.deepEqual(out.map((s) => s.at), [500_000, 1_000_000, 1_500_000, 2_000_000]);
  assert.deepEqual(out[0].local, [STRIDE, 0, 0]);
  assert.equal(out[0].node, ground);
  assert.deepEqual(steps.add([walk(2_100_000, 900_000_000)]), [], 'a cut steps nothing');
});

test('far sources give way first: a crowd is the nearest few footsteps', () => {
  const crowd: Sounding[] = [];
  for (let i = 0; i < 1000; i++) crowd.push({ key: `s${i}`, at: 1_000_000, node: `n${i}`, shot: { sound: 'step', radius: 14, volume: 0.3 }, variant: 0 });
  const heard = heardAt(1_000_000, 0, [0, 0, 0], crowd, [], (n) => [Number(n.slice(1)) * 0.01, 0, 0]);
  assert.equal(heard.length, MAX_SHOTS);
  assert.deepEqual(heard.map((h) => h.key), Array.from({ length: MAX_SHOTS }, (_, i) => `s${i}`));
});

test('step 0: imported Eden\'s kinds that carry a sound', () => {
  assert.equal(Object.keys(KINDS).length, 16);
  assert.deepEqual(KINDS['core:fountain'].map((s) => s.kind), ['water', 'water', 'birds']);
});

test('A3: the switch is remembered', () => {
  const m = new Map<string, string>(), store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.equal(loadSettings(store).muted, false);
  saveSettings(store, { ...loadSettings(store), muted: true });
  assert.equal(loadSettings(store).muted, true);
  assert.equal(loadSettings({ getItem: () => '{bad', setItem() {} }).muted, false);
});

test('the sounds are the same samples every time, and loops have no seam', () => {
  assert.deepEqual(shot('door-open', 1, 8000), shot('door-open', 1, 8000));
  assert.equal(shot('step', 0, 8000).length, Math.ceil(SHOTS.step * 8000));
  const w = loop('water', 0, 8000);
  assert.equal(w.length, LOOP_SECONDS * 8000);
  assert.ok(Math.abs(w[w.length - 1] - w[0]) < 0.2);
});

test('A1\'s measure: a sound\'s lag from the frame its moment was drawn in', () => {
  const frames: [number, number][] = [[1000, 900_000], [1016, 916_000], [1032, 932_000]];
  assert.deepEqual(lags([{ sound: 'step', at: 920_000, offset: 0, heardMs: 1030 }], frames), [{ sound: 'step', lagMs: 10 }]);
  // Started 0.2 s in by a slow frame, its lost start is lag; started part-way by a seek, it is left out.
  assert.deepEqual(lags([{ sound: 'step', at: 920_000, offset: 0.2, heardMs: 1030 }], frames), [{ sound: 'step', lagMs: 210 }]);
  assert.deepEqual(lags([{ sound: 'step', at: 920_000, offset: 0.2, heardMs: 1030, fresh: true }], frames), []);
});
