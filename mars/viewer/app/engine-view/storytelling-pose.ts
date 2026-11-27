import type {ActivityFrame, HandGoal} from './activity-poses.ts';

/** Shoulder-relative upper-body phrases. The caller supplies its existing per-person activity clock;
 * seats, feet, roots and native hand/contact owners remain in the shared renderer. */
export function storytellingPose(seconds: number): Pick<ActivityFrame, 'hands' | 'side' | 'look'> {
  const phase = ((seconds * .23) % 3 + 3) % 3, phrase = Math.floor(phase);
  const angle = phase * 2 * Math.PI;
  const rest: [HandGoal, HandGoal] = [[.06, .025, -.57], [.06, .025, -.57]];
  const one: [HandGoal, HandGoal] = [rest[0], [.33 + .025 * Math.sin(angle * 3), .11 + .025 * Math.sin(angle * 2), -.05 + .035 * Math.cos(angle * 3)]];
  const both: [HandGoal, HandGoal] = [
    [.29 + .025 * Math.sin(angle * 3), .035 + .035 * Math.cos(angle * 2), -.08 + .025 * Math.sin(angle * 2)],
    [.29 + .025 * Math.sin(angle * 3 + 1), .035 - .035 * Math.cos(angle * 2), -.08 - .025 * Math.sin(angle * 2)],
  ];
  const phrases = [one, both, rest];
  // Blend the end of each phrase into the next, including rest → one-hand at the cycle wrap.
  // Smoothstep has zero endpoint slope: an internal phrase change cannot restart or snap a hand.
  const u = Math.max(0, (phase - phrase - (1 - .9 * .23)) / (.9 * .23)), weight = u * u * (3 - 2 * u);
  const from = phrases[phrase], to = phrases[(phrase + 1) % phrases.length];
  const hand = (i: number): HandGoal => from[i].map((x, j) => x + (to[i][j] - x) * weight) as [number, number, number];
  return {hands: [hand(0), hand(1)], side: .025 * Math.sin(angle), look: -.04};
}
