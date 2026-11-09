import type { DefInput } from '../schemas.ts';

// One supplied ceramic artwork, repaired with the existing tool faculty. The seams remain visible afterward.
const seam = (color: string, when: string) => [
  { kind: 'sweep', at: [0,0,0], path: [[0,1.09,0.154],[0.018,1.16,0.187],[-0.012,1.22,0.204],[0.008,1.255,0.204]], r: 0.006, segments: 4, tint: color, when },
  { kind: 'sweep', at: [0,0,0], path: [[-0.012,1.22,0.204],[-0.055,1.24,0.196],[-0.08,1.255,0.187]], r: 0.006, segments: 4, tint: color, when },
];
export const GOLD_SEAM_STATION: DefInput = {
  schema: 'def/1', name: 'core-gold-seam-station', version: 1, form: 'point',
  description: 'A fixed art-restoration stand holding one ceramic bowl supplied with cracks. Dark cracks mean unrepaired; golden seams mean restored. Fetch the lacquer brush and repair it with short dabs: completion restores the bowl and leaves the cracks traced by visible golden seams. Interrupted work leaves it cracked. The native repair receipt records the completed work; the brush remains in hand. No curing time, chemistry or removable bowl is implied.',
  tags: ['art', 'restoration', 'local-fixture'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
    { kind: 'box', at: [0, 0.035, 0], size: [0.5, 0.07, 0.45], tint: 'wood', collide: true },
    { kind: 'box', at: [0, 0.52, 0], size: [0.09, 0.97, 0.09], tint: 'wood', collide: true },
    { kind: 'box', at: [0, 1, 0], size: [0.6, 0.06, 0.48], tint: 'wood', collide: true },
    { kind: 'lathe', at: [0, 1.035, 0], profile: [[0,0],[0.08,0],[0.14,0.035],[0.2,0.16],[0.2,0.22],[0.18,0.22],[0.18,0.16],[0.12,0.055],[0.06,0.025],[0,0.025]], segments: 10, tint: 'ceramic' },
    ...seam('crack', '@broken'), ...seam('gold', '!@broken'),
  ] } } as DefInput['make'],
  params: {}, palette: { wood: '#76583d', ceramic: '#d9e5d8', crack: '#302a26', gold: '#e0ad3f' },
  state: { broken: { type: 'bool', default: true }, repairedBy: { type: 'string', max: 80, default: '' } },
  // The hand stays in front of the bowl; the brush's +x tip reaches the ceramic along the holder's facing.
  components: { repairable: { tool: 'lacquer-brush', label: 'Restore the cracked bowl with golden lacquer', says: 'a cracked ceramic bowl', hand: [0, 1.19, 0.48], stands: [[0,0.85],[-0.2,0.85],[0.2,0.85]], strokes: 6, lift: 0.055, motion: 'strike' } },
  size: { box: [0.6, 1.28, 0.48] }, synonyms: ['ceramic restoration', 'gold seam bowl', 'kintsugi artwork'],
} as DefInput;

export const LACQUER_BRUSH: DefInput = {
  schema: 'def/1', name: 'core-lacquer-brush', version: 1, form: 'point',
  description: 'A small lacquer brush with a wooden handle and golden bristle tip. A Soul can fetch and hold it to restore the cracked ceramic bowl with short dabs.',
  tags: ['art', 'tool', 'item', 'tool-lacquer-brush', 'recorded-item'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
    { kind: 'box', at: [0.11,0.025,0], size: [0.22,0.025,0.025], tint: 'wood' },
    { kind: 'box', at: [0.235,0.025,0], size: [0.04,0.028,0.028], tint: 'ferrule' },
    { kind: 'box', at: [0.27,0.025,0], size: [0.04,0.03,0.022], tint: 'gold' },
  ] } } as DefInput['make'],
  params: {}, palette: { wood: '#a47a4c', ferrule: '#858b8b', gold: '#e0ad3f' },
  components: { carryable: { mass: 0.08, grips: 1 } }, layer: 'decor', size: { box: [0.3,0.05,0.05] },
} as DefInput;
export const GOLD_SEAM_DEFS = [GOLD_SEAM_STATION, LACQUER_BRUSH];
