// The humanoid kit the page draws looks from (#3998), published with the body assets as `assets/bodies/humanoid/`
// (v2/tools/import-body/presets.ts copies it, v2/web/body-assets.ts checks and emits it). kit.json is pinned here by
// its sha256; every file it lists is pinned by kit.json. A changed kit is a new pin, in the same change. No import, so
// the build tools can read it before any dependency is in place.

/** sha256 of mars/viewer/public/modular/humanoid/kit.json. */
export const KIT_SHA256 = '5d33021b26ed0c9b6e6204a49bc433c17cb2fb6dd90b9146f5ec0e692360db69';

type Pinned = { file: string; sha256: string };
type Kit = { frames: Record<string, { rig: string; sha256: string }>; parts: Record<string, Record<string, { files?: Record<string, Pinned> }>> };

/** Every file kit.json lists (each frame's rig, each part's per-frame model), with its sha256, in kit.json's order. */
export function kitFiles(kit: Kit): Pinned[] {
  const files = Object.values(kit.frames).map((f) => ({ file: f.rig, sha256: f.sha256 }));
  for (const slot of Object.values(kit.parts)) for (const part of Object.values(slot)) files.push(...Object.values(part.files ?? {}));
  const path = /^(parts\/)?[a-z0-9-]+(\.[a-z]+)?\.glb$/;
  if (files.some((f) => !path.test(f.file) || !/^[a-f0-9]{64}$/.test(f.sha256))) throw Error('body.humanoid-kit-path');
  return files;
}
