// The crowd's skinning (V6, #2715): three's Lambert and depth materials, with the skinning chunks replaced by a read of
// the baked bone texture. Per instance: `aAnim` (clip A, phase A, clip B, phase B; a phase is in cycles, its fraction
// used) and `aMix` (the blend toward clip B, from 2 up above the hips only, and the row of the per-body bone texture, or -1). A body with a row is
// posed from `uLive` (V7 fills it); every other body from its clips. Frames are blended linearly, and so are the two
// clips: right for neighbouring frames and for like clips (idle and walk), wrong for large rotations apart.
import * as THREE from 'three';

export const MAX_CLIPS = 24;
/** Bones a model may have for the upper-body mask (#3741). */
export const MAX_BONES = 128;

const PARS = /* glsl */ `
uniform sampler2D uBake;
uniform sampler2D uLive;
uniform float uClipStart[${MAX_CLIPS}];
uniform float uClipFrames[${MAX_CLIPS}];
uniform float uUpper[${MAX_BONES}];
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aAnim;
attribute vec2 aMix;
mat4 crowdBone(sampler2D tex, int row, float bone) {
  int x = int(bone) * 3;
  vec4 a = texelFetch(tex, ivec2(x, row), 0);
  vec4 b = texelFetch(tex, ivec2(x + 1, row), 0);
  vec4 c = texelFetch(tex, ivec2(x + 2, row), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 crowdClipBone(float clip, float phase, float bone) {
  int k = int(clip);
  float n = uClipFrames[k];
  float f = fract(phase) * n;
  float f0 = floor(f);
  int r0 = int(uClipStart[k] + f0);
  int r1 = int(uClipStart[k] + mod(f0 + 1.0, n));
  return crowdBone(uBake, r0, bone) * (1.0 - (f - f0)) + crowdBone(uBake, r1, bone) * (f - f0);
}
mat4 crowdPose(float bone) {
  if (aMix.y >= 0.0) return crowdBone(uLive, int(aMix.y), bone);
  mat4 m = crowdClipBone(aAnim.x, aAnim.y, bone);
  // A blend of 2 and over is clip B above the hips only, by the blend less 2 (a gesture over a posture, #3741).
  float w = aMix.x >= 1.5 ? (aMix.x - 2.0) * uUpper[int(bone)] : aMix.x;
  if (w > 0.001) m = m * (1.0 - w) + crowdClipBone(aAnim.z, aAnim.w, bone) * w;
  return m;
}
mat4 crowdSkin() {
  return crowdPose(skinIndex.x) * skinWeight.x + crowdPose(skinIndex.y) * skinWeight.y
    + crowdPose(skinIndex.z) * skinWeight.z + crowdPose(skinIndex.w) * skinWeight.w;
}
`;

export type CrowdUniforms = {
  uBake: { value: THREE.Texture };
  uLive: { value: THREE.Texture };
  uClipStart: { value: number[] };
  uClipFrames: { value: number[] };
  uUpper: { value: number[] };
};

/** Patches `material` to skin from the bake; `depth` for a shadow's depth material (it has no normals). */
export function crowdMaterial<M extends THREE.Material>(material: M, uniforms: CrowdUniforms, depth = false): M {
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${PARS}`);
    if (depth) {
      s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', 'mat4 crowdSk = crowdSkin();\nvec3 transformed = (crowdSk * vec4(position, 1.0)).xyz;');
    } else {
      s.vertexShader = s.vertexShader
        .replace('#include <beginnormal_vertex>', 'mat4 crowdSk = crowdSkin();\nvec3 objectNormal = normalize((crowdSk * vec4(normal, 0.0)).xyz);')
        .replace('#include <begin_vertex>', 'vec3 transformed = (crowdSk * vec4(position, 1.0)).xyz;');
    }
  };
  material.customProgramCacheKey = () => (depth ? 'crowd-depth' : 'crowd');
  return material;
}
