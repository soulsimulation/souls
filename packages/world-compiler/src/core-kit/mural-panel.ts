// W055: an explicitly paintable wall surface on the existing painting faculty.
import type { DefInput } from '../schemas.ts';

export const MURAL_PANEL_DEF: DefInput = {
  schema: 'def/1', name: 'core-mural-panel', version: 1,
  description: 'A low plaster wall set aside for murals, with a brush pot at its foot. Paint a lasting picture with your title and credit. An unowned panel is public; an owned panel may be painted only by its Soul owner.',
  category: 'object.art', form: 'point', tags: ['art', 'wall', 'mural', 'sign-text'],
  synonyms: ['mural panel', 'mural wall', 'painting wall'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0.006, shapes: [
    { kind: 'box', at: [0, 0.92, 0], size: [1.36, 1.84, 0.16], round: 0, tint: 'plaster', collide: true },
    { kind: 'box', at: [0, 1.87, 0], size: [1.46, 0.06, 0.22], round: 0, tint: 'cap' },
    { kind: 'cyl', at: [0.6, 0.065, 0.18], r: 0.045, h: 0.13, segments: 8, tint: 'pot' },
    { kind: 'box', at: [0.6, 0.18, 0.18], size: [0.012, 0.16, 0.012], round: 0, tint: 'brush' }],
    // Reachable without a ladder; square picture preserves the painting recipe's aspect ratio.
    faces: [{ at: [0, 1.15, 0.081], w: 1.2, h: 1.2, media: true, bg: '#e8e1ce',
      paintLabel: 'Paint a mural', paintNoun: 'mural', ownerBound: true }] } },
  palette: { plaster: '#e8e1ce', cap: '#9b856d', pot: '#716958', brush: '#b98c55' },
  params: { plaster: { type: 'color', default: '#e8e1ce', doc: 'plaster colour' }, cap: { type: 'color', default: '#9b856d', doc: 'wall cap colour' } },
  state: { media: { type: 'string', max: 500, default: '' }, title: { type: 'string', max: 120, default: '' }, maker: { type: 'string', max: 160, default: '' } },
  components: { workstation: { kind: 'painting' }, display: { w: 1.2, h: 1.2 } },
  // Remains a local art surface rather than an automatically announced distant landmark.
  size: { box: [1.46, 1.9, 0.3] },
};
