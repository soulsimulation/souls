// #1495, V12: smoldering incense on the existing hand-operated fire/contact faculty.
import type { DefInput } from '../schemas.ts';
// Keep this viewer-imported definition independent of the unrelated fire vocabulary.
const actions: NonNullable<DefInput['actions']> = [{"name":"light","label":"Light the incense","roles":"anyone","reach":"touch","params":{},"when":[{"field":"on","is":false}],"then":[{"op":"set","field":"on","value":true}]},{"name":"put-out","label":"Put out the incense","roles":"anyone","reach":"touch","params":{},"when":[{"field":"on","is":true}],"then":[{"op":"set","field":"on","value":false}]}];

export const INCENSE_CENSER_DEF: DefInput = {
  schema: 'def/1', name: 'core-incense-censer', version: 1,
  description: 'A ceramic incense bowl on a narrow stand, holding a stick above an ash bed. A Soul lights the tip or puts it out by hand; while lit it smolders with a small glowing tip and rising smoke. It stays lit until put out.',
  tags: ['incense', 'ritual', 'hand-operated', 'local-fixture'], category: 'object.art', form: 'point',
  synonyms: ['incense', 'incense censer', 'incense burner'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0.004, shapes: [
    { kind: 'cyl', at: [0, 0.015, 0], r: 0.13, h: 0.03, segments: 10, tint: 'stand' },
    { kind: 'cyl', at: [0, 0.435, 0], r: 0.018, h: 0.84, segments: 8, tint: 'stand' },
    { kind: 'lathe', at: [0, 0.86, 0], profile: [[0, 0], [0.075, 0], [0.11, 0.045], [0.105, 0.06], [0.088, 0.045], [0.065, 0.018], [0, 0.018]], segments: 10, tint: 'ceramic' },
    { kind: 'cyl', at: [0, 0.886, 0], r: 0.065, h: 0.008, segments: 10, tint: 'ash' },
    { kind: 'cyl', at: [0.025, 0.99, 0.02], r: 0.003, h: 0.2, segments: 5, tint: 'stick' },
    { kind: 'sphere', at: [0.025, 1.093, 0.02], r: 0.0045, segments: 6, tint: 'valve' },
    { kind: 'sphere', at: [0.025, 1.094, 0.02], r: 0.005, segments: 6, tint: 'tip', glow: 0.75, when: '@on' },
    // A smoke source, not a flame stand-in. The existing atmosphere animates it while on.
    { kind: 'sphere', at: [0.025, 1.15, 0.02], r: 0.018, segments: 5, tint: 'smoke', when: '@on' }] } },
  params: { smokeScale: { type: 'number', default: 0.15, min: 0.1, max: 0.3, doc: 'smoke plume attenuation' }, ceramic: { type: 'color', default: '#6e8b85', doc: 'ceramic bowl colour' }, stand: { type: 'color', default: '#4a4038', doc: 'stand colour' } },
  palette: { ceramic: '#6e8b85', stand: '#4a4038', ash: '#aaa399', stick: '#92714b', valve: '#39312c', tip: '#df8f45', smoke: '#aeb2b5' },
  state: { on: { type: 'bool', default: false } },
  components: {}, size: { box: [0.26, 1.18, 0.26] }, actions,
};
