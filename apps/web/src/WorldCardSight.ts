/** #2195: how prominent one Soul's name card is, from what the camera sees. Pure and cheap: called per card per frame.
 *
 * - Hover, selection and group selection reveal any card at full strength.
 * - Your own Souls show whenever they are in view and not hidden behind something. From a high or far camera (where you
 *   look for them) they show even when hidden or far off, and are emphasised.
 * - Other owners' Souls are quieter, much quieter when asleep, idle or a zombie (unless speaking). They hide when
 *   hidden behind something, well behind the camera's focus, or beyond a reach that grows with the camera's height.
 * - Near the edge of a reach a card fades out over its last part instead of popping; `fadeCard` eases between values. */
export type CardSight = {
  mine: boolean;
  /** Hovered, selected or in the group selection. */
  revealed: boolean;
  state?: 'awake' | 'idle' | 'zombie' | 'asleep' | null;
  speaking?: boolean;
  /** Eye to body, metres. */
  distance: number;
  /** Eye height above the body, metres. */
  height: number;
  /** The body's depth along the view direction, metres (0 or less: behind the camera). */
  depth: number;
  /** The camera focus's depth along the view direction, or null when the camera has none. */
  focusDepth: number | null;
  /** Both of the body's sight points are hidden behind rendered scenery. */
  occluded: boolean;
};
export type CardLook = { opacity: number; emphasis: boolean };

export const CARD_SIGHT = {
  /** A camera at least this high above a body, or focused at least this far away, is a looking-for-them camera. */
  highM: 14, farM: 32,
  /** Others' reach: base + per metre of camera height; shortened for a quiet (asleep, idle, zombie) Soul. */
  reachM: 14, reachPerHeightM: 0.6, quietReach: 0.7,
  /** Your own Souls' reach from a low camera. */
  mineReachM: 90,
  /** Others' strength: active, quiet. */
  other: 0.8, quiet: 0.4,
  /** Behind the focus: hidden beyond focusDepth + max(behindM, behindShare × focusDepth). */
  behindM: 4, behindShare: 0.4,
  /** The share of a reach over which a card fades out. */
  fadeShare: 0.3,
} as const;

const HIDDEN: CardLook = { opacity: 0, emphasis: false };
const edge = (d: number, reach: number) => {
  if (!(reach > 0) || !(d < reach)) return 0;
  const from = reach * (1 - CARD_SIGHT.fadeShare);
  return d <= from ? 1 : (reach - d) / (reach - from);
};

export function cardLook(s: CardSight): CardLook {
  if (!(s.depth > 0) || ![s.distance, s.height, s.depth].every(Number.isFinite)) return HIDDEN;
  const looking = s.height >= CARD_SIGHT.highM || (s.focusDepth ?? 0) >= CARD_SIGHT.farM;
  if (s.revealed) return { opacity: 1, emphasis: s.mine && looking };
  if (s.mine) {
    if (looking) return { opacity: 1, emphasis: true };
    if (s.occluded) return HIDDEN;
    return { opacity: edge(s.distance, CARD_SIGHT.mineReachM), emphasis: false };
  }
  if (s.occluded) return HIDDEN;
  if (s.focusDepth !== null && s.focusDepth > 0 && s.depth > s.focusDepth + Math.max(CARD_SIGHT.behindM, CARD_SIGHT.behindShare * s.focusDepth)) return HIDDEN;
  const quiet = !s.speaking && (s.state === 'asleep' || s.state === 'idle' || s.state === 'zombie');
  const reach = (CARD_SIGHT.reachM + CARD_SIGHT.reachPerHeightM * Math.max(0, s.height)) * (quiet ? CARD_SIGHT.quietReach : 1);
  return { opacity: (quiet ? CARD_SIGHT.quiet : CARD_SIGHT.other) * edge(s.distance, reach), emphasis: false };
}

/** Ease a shown opacity toward its target (about 0.2 s to most of the way), so cards fade rather than pop. */
export function fadeCard(current: number, target: number, dtSec: number, tauSec = 0.1): number {
  if (!Number.isFinite(current)) return target;
  if (!(dtSec > 0)) return current;
  const next = current + (target - current) * (1 - Math.exp(-Math.min(dtSec, 1) / tauSec));
  return Math.abs(next - target) < 0.01 ? target : next;
}
