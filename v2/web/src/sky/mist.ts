// Low-lying mist (Engine v2 V19c, #3521), carried over from today's `apps/web/src/atmosphere/chunks.ts`: folded into
// three's shared fog chunk (no extra pass), so every fogged built-in material thickens toward the fog colour near the
// ground, patchy by today's weather noise (`noise.ts`, its G channel) drifting with the clouds. At amount 0 (the
// default, and every world without mist settings) it does nothing.
import * as THREE from 'three';
import { noiseTexture } from './noise.ts';

/** x mist amount 0..1, y time (s, wrapped), z base y (m), w wetness (unused here); today's `MIST`. */
export const MIST = { value: { x: 0, y: 0, z: -1.5, w: 0 } };
/** zw the cloud drift the mist's noise follows (today's `ATMOS`; x, y unused here). */
export const ATMOS = { value: { x: 0, y: 0.5, z: 0, w: 0 } };

/** Today's mist term, unchanged. */
export const MIST_GLSL = /* glsl */ `if(uEdenMist.x>0.0){
  float edenH=max(vEdenAtmosW.y-uEdenMist.z,0.0);
  float edenN=texture2D(uEdenNoise,vEdenAtmosW.xz*(1.0/90.0)+uEdenAtmos.zw*.42).g;
  float edenM=uEdenMist.x*exp(-edenH/2.2)*(1.0-exp(-vFogDepth*.06))*(.55+.75*edenN);
  fogFactor=1.0-(1.0-fogFactor)*(1.0-clamp(edenM,0.0,.92));
 }
 `;

let installed = false;
/** Folds the mist into three's fog chunks once, before any fogged program compiles (today's install, the mist only). */
export function installMist(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk, mix = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  C.fog_pars_vertex += '\n#ifdef USE_FOG\nvarying vec3 vEdenAtmosW;\n#endif\n';
  C.fog_vertex += '\n#ifdef USE_FOG\nvEdenAtmosW=transpose(mat3(viewMatrix))*(mvPosition.xyz-viewMatrix[3].xyz);\n#endif\n';
  C.fog_pars_fragment += '\n#ifdef USE_FOG\nvarying vec3 vEdenAtmosW;\nuniform vec4 uEdenAtmos;\nuniform vec4 uEdenMist;\nuniform sampler2D uEdenNoise;\n#endif\n';
  if (C.fog_fragment.includes(mix)) C.fog_fragment = C.fog_fragment.replace(mix, MIST_GLSL + mix);
  const noise = { value: noiseTexture() };
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (!lib.uniforms || !('fogDensity' in lib.uniforms)) continue;
    Object.assign(lib.uniforms, { uEdenMist: MIST, uEdenAtmos: ATMOS, uEdenNoise: noise });
  }
}
