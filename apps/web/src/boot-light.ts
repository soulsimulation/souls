// #1166: a phone's new world is drawn before the app's code has downloaded, so the first paint's boot light (index.html) is
// all that visitor sees of the arrival. This keeps it honest: its bar and disc follow the same bytes the app's light would.
import { assetBytes } from './asset-bytes.ts';
import { downloadShare } from './viewer-arrival.ts';

const DISC_RADIUS = 146, START = 0.33, PEAK = 0.6;   // arrival-light.ts; repeated so the first chunk doesn't carry the shader

export function followBootLight(): void {
  let peak = 0;
  // This entry can run before the body's script has made the boot light, so it is looked up at each change.
  const off = assetBytes.subscribe(() => {
    const boot = document.getElementById('boot-arrival');
    if (boot?.dataset.fill) return off();
    const disc = boot?.querySelector<HTMLElement>('.arrival-disc'), bar = boot?.querySelector('progress');
    const { loaded, total, known } = assetBytes.snapshot();
    if (!disc || !bar || !known || !total) return;
    peak = Math.max(peak, bar.value / 1000);   // the code share the page's own script already showed
    const next = Math.max(peak, downloadShare(loaded / total));   // #1266: the download's share, as the app's light
    if (next - peak < 0.005 && peak) return;
    peak = next; bar.value = Math.round(peak * 1000);
    const from = START * DISC_RADIUS, to = PEAK * Math.hypot(innerWidth, innerHeight) / 2;   // #1318
    disc.style.setProperty('--s', String((from + (to - from) * (0.15 * peak + 0.85 * peak ** 3)) / DISC_RADIUS));   // growth(), arrival-light.ts
  });
}
