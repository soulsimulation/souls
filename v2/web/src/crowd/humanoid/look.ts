// A humanoid look on the v2 page (#3998): the part of apps/web/src/humanoid/look.ts the page needs to draw a
// core/humanoid@2 look from its params (check, resolve, palette), ported unchanged in what it answers, because this page
// imports nothing from apps/ or packages/. PARAMS is core/humanoid@2's params
// (packages/world-compiler/src/core-kit/humanoid2.ts); look.test.ts checks this port against both, read as data.
// Change them together. Editing, outfits, seeded looks and template keys stay in today's app.

type Field = { type: 'enum'; values: readonly string[]; default: string } | { type: 'number'; min: number; max: number; default: number } | { type: 'color'; default: string };
const SHARED = ['adventurer', 'beach', 'casual-hoodie', 'farmer', 'king', 'spacesuit', 'suit', 'swat', 'woman-adventurer', 'woman-formal', 'woman-medieval', 'woman-punk', 'woman-scifi', 'woman-soldier', 'woman-suit', 'woman-witch', 'woman-worker', 'worker'];
const e = (values: string[], d = values[0]): Field => ({ type: 'enum', values, default: d });
const n = (min: number, max: number, d: number): Field => ({ type: 'number', min, max, default: d });
const c = (d: string): Field => ({ type: 'color', default: d });
/** core/humanoid@2's params, in the def's order. */
export const PARAMS: Readonly<Record<string, Field>> = {
  preset: e(['none', 'casual', 'punk', 'woman']), frame: e(['masc', 'fem']),
  face: e(['open', 'pierced', 'soft', ...SHARED]),
  hair: e(['short', 'mohawk', 'bob', ...SHARED.filter((v) => !['farmer', 'spacesuit', 'swat'].includes(v)), 'bald']),
  top: e(['shirt', 'jacket', 'tank', ...SHARED]), bottom: e(['jeans', 'ripped', 'slacks', ...SHARED]), shoes: e(['sneakers', 'boots', 'flats', ...SHARED]),
  hat: e(['none', 'cap', 'beanie', 'sunhat']), glasses: e(['none', 'round', 'square', 'shades']), bag: e(['none', 'backpack', 'satchel']),
  pattern: e(['plain', 'stripes', 'checks', 'knit']),
  facialHair: e(['none', 'mustache', 'goatee', 'beard']), scarf: e(['none', 'scarf']), gloves: e(['none', 'gloves']), mask: e(['none', 'cloth']),
  jewellery: e(['none', 'earrings', 'necklace', 'both']),
  shoulders: n(0.9, 1.12, 1), chest: n(0.9, 1.15, 1), hips: n(0.9, 1.15, 1), weight: n(0.9, 1.25, 1),
  headSize: n(0.94, 1.08, 1), height: n(1.65, 1.85, 1.75), build: n(0.92, 1.1, 1), walkSpeed: n(0.9, 1.4, 1.35),
  skin: c('#cead86'), hair1: c('#492e18'), brows: c('#3e3429'), eyes: c('#31251c'), top1: c('#969083'), top2: c('#b4b4b4'), bottom1: c('#333f47'),
  shoes1: c('#7d2734'), soles: c('#b4b4b4'), accent: c('#af8749'), gear: c('#3c5a6e'), accessory: c('#a03a3a'),
};
/** Kit faces whose head part carries its own headgear: no extra hat or glasses, hair hidden as under a hat. */
export const HEADGEAR_FACES: ReadonlySet<string> = new Set(['farmer', 'king', 'spacesuit', 'swat', 'worker', 'woman-medieval', 'woman-witch', 'woman-worker']);
export const ACCESSORY_SLOTS = ['facialHair', 'scarf', 'gloves', 'mask', 'jewellery'] as const;
export const SHAPE_KEYS = ['shoulders', 'chest', 'hips', 'weight'] as const;
export const V2_KEYS = [...ACCESSORY_SLOTS, 'accessory', ...SHAPE_KEYS] as const;
export const SIZE_KEYS = ['headSize', 'height', 'build', 'walkSpeed'] as const;
type SizeKey = typeof SIZE_KEYS[number];
const SIZE_STEP: Record<SizeKey, number> = { headSize: 0.005, height: 0.01, build: 0.01, walkSpeed: 0.01 };
const round = (v: number, step: number) => +(Math.round(v / step) * step).toFixed(4);
export type Look = {
  preset: 'none' | 'casual' | 'punk' | 'woman'; frame: 'masc' | 'fem';
  face: string; hair: string; top: string; bottom: string; shoes: string;
  hat: string; glasses: string; bag: string; pattern: 'plain' | 'stripes' | 'checks' | 'knit';
  shoulders: number; chest: number; hips: number; weight: number;
  facialHair: 'none' | 'mustache' | 'goatee' | 'beard'; scarf: 'none' | 'scarf'; gloves: 'none' | 'gloves'; mask: 'none' | 'cloth'; jewellery: 'none' | 'earrings' | 'necklace' | 'both'; accessory: string;
  headSize: number; height: number; build: number; walkSpeed: number;
  skin: string; hair1: string; brows: string; eyes: string; top1: string; top2: string; bottom1: string; shoes1: string; soles: string; accent: string; gear: string;
};
export type Preset = 'casual' | 'punk' | 'woman';
const NO_ACCESSORIES = { facialHair: 'none', scarf: 'none', gloves: 'none', mask: 'none', jewellery: 'none', accessory: '#a03a3a', shoulders: 1, chest: 1, hips: 1, weight: 1 } as const;
/** The classic looks as explicit params; the kit's exact linear palette applies while `preset` is set. */
export const PRESET_LOOKS: Readonly<Record<Preset, Omit<Look, 'preset'>>> = Object.freeze({
  casual: { frame: 'masc', face: 'open', hair: 'short', top: 'shirt', bottom: 'jeans', shoes: 'sneakers', hat: 'none', glasses: 'none', bag: 'none', pattern: 'plain', headSize: 1, height: 1.75, build: 1, walkSpeed: 1.35,
    skin: '#cead86', hair1: '#492e18', brows: '#3e3429', eyes: '#31251c', top1: '#969083', top2: '#b4b4b4', bottom1: '#333f47', shoes1: '#7d2734', soles: '#b4b4b4', accent: '#af8749', gear: '#3c5a6e', ...NO_ACCESSORIES },
  punk: { frame: 'masc', face: 'pierced', hair: 'mohawk', top: 'jacket', bottom: 'ripped', shoes: 'boots', hat: 'none', glasses: 'none', bag: 'none', pattern: 'plain', headSize: 1, height: 1.75, build: 1, walkSpeed: 1.35,
    skin: '#cead86', hair1: '#7c0f1f', brows: '#3e3429', eyes: '#31251c', top1: '#242424', top2: '#b4b4b4', bottom1: '#333f47', shoes1: '#242424', soles: '#242424', accent: '#af8749', gear: '#3c5a6e', ...NO_ACCESSORIES },
  woman: { frame: 'fem', face: 'soft', hair: 'bob', top: 'tank', bottom: 'slacks', shoes: 'flats', hat: 'none', glasses: 'none', bag: 'none', pattern: 'plain', headSize: 1, height: 1.75, build: 1, walkSpeed: 1.35,
    skin: '#cead86', hair1: '#8b7547', brows: '#3e3429', eyes: '#31251c', top1: '#b4b4b4', top2: '#b4b4b4', bottom1: '#9e6238', shoes1: '#3f3f3f', soles: '#3f3f3f', accent: '#af8749', gear: '#3c5a6e', ...NO_ACCESSORIES },
});

