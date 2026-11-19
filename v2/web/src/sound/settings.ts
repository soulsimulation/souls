// The listener's settings (V21 A3, #2765), carried over from today's `apps/web/src/gen-mesh/sound-plan.ts` and
// `audio-settings.ts`: the same key and shape, kept per browser, so a visitor who switched effects off on today's page
// finds them off here. `muted` is the effects switch; `music` is kept as stored for V22's radio.
export type SoundSettings = { muted: boolean; volume: number; music: boolean };
export const SETTINGS_KEY = 'sim.sound.v1';
export const MASTER_DEFAULT = 0.32;
export const DEFAULT_SETTINGS: SoundSettings = Object.freeze({ muted: false, volume: MASTER_DEFAULT, music: true });
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void } | null | undefined;

export function loadSettings(store: Store): SoundSettings {
  try {
    const raw = store?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = JSON.parse(raw) as Partial<SoundSettings>;
    const v = typeof s.volume === 'number' && Number.isFinite(s.volume) ? s.volume : MASTER_DEFAULT;
    return { muted: s.muted === true, volume: Math.max(0, Math.min(1, v)), music: s.music === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(store: Store, s: SoundSettings) {
  try {
    store?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* a private window */
  }
}
