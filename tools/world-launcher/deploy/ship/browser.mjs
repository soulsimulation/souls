// Real Chrome for the post-release walks (ship.sh): the shared Chrome lease and Playwright, as the release owner's scratch
// scripts used them (team/ops/chrome-lease.mjs, 3 slots, waits up to 45 min; Playwright from mars/viewer).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// SIM_CHROME_LEASE: a machine-wide lease module shared by several checkouts (optional).
const TEAM_LEASE = process.env.SIM_CHROME_LEASE || '';

/** Take a Chrome slot; returns release(). The team's shared lease when it exists, else this checkout's (same slots). */
export async function lease(label) {
  if (TEAM_LEASE && existsSync(TEAM_LEASE)) return (await import(TEAM_LEASE)).chromeLease(label);
  return (await import('../../../god-skill/lib/chrome-lease.mjs')).chromeLease(label, { waitMs: 45 * 60_000 });
}

/** Playwright's chromium: this checkout's mars/viewer, else the canonical checkout's, else SHIP_PLAYWRIGHT_FROM. */
export function chromium() {
  const bases = [process.env.SHIP_PLAYWRIGHT_FROM, resolve(ROOT, 'mars/viewer')].filter(Boolean);
  for (const b of bases) { try { return createRequire(resolve(b, 'package.json'))('@playwright/test').chromium; } catch { /* next */ } }
  throw Error(`no @playwright/test under ${bases.join(', ')} (pnpm install in mars/viewer, or set SHIP_PLAYWRIGHT_FROM)`);
}

// The GPU runner (release.yml eyes=gpu-runner): Playwright's own Chromium with a hardware GL renderer instead of real
// Chrome. eyes.mjs --gpu hardware picks the first candidate whose WebGL renderer is not software (as the proof recorder's
// SIM_PROOF_GPU=hardware does) and hands it to every check as SHIP_GPU=<label>, with SwiftShader disabled, so no check
// can fall back to it. Unset: real Chrome (channel chrome) with each check's own flags, as on a workstation.
export const GPU_CANDIDATES = [
  { label: 'angle-vulkan', args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] },
  { label: 'angle-gl-egl', args: ['--use-gl=angle', '--use-angle=gl-egl'] },
  { label: 'egl', args: ['--use-gl=egl'] },
];
const GPU_BASE = ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-gpu-rasterization', '--disable-software-rasterizer'];
/** A WebGL renderer string → software (SwiftShader, llvmpipe, softpipe) or not. */
export const softwareGl = (renderer) => !renderer || /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
/** Chromium launch options for a release check: `args` are its own flags for real Chrome; SHIP_GPU=<label> replaces them. */
export function launchOptions(args, env = process.env) {
  if (!env.SHIP_GPU) return { channel: 'chrome', headless: true, args };
  const c = GPU_CANDIDATES.find((x) => x.label === env.SHIP_GPU);
  if (!c) throw Error(`SHIP_GPU=${env.SHIP_GPU}: not one of ${GPU_CANDIDATES.map((x) => x.label).join(', ')}`);
  return { headless: true, args: [...GPU_BASE, ...c.args] };
}
/** The WebGL vendor and renderer a launched browser draws with. */
export async function readGl(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      if (!gl) return { vendor: null, renderer: null };
      const x = gl.getExtension('WEBGL_debug_renderer_info');
      return { vendor: gl.getParameter(x ? x.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) };
    });
  } finally { await page.close().catch(() => {}); }
}
/** The first candidate with a hardware renderer → {label, vendor, renderer, tried}; none → {label: null, tried}. */
export async function pickHardwareGl(pw = chromium()) {
  const tried = [];
  for (const c of GPU_CANDIDATES) {
    let b; try { b = await pw.launch(launchOptions([], { SHIP_GPU: c.label })); } catch (e) { tried.push({ label: c.label, error: String(e?.message ?? e).split('\n')[0].slice(0, 160) }); continue; }
    try { const gl = await readGl(b); tried.push({ label: c.label, renderer: gl.renderer }); if (!softwareGl(gl.renderer)) return { label: c.label, ...gl, tried }; }
    catch (e) { tried.push({ label: c.label, error: String(e?.message ?? e).split('\n')[0].slice(0, 160) }); }
    finally { await b.close().catch(() => {}); }
  }
  return { label: null, tried };
}
