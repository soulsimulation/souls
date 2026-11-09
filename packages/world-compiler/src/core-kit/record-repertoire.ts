import type { DefInput } from '../schemas.ts';
import { HAND_MUSIC, RECORD_SLEEVES } from './hand-music.ts';

export const EXPANDED_RECORD_SLEEVES = [...RECORD_SLEEVES, 'Paper Lanterns', 'Open Window'] as const;
const original = HAND_MUSIC.find(d => d.name === 'core-record-player' && d.version === 1)!;
/** New content on the existing player/contact faculty; the published first revision stays immutable. */
export const REPERTOIRE_RECORD_PLAYER: DefInput = {
  ...structuredClone(original), version: 2,
  description: 'A record player with six selectable records, including the original new scores Paper Lanterns and Open Window. Put on a chosen record at the tonearm and stop it at the front knob. Everyone nearby hears the same chosen piece on the shared score clock.',
  tags: [...(original.tags ?? []), 'local-fixture'],
  make: { kind: 'gen', gen: 'kit/2', args: { round: 0, shapes: [
    { kind: 'box', at: [0, 0.5, 0], size: [0.6, 0.88, 0.4], tint: 'wood' },
    { kind: 'box', at: [0, 0.03, 0], size: [0.62, 0.06, 0.42], tint: 'dark' },
    { kind: 'box', at: [0, 0.955, 0], size: [0.58, 0.03, 0.38], tint: 'dark' },
    { kind: 'cyl', at: [-0.07, 0.985, 0], r: 0.15, h: 0.03, segments: 12, tint: 'metal' },
    { kind: 'cyl', at: [-0.07, 1.003, 0], r: 0.14, h: 0.006, segments: 12, tint: 'dark' },
    { kind: 'cyl', at: [-0.07, 1.007, 0], r: 0.045, h: 0.004, segments: 8, tint: 'wood' },
    { kind: 'cyl', at: [0.17, 0.99, -0.12], r: 0.025, h: 0.04, segments: 8, tint: 'dark' },
    { kind: 'box', at: [0.14, 1.015, -0.03], size: [0.022, 0.016, 0.2], tint: 'tuner' },
    { kind: 'cyl', at: [0.2, 0.86, 0.205], r: 0.026, h: 0.03, segments: 8, tint: 'valve', pitch: Math.PI / 2 }
  ] } } as DefInput['make'],
  palette: { wood: '#8a5937', dark: '#252326', metal: '#c9ccd1', tuner: '#c9ccd1', valve: '#c9ccd1' },
  params: { wood: { type: 'color', default: '#8a5937' }, dark: { type: 'color', default: '#252326' }, metal: { type: 'color', default: '#c9ccd1' } } as DefInput['params'],
  state: { ...original.state, record: { type: 'enum', values: [...EXPANDED_RECORD_SLEEVES], default: EXPANDED_RECORD_SLEEVES[0] } } as DefInput['state'],
  actions: original.actions!.map(a => a.name === 'put-on-record' ? { ...structuredClone(a), params: { record: { type: 'string', max: 40, doc: `the record to put on: ${EXPANDED_RECORD_SLEEVES.join(', ')}` } } } : structuredClone(a))
};
