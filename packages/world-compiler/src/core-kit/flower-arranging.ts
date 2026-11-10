import type {DefInput} from '../schemas.ts';

const stemPalette = {stem: '#4f793a', petal: '#d55d79', pollen: '#e6b640'};
const stem: DefInput = {
  schema: 'def/1', name: 'core-cut-flower', version: 1, form: 'point',
  description: 'One real cut flower stem, carried individually and placed in an arranging vase. Its petal color and identity remain its own when inserted or retrieved; it does not grow or wilt.',
  tags: ['item', 'flower', 'cut-flower', 'art', 'recorded-item'],
  make: {kind: 'gen', gen: 'kit/2', args: {round: 0, shapes: [
    {kind: 'cyl', at: [0, 0.25, 0], r: 0.005, h: 0.5, segments: 5, tint: 'stem'},
    {kind: 'sphere', at: [0.022, 0.21, 0], r: 0.026, scale: [1.3, 0.25, 0.55], segments: 5, roll: 0.45, tint: 'stem'},
    ...Array.from({length: 5}, (_, i) => ({kind: 'sphere', at: [Math.cos(i * Math.PI * 2 / 5) * 0.028, 0.5, Math.sin(i * Math.PI * 2 / 5) * 0.028], r: 0.028, scale: [1, 0.25, 1], segments: 5, tint: 'petal'})),
    {kind: 'cyl', at: [0, 0.508, 0], r: 0.016, h: 0.012, segments: 6, tint: 'pollen'},
  ]}} as DefInput['make'],
  params: Object.fromEntries(Object.entries(stemPalette).map(([k, v]) => [k, {type: 'color', default: v, doc: `${k} color`}])) as DefInput['params'],
  palette: stemPalette, components: {carryable: {mass: 0.03, grips: 1}}, layer: 'decor',
  size: {box: [0.12, 0.52, 0.12]}, category: 'object.decor', synonyms: ['cut stem', 'flower stem', 'single flower'],
};
const vasePalette = {glaze: '#648a9a', stand: '#92704d'};
const vase: DefInput = {
  schema: 'def/1', name: 'core-arranging-vase', version: 1, form: 'point',
  description: 'An open ceramic arranging vase on a small pedestal, with three distinct places for individual cut stems. Put a chosen stem in, see what is there, or take a particular stem back out. The actual flower heads remain visible above the rim.',
  tags: ['furniture', 'art', 'vase', 'flowers', 'container', 'hand-operated', 'storage-inside'],
  make: {kind: 'gen', gen: 'kit/2', args: {round: 0.006, shapes: [
    {kind: 'cyl', at: [0, 0.035, 0], r: 0.26, h: 0.07, segments: 10, tint: 'stand'},
    {kind: 'cyl', at: [0, 0.46, 0], r: 0.045, h: 0.84, segments: 8, tint: 'stand'},
    {kind: 'cyl', at: [0, 0.89, 0], r: 0.24, h: 0.04, segments: 12, tint: 'stand'},
    {kind: 'lathe', at: [0, 0, 0], profile: [[0, 0.91], [0.12, 0.91], [0.21, 0.95], [0.24, 1.13], [0.23, 1.15], [0.20, 1.15], [0.18, 0.97], [0, 0.95]], segments: 14, tint: 'glaze'},
  ]}} as DefInput['make'],
  params: Object.fromEntries(Object.entries(vasePalette).map(([k, v]) => [k, {type: 'color', default: v, doc: `${k} color`}])) as DefInput['params'],
  palette: vasePalette,
  slots: [-0.13, 0, 0.13].map((x, i) => ({id: `stem-${i + 1}`, kind: 'shelf', p: [x, 0.96, i === 1 ? 0.045 : -0.025], yaw: 0, accepts: {tags: ['cut-flower']}, capacity: 1})) as DefInput['slots'],
  components: {container: {capacity: 3, inside: {lip: 1.15, face: 0.24, stand: [0, 0.88], fit: [0.12, 0.54, 0.12], word: 'vase'}}} as DefInput['components'],
  size: {box: [0.52, 1.15, 0.52]}, category: 'object.container', synonyms: ['flower arranging vase', 'stem vase'],
};
export const FLOWER_ARRANGING: DefInput[] = [stem, vase];
