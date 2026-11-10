// Proof-video presets (#1644): one recorder for PR proofs, social clips and highlight embeds. A preset names an aspect,
// a quality, a frame rate and an encoding; flags override each. The world page is always recorded at the output's own
// aspect (never cropped afterwards, so a label can't be cut off): a landscape page is desktop-sized (720 CSS px high),
// a portrait page phone-sized (405 CSS px wide), and the device scale factor makes the output pixels. The frame rate is
// set by ffmpeg's fps filter, which repeats or drops frames and never changes speed: every preset is real speed.

/** The original viewports. `pr-proof` without overrides records exactly these, as before #1644. */
export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export const PRESETS = {
  'pr-proof': { use: 'GitHub PR proof (the default): small, quick to upload and load; the viewport flag picks desktop or phone', aspect: null, quality: null, fps: null, crf: 23, panel: false },
  'social-landscape': { use: 'Social media, 16:9: 1920x1080 at 30 fps', aspect: 'landscape', quality: 'high', fps: 30, crf: 18, panel: false },
  'social-portrait': { use: 'Social media, 9:16 (reels, stories, shorts): 1080x1920 at 30 fps', aspect: 'portrait', quality: 'high', fps: 30, crf: 18, panel: false },
  highlight: { use: 'Clips embedded in a highlights page: 1280x720 at 30 fps, light enough to autoplay', aspect: 'landscape', quality: 'low', fps: 30, crf: 21, panel: false },
};
export const PRESET_NAMES = Object.keys(PRESETS);

const CSS_SHORT = { landscape: 720, portrait: 405 };
const OUT_SHORT = { low: 720, high: 1080 };
const PANEL_SHARE = 0.3;                          // of the long edge: the width in landscape, the height in portrait
const even = (n) => Math.max(2, 2 * Math.round(n / 2));

/** parseSize("1920x1080") → {width, height}; throws on anything else. */
export function parseSize(s) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(s ?? ''));
  if (!m) throw Error(`--size must be WIDTHxHEIGHT, e.g. 1920x1080 (got ${s})`);
  return { width: even(+m[1]), height: even(+m[2]) };
}

/** resolvePlan({preset, viewport, fps, quality, size, aspect, panel}) → everything the take and the encode need.
 *  `world` is the recorded page in output pixels; `css` its viewport; `out` the final frame (world plus panel). */
export function resolvePlan(o = {}) {
  const name = o.preset ?? 'pr-proof', p = PRESETS[name];
  if (!p) throw Error(`--preset must be one of ${PRESET_NAMES.join(', ')} (got ${name})`);
  if (o.viewport && !VIEWPORTS[o.viewport]) throw Error('--viewport must be desktop or phone');
  if (o.aspect && !CSS_SHORT[o.aspect]) throw Error('--aspect must be landscape or portrait');
  if (o.quality && !OUT_SHORT[o.quality]) throw Error('--quality must be low or high');
  const fps = o.fps != null ? Number(o.fps) : p.fps;
  if (fps != null && !(Number.isInteger(fps) && fps >= 5 && fps <= 60)) throw Error('--fps must be a whole number from 5 to 60');
  const panelOn = o.panel == null ? p.panel : o.panel === true || o.panel === 'on';
  const size = o.size ? parseSize(o.size) : null;
  const custom = size || o.aspect || o.quality || panelOn || name !== 'pr-proof';
  const base = { preset: name, use: p.use, fps, crf: p.crf };

  if (!custom) {                                  // today's output, unchanged
    const vp = VIEWPORTS[o.viewport ?? 'desktop'], { width, height } = vp.viewport;
    return { ...base, viewport: o.viewport ?? 'desktop', aspect: width >= height ? 'landscape' : 'portrait', context: { ...vp }, world: { width, height }, out: { width, height }, panel: null, scale: 1 };
  }
  const aspect = size ? (size.width >= size.height ? 'landscape' : 'portrait') : o.aspect ?? p.aspect ?? (o.viewport === 'phone' ? 'portrait' : 'landscape');
  const outShort = size ? Math.min(size.width, size.height) : OUT_SHORT[o.quality ?? p.quality ?? 'low'];
  const out = size ?? (aspect === 'landscape' ? { width: even(outShort * 16 / 9), height: outShort } : { width: outShort, height: even(outShort * 16 / 9) });
  const dsf = outShort / CSS_SHORT[aspect];
  let world = { ...out }, panel = null;
  if (panelOn) {
    if (aspect === 'landscape') { const w = even(out.width * PANEL_SHARE); panel = { side: 'right', width: w, height: out.height }; world = { width: out.width - w, height: out.height }; }
    else { const h = even(out.height * PANEL_SHARE); panel = { side: 'bottom', width: out.width, height: h }; world = { width: out.width, height: out.height - h }; }
  }
  const css = { width: Math.round(world.width / dsf), height: Math.round(world.height / dsf) };
  const mobile = aspect === 'portrait';
  return {
    ...base, viewport: mobile ? 'phone' : 'desktop', aspect, out, world, panel,
    context: { viewport: css, deviceScaleFactor: dsf, ...(mobile ? { isMobile: true, hasTouch: true } : {}) },
    scale: Math.max(1, outShort / 720),
    // A screencast is captured in CSS pixels under an emulated scale factor; a browser launched with this flag
    // composites (and so records) in device pixels, so the output is sharp, not upscaled.
    forceScale: dsf !== 1 ? +dsf.toFixed(4) : null,
  };
}

/** One line per preset for help text and docs. */
export const presetHelp = () => PRESET_NAMES.map((n) => `  ${n.padEnd(17)} ${PRESETS[n].use}`).join('\n');
