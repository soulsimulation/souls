// Water (Engine v2 V19b, #3508), carried over from today's `apps/web/src/gen-mesh/water.ts` unchanged but for its clock:
// a standard material whose normals ripple with three scrolling wave sets (still water calms with distance), faint
// sparkles, a matte far surface and the sun's glint capped at a sky blue; `flow` for a river. The v2 page draws still
// water (lakes, ponds) with `waterMaterial()`, as today's entity layer does. Today's page and phone draw the same water,
// so every tier gets it. Today's waves run on the page's clock; here `tickWater` sets world seconds, so a seek draws the
// water that playing to the moment draws.
import * as THREE from 'three';

const shared = { uTime: { value: 0 } };
/** Sets the waves' time, world seconds (wrapped to an hour, so the float keeps its precision). */
export function tickWater(worldSeconds: number): void {
  shared.uTime.value = worldSeconds % 3600;
}

const cache = new Map<string, THREE.MeshStandardMaterial>();
/** `flow` m/s along +u (rivers), 0 for still water. `color` the deep tint. */
export function waterMaterial(opts: { flow?: number; color?: string; opacity?: number } = {}): THREE.MeshStandardMaterial {
  const flow = opts.flow ?? 0, color = opts.color ?? '#3a7ca8', opacity = opts.opacity ?? 0.8;
  const key = `${flow}|${color}|${opacity}`;
  const hit = cache.get(key); if (hit) return hit;
  // flowing water: a softer glint (no white glare bands at grazing angles)
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: flow > 0 ? 0.34 : 0.18, metalness: flow > 0 ? 0.06 : 0.12, side: THREE.DoubleSide, depthWrite: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uFlow = { value: flow };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterUv;\nvarying vec3 vWaterWorld;\nattribute vec2 waterUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterUv = waterUv;\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uFlow;\nvarying vec2 vWaterUv;\nvarying vec3 vWaterWorld;\nvec2 wv(vec2 p, vec2 d, float f, float s){ float ph = dot(p, d) * f + uTime * s; return d * cos(ph) * f; }')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec2 p = uFlow > 0.0 ? vec2(vWaterUv.x - uTime * uFlow, vWaterUv.y) : vWaterWorld.xz;
        vec2 g = wv(p, normalize(vec2(1.0, 0.3)), 0.9, 1.3) * 0.05 + wv(p, normalize(vec2(-0.4, 1.0)), 1.7, 1.9) * 0.03 + wv(p, normalize(vec2(0.7, -0.8)), 3.1, 2.7) * 0.015;
        // still water calms with distance: far off, the three regular waves under a low sun read as a tiled grid of glints
        if (uFlow <= 0.0) g *= mix(1.0, 0.12, smoothstep(30.0, 110.0, length(vWaterWorld - cameraPosition)));
        if (uFlow > 0.0) g = g * 0.6 + vec2(sin(vWaterUv.x * 1.4 + sin(vWaterUv.y * 0.9) * 1.2 - uTime * uFlow * 1.7) * 0.012, 0.0); // ripples across the flow (no chevrons)
        vec3 wn = normalize(vec3(-g.x, 1.0, -g.y));
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
      }`)
      // still water far off reads matte (old Eden's lakes): a mirror-smooth far lake under a bright dusk sky was a white sheet
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (uFlow <= 0.0) roughnessFactor = mix(roughnessFactor, 0.6, smoothstep(45.0, 150.0, length(vWaterWorld - cameraPosition)));')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec2 p = uFlow > 0.0 ? vec2(vWaterUv.x - uTime * uFlow * 1.2, vWaterUv.y) : vWaterWorld.xz * 0.35;
        float a = sin(p.x * 1.3 + uTime * 0.7 + sin(p.y * 0.71 + uTime * 0.13) * 2.1);
        float b = sin(p.y * 1.1 - uTime * 0.5 + sin(p.x * 0.53 - uTime * 0.11) * 2.3);
        float sparkle = smoothstep(0.93, 1.0, a * b) * (0.5 + 0.5 * sin(p.x * 0.17 + p.y * 0.23));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.93, 0.97), sparkle * (uFlow > 0.0 ? 0.12 : 0.2));
        if (uFlow > 0.0) { float streak = smoothstep(0.75, 1.0, sin(p.x * 0.8 + sin(vWaterUv.y * 0.5 + p.x * 0.11) * 0.7)) * (0.6 + 0.4 * sin(vWaterUv.y * 1.3 + p.x * 0.07)); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7, 0.84, 0.9), streak * 0.06);
        } // soft broken streaks, not a W across the bed
      }`)
      // flowing water: cap the sun glint at a pale blue so a grazing view never reads as a white strip
      // still water: a low sun (a June dusk) lit every wave crest of the three-wave normal into a grid of white diamonds;
      // the glint is capped at a bright sky blue there (it still reads as sun on water, never as a white tiled patch)
      // W5: the cap comes before the fog, so it caps the glint, not the fog: after it, a far lake in rain or fog was
      // clamped back to blue-grey and drew as a flat unfogged quad while the land around it faded into the fog
      .replace('#include <fog_fragment>', '  gl_FragColor.rgb = min(gl_FragColor.rgb, uFlow > 0.0 ? vec3(0.58, 0.74, 0.84) : mix(vec3(0.7, 0.8, 0.87), vec3(0.42, 0.56, 0.66), smoothstep(45.0, 150.0, length(vWaterWorld - cameraPosition))));\n#include <fog_fragment>');
  };
  m.customProgramCacheKey = () => `l3-water-${flow > 0 ? 'flow' : 'still'}`;
  cache.set(key, m);
  return m;
}

/** Give a geometry the attribute the water shader reads (world xz for still water when none is set). */
export function setWaterUv(g: THREE.BufferGeometry, uv?: number[]) {
  if (!uv) { const p = g.attributes.position as THREE.BufferAttribute; uv = []; for (let i = 0; i < p.count; i++) uv.push(p.getX(i), p.getZ(i)); }
  g.setAttribute('waterUv', new THREE.Float32BufferAttribute(uv, 2));
}
/** Draws a mesh of still water areas (built as drapes) with the water: its own material, after the opaque ground. */
export function asWater(mesh: THREE.Mesh): THREE.Mesh {
  (mesh.material as THREE.Material).dispose();
  mesh.material = waterMaterial();
  mesh.geometry.deleteAttribute('color');
  setWaterUv(mesh.geometry);
  Object.assign(mesh, { name: 'water', renderOrder: 2, receiveShadow: false });
  return mesh;
}
