// Device tiers (V5, #2714), copied from apps/web/src/quality-tier.ts (not imported) and cut to what this page draws:
// a phone (touch-first, short side ≤ 820 CSS px, or 2 GB) gets the `phone` tier, everything else `full`. The tier
// changes only how the view is drawn, never what the world is.
export type QualityTier = 'phone' | 'full';
export type QualitySettings = { tier: QualityTier; reason: string; maxPixelRatio: number; antialias: boolean };
export type QualityEnvironment = { coarsePointer: boolean; screen: readonly [number, number]; deviceMemory?: number };

export function pickQualityTier(env: QualityEnvironment): QualitySettings {
  const shortSide = Math.min(env.screen[0], env.screen[1]);
  const [tier, reason]: [QualityTier, string] = env.coarsePointer && shortSide > 0 && shortSide <= 820 ? ['phone', `touch screen, short side ${shortSide}px`]
    : env.coarsePointer && env.deviceMemory !== undefined && env.deviceMemory <= 2 ? ['phone', `touch device with ${env.deviceMemory} GB`]
    : ['full', 'desktop or large screen'];
  return tier === 'phone' ? { tier, reason, maxPixelRatio: 1.5, antialias: false } : { tier, reason, maxPixelRatio: 2, antialias: true };
}

/** A software GL renderer (SwiftShader, llvmpipe) draws on the CPU: no antialiasing, one pixel per CSS pixel. */
export function softwareGl(renderer: string | null): boolean {
  return !!renderer && /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
}

export function browserQuality(renderer: string | null = null): QualitySettings {
  if (softwareGl(renderer)) return { tier: 'phone', reason: `software GL (${renderer})`, maxPixelRatio: 1, antialias: false };
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return pickQualityTier({ coarsePointer: coarse, screen: [screen.width, screen.height], deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory });
}
