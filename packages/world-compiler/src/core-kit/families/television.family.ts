// #2281: a television with state. core-television@1 (vocab-2.json) keeps its bytes; @2 adds what it shows (`channel`, one of
// a small fixed set of pictures), a Soul action to change it, and a soft light on the room while it is on. The pictures are
// glowing kit shapes drawn only while on (`when: @on&@channel=…`); off, the screen is dark glass. All data: the viewer's kit
// renderer, the lamp glow (syncLightGlow) and the night light pools (components.light) already follow `on`.
import vocab2 from '../vocab-2.json' with { type: 'json' };
import type { DefInput } from '../../schemas.ts';

export const TV_CHANNELS = ['garden', 'sea', 'stars', 'test-card'] as const;
type Part = [u: number, v: number, w: number, h: number, color: string, disc?: true];
/** Each picture in screen units: u across (-0.5 left … 0.5 right), v up, w and h as fractions of the screen; back to front. */
export const PICTURES: Record<(typeof TV_CHANNELS)[number], Part[]> = {
  garden: [[0, 0.2, 1, 0.6, '#8fc9ef'], [0, -0.3, 1, 0.4, '#4f9a45'], [0.22, -0.08, 0.56, 0.12, '#7bb35a'], [-0.26, 0.24, 0.16, 0.2, '#ffd75e', true]],
  sea: [[0, 0.22, 1, 0.56, '#f4b37a'], [0, -0.28, 1, 0.44, '#2a5d8f'], [0, -0.02, 0.2, 0.26, '#ffe08a', true], [0, -0.26, 0.06, 0.36, '#f7c873']],
  stars: [[0, 0, 1, 1, '#0d1636'], [0.28, 0.2, 0.18, 0.24, '#f2efd8', true],
    ...([[-0.38, 0.32], [-0.12, 0.08], [-0.3, -0.26], [0.34, -0.28]] as const).map(([u, v]): Part => [u, v, 0.025, 0.035, '#ffffff'])],
  'test-card': ['#f2f2f2', '#f2e14a', '#4ad7e0', '#52c24a', '#d24ad6', '#e0453a', '#3a4ee0'].map((c, i): Part => [-0.5 + (i + 0.5) / 7, 0, 1 / 7, 1, c]),
};
/** The two screens of @1 (cabinet, flat): centre x, y, front face z, width, height. */
const SCREENS = { cabinet: [-0.08, 0.6, 0.233, 0.44, 0.34], flat: [0, 0.69, 0.032, 1.04, 0.58] } as const;

type Shape = Record<string, unknown> & { tint?: string; when?: string };
function pictureShapes(variant: keyof typeof SCREENS): Shape[] {
  const [cx, cy, z, sw, sh] = SCREENS[variant];
  return TV_CHANNELS.flatMap((ch) => PICTURES[ch].map(([u, v, w, h, color, disc], i): Shape => {
    const at = [cx + u * sw, cy + v * sh, z + 0.001 + i * 0.001], when = `variant=${variant}&@on&@channel=${ch}`;
    return disc ? { kind: 'cyl', at, r: Math.min(w * sw, h * sh) / 2, h: 0.002, segments: 8, pitch: Math.PI / 2, color, glow: 0.9, role: 'screen', when }
      : { kind: 'box', at, size: [w * sw, h * sh, 0.002], round: 0, color, glow: 0.9, role: 'screen', when };
  }));
}

const v1 = vocab2.find((d) => d.name === 'core-television')! as unknown as DefInput;
const shapes = (structuredClone((v1.make as unknown as { args: { shapes: Shape[] } }).args.shapes)).map((s): Shape => s.tint === 'screen'
  // off: the screen is dark glass (not the pale glow colour of @1, which read as a painting)
  ? (({ glow: _glow, tint: _tint, ...rest }) => ({ ...rest, color: '#0d1114', when: `${s.when}&!@on` }))(s)
  : s);

export const TELEVISION_2: DefInput = {
  ...structuredClone(v1), version: 2,
  description: 'A television: a wooden cabinet set on splayed legs (0.75 m wide, 1 m tall) or a flat screen on a foot. Switched on, it shows one of four pictures (garden, sea, stars, test card) and lights the room softly; change the channel to see the next. Off, the screen is dark glass. Variants: cabinet, flat.',
  make: { ...v1.make, args: { ...(v1.make as { args: object }).args, shapes: [...shapes, ...pictureShapes('cabinet'), ...pictureShapes('flat')] } } as DefInput['make'],
  state: { on: { type: 'bool', default: false }, channel: { type: 'enum', values: [...TV_CHANNELS], default: TV_CHANNELS[0] } } as DefInput['state'],
  components: { ...(v1.components ?? {}), light: { color: '#cfe0ff', range: 3, on: true, at: [0, 0.65, 0.35] } } as DefInput['components'],
  actions: [
    ...structuredClone(v1.actions ?? []),
    { name: 'change-channel', label: 'Change the channel on the television', roles: 'anyone', reach: 'touch', params: {}, when: [{ field: 'on', is: true }], then: [{ op: 'cycle', field: 'channel', values: [...TV_CHANNELS] }] },
  ] as DefInput['actions'],
};

export default [TELEVISION_2];
