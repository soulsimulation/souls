// A small served world for rehearsing the driver's remote mode (follow-up of X7, #4015): N2's test world with an Eden
// slice on its square, Eden's own entries for what it holds, and the body's family, so walks, sits and forms have
// real targets. The same recipe as client/served/e2e/world.test.mjs's `edenSlice`, with more seats.
//
//   node v2/tools/driver/slice.mjs --facts <testworld-s1-t0.facts.json> --out <folder>
//
// Writes <folder>/slice.facts.json and <folder>/entries/; then `worldd seed --facts <folder>/slice.facts.json
// --entries <folder>/entries ...` and `gatewayd ... --entries <world>/entries` (README, "A served world").
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const content = resolve(dirname(fileURLToPath(import.meta.url)), '../../../content/kinds');
const opt = (k) => { const j = process.argv.indexOf(`--${k}`); return j < 0 ? null : process.argv[j + 1]; };
const [factsIn, out] = [opt('facts'), opt('out')];
if (!factsIn || !out) {
  console.error('usage: slice.mjs --facts <testworld facts.json> --out <folder>');
  process.exit(2);
}

// Kind ref → Eden kind name and its entry file; how many of each stand on the square.
const KINDS = [
  ['slice-bench@1', 'eden:bench', 'seating/bench.json', 20],
  ['slice-chair@1', 'eden:chair', 'seating/chair.json', 15],
  ['slice-speaker@1', 'eden:speaker', 'music/speaker.json', 3],
  ['slice-book@1', 'eden:book', 'storage/book.json', 2],
  ['slice-apple@1', 'eden:apple', 'food/apple.json', 2],
];
const seat = (n, id, at) => ({ n, id, kind: 'seat', at, yaw: 0, capacity: 1 });
const SLOTS = {
  'slice-bench@1': [seat(1, 'left', [-400, 465, 20]), seat(2, 'right', [400, 465, 20])],
  'slice-chair@1': [seat(1, 'seat', [0, 470, 20])],
};

const facts = JSON.parse(readFileSync(factsIn, 'utf8'));
mkdirSync(join(out, 'entries'), { recursive: true });
let spot = 0;
for (const [ref, name, file, count] of KINDS) {
  facts.kinds.push({ ref, hash: Buffer.from(`souls/slice/${ref}`).toString('hex').padEnd(64, '0').slice(0, 64), name, form: 'point' });
  copyFileSync(join(content, file), join(out, 'entries', file.replace('/', '-')));
  for (let i = 0; i < count; i++, spot++) {
    // A grid on the square, 2.5 m apart: nine across, rows from 6 m out (mm).
    const pose = [-10_000 + 2_500 * (spot % 9), 0, 6_000 + 3_000 * Math.floor(spot / 9), 0];
    facts.things.push({ id: `${ref.split('@')[0]}-${i + 1}`, def: ref, ref, parent: null, pose, scale_ppm: 1_000_000, name: `${name.split(':')[1]} ${i + 1}`, slots: SLOTS[ref] ?? [] });
  }
}
copyFileSync(join(content, 'body/humanoid.json'), join(out, 'entries', 'body-humanoid.json'));
writeFileSync(join(out, 'slice.facts.json'), JSON.stringify(facts));
console.log(`slice: ${spot} things of ${KINDS.length} kinds, entries in ${join(out, 'entries')}`);
