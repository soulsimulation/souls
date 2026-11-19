// The time-of-day colour grade (Engine v2 V19b, #3508), carried over from today's `apps/web/src/atmosphere/grade.ts`
// and its install in `atmosphere/chunks.ts`: folded into three's shared fog chunk (no extra pass), so every fogged
// built-in material and the sky dome end with the same gentle grade, and sky and ground stay one picture: a soft
// S-curve and a touch of saturation by day, warm highlights at golden hour, a cool lift in the blue hour, and at night
// dim areas desaturate toward moonlit blue while warm lamplight keeps its colour. Strength 0 is the identity.
import * as THREE from 'three';

export const GRADE_A = { x: 0, y: 0, z: 0, w: 0 }; // x strength, y S-curve amount, z saturation delta, w highlight warmth
export const GRADE_B = { x: 0, y: 0, z: 0, w: 0 }; // xyz shadow tint (added, display space), w night desaturation
export const GRADE_PARS = '\nuniform vec4 uEdenGradeA;\nuniform vec4 uEdenGradeB;\n';
export const GRADE_GLSL = /* glsl */ `
if(uEdenGradeA.x>0.0){
 vec3 edenC=clamp(gl_FragColor.rgb,0.0,1.0);
 float edenL=dot(edenC,vec3(.2126,.7152,.0722));
 edenC=mix(edenC,edenC*edenC*(3.0-2.0*edenC),uEdenGradeA.y);
 edenC=mix(vec3(edenL),edenC,1.0+uEdenGradeA.z);
 float edenSh=1.0-smoothstep(.0,.5,edenL),edenHi=smoothstep(.45,1.0,edenL);
 edenC+=uEdenGradeB.rgb*edenSh;
 edenC*=mix(vec3(1.0),vec3(1.0+.11*uEdenGradeA.w,1.0+.022*uEdenGradeA.w,1.0-.11*uEdenGradeA.w),edenHi);
 float edenNd=uEdenGradeB.w*(1.0-smoothstep(.12,.55,edenL))*(1.0-smoothstep(.05,.25,edenC.r-edenC.b));
 edenC=mix(edenC,vec3(edenL)*vec3(.82,.93,1.18),edenNd);
 gl_FragColor.rgb=mix(gl_FragColor.rgb,edenC,uEdenGradeA.x);
}
`;

const sm = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** The grade for a moment: day 0..1, warmth and blue hour by the sun's elevation, cloud 0..1 (today's `setGrade`). */
export function setGrade(day: number, warmth: number, blueHour: number, cloud: number): void {
  const golden = warmth * sm(0.05, 0.5, day), night = 1 - sm(0.02, 0.35, day), clear = 1 - 0.6 * cloud;
  GRADE_A.x = 1;
  GRADE_A.y = (0.1 + 0.06 * night) * clear + 0.04;
  GRADE_A.z = (0.07 * day + 0.08 * golden) * clear - 0.05 * cloud - 0.1 * night;
  GRADE_A.w = golden * clear * 1.0 + 0.15 * day * clear;
  GRADE_B.x = -0.012 * golden - 0.006 * blueHour - 0.004 * night;
  GRADE_B.y = 0.004 * golden;
  GRADE_B.z = 0.01 * golden + 0.022 * blueHour + 0.012 * night;
  GRADE_B.w = 0.55 * night;
}

let installed = false;
/** Folds the grade into three's fog chunk once, before any fogged program compiles (today's install, the grade only). */
export function installGrade(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk, mix = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  C.fog_pars_fragment += '\n#ifdef USE_FOG\n' + GRADE_PARS + '#endif\n';
  if (C.fog_fragment.includes(mix)) C.fog_fragment = C.fog_fragment.replace(mix, `${mix}\n${GRADE_GLSL}`);
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (!lib.uniforms || !('fogDensity' in lib.uniforms)) continue;
    lib.uniforms.uEdenGradeA = { value: GRADE_A };
    lib.uniforms.uEdenGradeB = { value: GRADE_B };
  }
}
