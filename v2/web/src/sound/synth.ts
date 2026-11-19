// The page's sounds as samples (V21, #2765): every one procedural, as today's site makes them (no audio files, nothing
// to license or download), written once per sound and voicing into a buffer the page plays from any offset. A sound
// heard part-way (a seek into it) is the same buffer started later, so it is the same sound. Pure, so the same bytes
// come out in Node and in any browser: the noise is a seeded generator, never Math.random.

/** The one-shot sounds the record makes heard, and their lengths in seconds. */
export const SHOTS = { step: 0.16, 'door-open': 1.1, 'door-shut': 0.5, thud: 0.32, click: 0.07 } as const;
export type ShotSound = keyof typeof SHOTS;
/** The loops a kind of thing makes (sound-plan's kinds that imported Eden uses, and the ones near them). */
export const LOOPS = ['water', 'stream', 'waves', 'wind', 'leaves', 'flag', 'hum', 'creak', 'fire', 'engine', 'bees', 'birds', 'waterfowl', 'frogs', 'crickets'] as const;
export type LoopSound = (typeof LOOPS)[number];
/** A loop's length, s: long enough that its pattern is not heard to repeat. */
export const LOOP_SECONDS = 4;

function rng(seed: number) {
  let s = (seed * 0x9e3779b1 + 0x6d2b79f5) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A one-pole low-pass coefficient for `hz` at `sr`. */
const pole = (hz: number, sr: number) => 1 - Math.exp((-2 * Math.PI * hz) / sr);

/** White noise through a band between `lo` and `hi` Hz (two one-pole low-passes, subtracted). */
function band(n: number, sr: number, lo: number, hi: number, r: () => number): Float32Array {
  const out = new Float32Array(n), a = pole(hi, sr), b = pole(lo, sr);
  let p = 0, q = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    p += a * (w - p);
    q += b * (p - q);
    out[i] = p - (lo > 0 ? q : 0);
  }
  return out;
}
/** Adds a decaying sine at `t0` s: `hz`, time constant `tau` s, level `amp`, and an optional sweep to `hz1`. */
function ping(out: Float32Array, sr: number, t0: number, hz: number, tau: number, amp: number, hz1 = hz) {
  const i0 = Math.floor(t0 * sr), len = Math.min(out.length - i0, Math.ceil(tau * 6 * sr));
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const f = hz + ((hz1 - hz) * i) / len;
    ph += (2 * Math.PI * f) / sr;
    out[i0 + i] += amp * Math.sin(ph) * Math.exp(-i / (tau * sr));
  }
}
/** Adds a burst of band noise at `t0` s decaying with `tau`. */
function burst(out: Float32Array, sr: number, t0: number, tau: number, amp: number, lo: number, hi: number, r: () => number) {
  const i0 = Math.floor(t0 * sr), len = Math.min(out.length - i0, Math.ceil(tau * 6 * sr)), b = band(len, sr, lo, hi, r);
  for (let i = 0; i < len; i++) out[i0 + i] += amp * b[i] * Math.exp(-i / (tau * sr));
}
function normalise(out: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < out.length; i++) out[i] *= peak / m;
  return out;
}

/** One one-shot sound's samples, mono at `sr`, voiced by `variant`. */
export function shot(sound: ShotSound, variant: number, sr: number): Float32Array {
  const r = rng(1000 + variant * 7 + sound.length), out = new Float32Array(Math.ceil(SHOTS[sound] * sr)), v = variant % 4;
  if (sound === 'step') {
    burst(out, sr, 0.004, 0.022, 1, 80, 900 + 150 * v, r);
    ping(out, sr, 0, 85 + 10 * v, 0.03, 0.5);
    burst(out, sr, 0.03, 0.012, 0.25, 1500, 5000, r); // the heel rolling off
    return normalise(out, 0.55);
  }
  if (sound === 'door-open') {
    burst(out, sr, 0, 0.004, 0.9, 1500, 7000, r); // the latch
    burst(out, sr, 0.03, 0.003, 0.6, 1500, 7000, r);
    // The hinge: stick-slip, a train of little knocks whose rate rises and falls, each ringing the door's wood.
    let t = 0.12;
    while (t < SHOTS['door-open'] - 0.1) {
      const k = (t - 0.12) / 0.85, rate = 22 + 40 * Math.sin(Math.PI * Math.min(1, k)) + 6 * r();
      ping(out, sr, t, 620 + 90 * v + 120 * k, 0.004, 0.5 * Math.sin(Math.PI * Math.min(1, k)) + 0.1);
      t += 1 / rate;
    }
    return normalise(out, 0.6);
  }
  if (sound === 'door-shut') {
    ping(out, sr, 0, 62 + 6 * v, 0.07, 1, 50);
    burst(out, sr, 0, 0.018, 0.8, 60, 1200, r);
    burst(out, sr, 0.055, 0.004, 0.5, 1500, 7000, r); // the latch catching
    return normalise(out, 0.7);
  }
  if (sound === 'thud') {
    ping(out, sr, 0, 78, 0.05, 1, 60);
    burst(out, sr, 0, 0.03, 0.6, 60, 700, r);
    return normalise(out, 0.45);
  }
  burst(out, sr, 0, 0.004, 1, 2000, 9000, r); // click
  return normalise(out, 0.4);
}