/** Params checked against the def (world-compiler's checkFields for these three field types); unknown keys and bad
 *  values are refused, as today. */
export function checkLook(params: unknown): Partial<Look> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('look must be an object');
  if (Object.keys(params).length > 48) throw new Error('look has at most 48 keys');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const f = Object.hasOwn(PARAMS, k) ? PARAMS[k] : undefined;
    if (!f) throw new Error(`unknown field ${k}`);
    if (f.type === 'number' && (typeof v !== 'number' || v < f.min || v > f.max)) throw new Error(`${k} must be a number ${f.min}..${f.max}`);
    if (f.type === 'enum' && (typeof v !== 'string' || !f.values.includes(v))) throw new Error(`${k} must be one of ${f.values.join(', ')}`);
    if (f.type === 'color' && (typeof v !== 'string' || !/^#[0-9a-f]{6}$/.test(v))) throw new Error(`${k} must be #rrggbb`);
    out[k] = v;
  }
  return out as Partial<Look>;
}
/** The full look: defaults filled, a preset expanded to its parts and colours (preset kept as the marker that the kit's
 *  exact palette applies), sizes rounded. */
export function resolveLook(params: unknown): Look {
  const p = checkLook(params ?? {}) as Record<string, unknown>;
  for (const [k, f] of Object.entries(PARAMS)) if (p[k] === undefined) p[k] = f.default;
  const v = p as Look;
  const size = { ...Object.fromEntries(SIZE_KEYS.map((k) => [k, round(v[k], SIZE_STEP[k])])), ...Object.fromEntries(SHAPE_KEYS.map((k) => [k, round(v[k], 0.01)])) };
  if (v.preset !== 'none') return { preset: v.preset, ...PRESET_LOOKS[v.preset], ...Object.fromEntries(V2_KEYS.map((k) => [k, v[k]])), ...size } as Look;
  return { ...v, ...size };
}

