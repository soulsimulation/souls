// Sky palettes (Engine v2 V19c, #3521), carried over from today's `apps/web/src/atmosphere/palettes.ts`: a world's
// palette (`record.ts` `palette`, `souls:<palette>`) moves the dome's zenith and horizon toward its colours by day
// (faded by cloud and fog), the air's haze toward its horizon, and scales the clear air's fog density. A palette
// without an entry here keeps the default sky.
import * as THREE from 'three';

export type SkyLook = { zenith: THREE.Color; horizon: THREE.Color; fog: number };
const look = (zenith: string, horizon: string, fog: number): SkyLook => ({ zenith: new THREE.Color(zenith), horizon: new THREE.Color(horizon), fog });
export const SKY_LOOKS: Record<string, SkyLook> = {
  // Mars College, Salton basin: deep blue overhead, pale near the horizon, clear dry air
  'souls:mars-desert': look('#0466aa', '#79b6da', 0.2),
  // Eden 2026: a soft blue summer sky and less haze, so the far lakes and hills keep their colour
  'souls:eden-summer': look('#5f95c8', '#cfdce4', 0.45),
};
export const skyLook = (palette: string | null): SkyLook | null => (palette ? SKY_LOOKS[palette] ?? null : null);