/** One loop's samples, `LOOP_SECONDS` long, its end crossfaded into its start so it loops with no seam. */
export function loop(sound: LoopSound, variant: number, sr: number): Float32Array {
  const n = LOOP_SECONDS * sr, fade = Math.floor(0.25 * sr), r = rng(5000 + variant * 13 + LOOPS.indexOf(sound) * 101);
  const raw = new Float32Array(n + fade), at = (s: number) => s / (n / sr); // 0..1 through the loop
  const add = (b: Float32Array, gain: (i: number) => number) => { for (let i = 0; i < raw.length; i++) raw[i] += b[i] * gain(i); };
  const slow = (hz: number, depth: number, ph = r() * 6.28) => (i: number) => 1 - depth + depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * hz * (i / sr) + ph));
  const events = (per: number, f: (t: number) => void) => { const k = Math.max(1, Math.round(per * LOOP_SECONDS)); for (let j = 0; j < k; j++) f((j + r() * 0.8) * (LOOP_SECONDS / k)); };
  switch (sound) {
    case 'water': add(band(raw.length, sr, 300, 2400 + 400 * variant, r), slow(0.5, 0.3)); events(10, (t) => ping(raw, sr, t, 500 + 900 * r(), 0.012, 0.6, 1200 + 900 * r())); break;
    case 'stream': add(band(raw.length, sr, 150, 1200, r), slow(0.25, 0.3)); events(5, (t) => ping(raw, sr, t, 400 + 500 * r(), 0.015, 0.4, 900)); break;
    case 'waves': add(band(raw.length, sr, 60, 700, r), (i) => 0.25 + 0.75 * Math.sin(Math.PI * at(i / sr)) ** 2); break;
    case 'wind': add(band(raw.length, sr, 40, 380, r), slow(0.25, 0.6)); break;
    case 'leaves': { const a = slow(0.5, 0.7), b = slow(1.5, 0.4); add(band(raw.length, sr, 1200, 6000, r), (i) => a(i) * b(i)); break; }
    case 'flag': add(band(raw.length, sr, 300, 3000, r), (i) => Math.max(0, Math.sin(2 * Math.PI * 2.5 * (i / sr) + 2 * Math.sin(i / sr))) ** 3); break;
    case 'hum': for (let i = 0; i < raw.length; i++) raw[i] = Math.sin((2 * Math.PI * 50 * i) / sr) + 0.5 * Math.sin((2 * Math.PI * 100 * i) / sr); break;
    case 'creak': events(0.8, (t) => { for (let k = 0; k < 18; k++) ping(raw, sr, t + k / (25 + 10 * r()), 420 + 60 * variant, 0.005, 0.5 * Math.sin((Math.PI * k) / 18)); }); add(band(raw.length, sr, 40, 300, r), () => 0.15); break;
    case 'fire': add(band(raw.length, sr, 50, 700, r), slow(0.7, 0.4)); events(14, (t) => burst(raw, sr, t, 0.003, 1.5 * r(), 1500, 8000, r)); break;
    case 'engine': events(18, (t) => ping(raw, sr, t, 55 + 8 * variant, 0.03, 1)); add(band(raw.length, sr, 40, 400, r), () => 0.3); break;
    case 'bees': { let ph = 0; for (let i = 0; i < raw.length; i++) { ph += (2 * Math.PI * (215 + 12 * Math.sin(i / sr * 3.1) + 6 * Math.sin(i / sr * 11))) / sr; raw[i] = ((ph / Math.PI) % 2) - 1; } const lp = pole(900, sr); let y = 0; for (let i = 0; i < raw.length; i++) raw[i] = y += lp * (raw[i] - y); add(raw.slice(), slow(0.3, 0.5)); break; }
    case 'birds': events(3 + variant, (t) => { const f = 2500 + 1500 * r(); for (let k = 0; k < 2 + Math.floor(4 * r()); k++) ping(raw, sr, t + k * 0.09, f, 0.02, 0.6, f * (0.8 + 0.5 * r())); }); break;
    case 'waterfowl': events(1, (t) => { for (let k = 0; k < 3; k++) { ping(raw, sr, t + k * 0.22, 330, 0.035, 0.7, 280); ping(raw, sr, t + k * 0.22, 990, 0.025, 0.4, 840); } }); break;
    case 'frogs': events(2.5, (t) => { for (let k = 0; k < 6; k++) ping(raw, sr, t + k * 0.03, 420 + 40 * variant, 0.008, 0.7); }); break;
    case 'crickets': events(2, (t) => { for (let k = 0; k < 14; k++) ping(raw, sr, t + k * 0.022, 4600, 0.004, 0.5); }); break;
  }
  const out = raw.slice(0, n);
  for (let i = 0; i < fade; i++) { const k = i / fade; out[i] = out[i] * k + raw[n + i] * (1 - k); }
  return normalise(out, 0.5);
}