/** Palette slot order of the kit (kit.json `slots`). */
export const SLOTS = ['skin', 'skinShade', 'hair', 'hairShade', 'brows', 'eyes', 'top1', 'top2', 'bottom', 'shoes', 'soles', 'accent', 'gear', 'gearDark', 'lens', 'spare'] as const;
export type Slot = typeof SLOTS[number];
const lin = (hex: string): [number, number, number] => [1, 3, 5].map((i) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }) as [number, number, number];
const LEGACY_SKIN_SHADE = [0.486888 / 0.617207, 0.33064 / 0.417885, 0.189617 / 0.238398];
const PATTERN_ID = { plain: 0, stripes: 1, checks: 2, knit: 3 } as const;
/** Linear RGB per palette slot (16 × 3) and the pattern id; `legacy` is the kit's exact factors for a preset. */
export function paletteOf(look: Look, legacy?: Partial<Record<Slot, readonly number[]>>): { palette: Float32Array; pattern: number } {
  const c: Record<Slot, readonly number[]> = {
    skin: lin(look.skin), skinShade: lin(look.skin).map((v, i) => v * LEGACY_SKIN_SHADE[i]), hair: lin(look.hair1), hairShade: lin(look.hair1).map((v) => v * 0.62),
    brows: lin(look.brows), eyes: lin(look.eyes), top1: lin(look.top1), top2: lin(look.top2), bottom: lin(look.bottom1), shoes: lin(look.shoes1), soles: lin(look.soles),
    accent: lin(look.accent), gear: lin(look.gear), gearDark: lin(look.gear).map((v) => v * 0.35), lens: lin('#16191d'), spare: lin(look.accessory) };
  if (look.preset !== 'none' && legacy) for (const [k, v] of Object.entries(legacy)) if (v) c[k as Slot] = v;
  const palette = new Float32Array(SLOTS.length * 3);
  SLOTS.forEach((s, i) => palette.set(c[s], i * 3));
  return { palette, pattern: PATTERN_ID[look.pattern] };
}
/** One key per resolved look: its params in key order (equal looks share one composed body). */
export function lookKey(look: Look): string {
  return JSON.stringify(Object.keys(PARAMS).map((k) => look[k as keyof Look]));
}
