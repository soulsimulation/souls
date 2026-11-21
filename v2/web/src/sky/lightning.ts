// A creator's lightning strike (#3695), as today's `apps/web/src/WorldLightning.ts` draws a god's strike: a jagged bolt
// from the cloud base to the ground with a few branches, flickering for under half a second, a sky-wide flash (the
// scene's and the dome's cloud deck, strongest toward the strike), and thunder after distance / 343 m/s, a crack when
// it is close and a long low rumble when it is far (WebAudio, synthesised; the browser lets it sound after the first
// click or key). The strike is the world node's `strike` field (`record.ts`), `[x mm, z mm, world µs]`: drawn once, when
// the world time the page shows reaches it; a strike already older than `FRESH_US` when the page first reads it (an
// arrival, a reload) is not drawn. Presentation only; nothing here is authoritative. Not here: today's storm strikes
// of its own, and the bolt's point light (the flash lights the scene).
import * as THREE from 'three';

export const SOUND_MPS = 343;
/** How long after its world time a strike is still drawn when the page first reads it, µs. */
export const FRESH_US = 15_000_000;
const CLOUD_BASE = 230; // m above the ground where a bolt leaves the cloud
const BOLT_LIFE = 0.45; // s a bolt stays drawn (it flickers 2–3 times)

export type Strike = [number, number, number];

/** Whether `strike` is drawn at world time `t` (µs), `seen` the strike last read: once, and only while fresh. */
export function due(strike: Strike | null, t: number | null, seen: string | null): { fire: boolean; seen: string | null } {
  if (!strike || t === null) return { fire: false, seen };
  const key = strike.join(',');
  if (key === seen) return { fire: false, seen };
  if (t < strike[2]) return { fire: false, seen }; // not yet: the page shows a time before it
  return { fire: t - strike[2] <= FRESH_US, seen: key };
}

const rnd = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822519) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
};

type Bolt = { group: THREE.Group; born: number };

export class Lightning {
  readonly group = new THREE.Group();
  private seen: string | null = null;
  private bolts: Bolt[] = [];
  private flash = new THREE.HemisphereLight(0xdfe7ff, 0x3a4060, 0);
  private flashLevel = 0;
  private toward = new THREE.Vector3(0, 1, 0);
  private audio: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private readonly unlock = () => this.ensureAudio();
  private readonly groundAt: (x: number, z: number) => number | null;
  private readonly core = new THREE.MeshBasicMaterial({ color: 0xf4f7ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  private readonly glow = new THREE.MeshBasicMaterial({ color: 0x9db4ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
  /** What the page has drawn and played, for a capture or a test. */
  readonly heard: { x: number; z: number; dist: number; delay: number; sound: 'scheduled' | 'locked' }[] = [];

  constructor(groundAt: (x: number, z: number) => number | null) {
    this.groundAt = groundAt;
    this.group.name = 'lightning';
    this.group.add(this.flash);
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, this.unlock, { passive: true });
  }

  /** Each frame: the strike the record holds at world time `t` (µs), the camera, the frame's seconds, and the dome's
   *  flash uniform (x intensity, yzw unit direction toward the strike). */
  update(strike: Strike | null, t: number | null, camera: THREE.Camera, dt: number, domeFlash?: THREE.Vector4): void {
    const d = due(strike, t, this.seen);
    this.seen = d.seen;
    if (d.fire && strike) this.fire(strike, camera);
    const now = performance.now() / 1000;
    for (const b of [...this.bolts]) {
      const age = now - b.born;
      if (age > BOLT_LIFE) {
        this.group.remove(b.group);
        b.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        this.bolts.splice(this.bolts.indexOf(b), 1);
        continue;
      }
      // the return strokes: bright, dim, bright again, fading
      const k = (age < 0.07 ? 1 : age < 0.12 ? 0.25 : age < 0.2 ? 0.95 : age < 0.26 ? 0.2 : 0.7) * (1 - age / BOLT_LIFE);
      b.group.visible = k > 0.05;
      b.group.children.forEach((c, i) => { ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (i % 2 ? 0.22 : 1) * Math.min(1, k * 1.3); });
    }
    this.flashLevel = Math.max(0, this.flashLevel - dt * 5.5);
    this.flash.intensity = Math.min(0.7, this.flashLevel * 0.35);
    domeFlash?.set(Math.min(1.5, this.flashLevel), this.toward.x, this.toward.y, this.toward.z);
  }

  private fire([xMm, zMm]: Strike, camera: THREE.Camera): void {
    const x = xMm / 1000, z = zMm / 1000;
    const gy = this.groundAt(x, z) ?? 0, r = rnd(Math.round(x * 31) + Math.round(z * 17) + 7919);
    const bolt = new THREE.Group();
    bolt.name = `bolt ${x},${z}`;
    // the main channel: jagged, wandering less as it nears the ground
    const pts: THREE.Vector3[] = [], top = new THREE.Vector3(x + (r() - 0.5) * 60, gy + CLOUD_BASE, z + (r() - 0.5) * 60);
    const N = 30;
    let ox = 0, oz = 0;
    for (let i = 0; i <= N; i++) {
      const f = i / N, wob = (1 - f) * 11 + 2.5;
      ox = ox * 0.55 + (r() - 0.5) * wob * 2;
      oz = oz * 0.55 + (r() - 0.5) * wob * 2;
      const k = i === 0 || i === N ? 0 : 1;
      pts.push(new THREE.Vector3(top.x + (x - top.x) * f + ox * k, top.y + (gy - top.y) * f + (k ? (r() - 0.5) * 3 : 0), top.z + (z - top.z) * f + oz * k));
    }
    const strand = (p: THREE.Vector3[], radius: number) => {
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < p.length; i++) path.add(new THREE.LineCurve3(p[i - 1]!, p[i]!));
      bolt.add(new THREE.Mesh(new THREE.TubeGeometry(path, p.length * 2, radius, 5, false), this.core));
      bolt.add(new THREE.Mesh(new THREE.TubeGeometry(path, p.length * 2, radius * 3.5, 6, false), this.glow));
    };
    strand(pts, 0.55);
    // branches off the upper two thirds
    const branches = 2 + Math.floor(r() * 3);
    for (let b = 0; b < branches; b++) {
      const from = pts[2 + Math.floor(r() * (N * 0.6))]!, dir = new THREE.Vector3(r() - 0.5, -0.5 - r() * 0.5, r() - 0.5).normalize(), len = 25 + r() * 45, bp = [from.clone()];
      for (let i = 1; i <= 7; i++) bp.push(from.clone().addScaledVector(dir, (len * i) / 7).add(new THREE.Vector3((r() - 0.5) * 7, (r() - 0.5) * 2, (r() - 0.5) * 7)));
      strand(bp, 0.18);
    }
    this.group.add(bolt);
    this.bolts.push({ group: bolt, born: performance.now() / 1000 });
    this.flashLevel = Math.min(2, this.flashLevel + 1.6);
    const cam = camera.getWorldPosition(new THREE.Vector3());
    this.toward.set(x - cam.x, gy + CLOUD_BASE * 0.5 - cam.y, z - cam.z).normalize();
    // thunder: after the distance at the speed of sound, louder and sharper the nearer
    const dist = Math.hypot(cam.x - x, cam.y - gy, cam.z - z), delay = dist / SOUND_MPS;
    const gain = Math.max(0.04, Math.min(1, 1 / (1 + dist / 260)));
    const sound = this.thunder(delay, dist, gain, r) ? 'scheduled' : 'locked';
    this.heard.push({ x, z, dist: Math.round(dist), delay: Math.round(delay * 100) / 100, sound });
    if (this.heard.length > 40) this.heard.shift();
  }

  private ensureAudio(): void {
    try {
      if (!this.audio) {
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const AC = w.AudioContext ?? w.webkitAudioContext;
        if (!AC) return;
        this.audio = new AC();
        this.master = this.audio.createGain();
        this.master.gain.value = 0.8;
        this.master.connect(this.audio.destination);
        const len = this.audio.sampleRate * 6, buf = this.audio.createBuffer(1, len, this.audio.sampleRate), d = buf.getChannelData(0);
        // brown-ish noise: thunder is mostly low frequencies
        let last = 0;
        for (let i = 0; i < len; i++) { const n = Math.random() * 2 - 1; last = (last + 0.035 * n) / 1.035; d[i] = last * 3.2 + n * 0.08; }
        this.noise = buf;
      }
      if (this.audio.state === 'suspended') void this.audio.resume();
    } catch { /* no audio: silent lightning */ }
  }

  /** Schedules one thunder; false when the browser has not allowed sound yet. */
  private thunder(delay: number, dist: number, gain: number, r: () => number): boolean {
    const a = this.audio;
    if (!a || !this.noise || !this.master || a.state !== 'running') return false;
    const t0 = a.currentTime + delay;
    if (dist < 700) { // the crack of a near strike
      const src = a.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 1.6;
      const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const g = a.createGain(); g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * (1 - dist / 700) * 1.4), t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      src.connect(hp).connect(g).connect(this.master); src.start(t0, r() * 4); src.stop(t0 + 0.4);
    }
    // the rumble: rolls for 3–6 s, longer and darker the farther away
    const len = 3 + Math.min(3, dist / 600) + r(), src = a.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90 + 900 / (1 + dist / 300); lp.Q.value = 0.7;
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t0);
    const attack = 0.04 + Math.min(0.6, dist / 2500);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    let t = t0 + attack;
    for (let k = 0; k < 4; k++) { t += ((len - attack) / 6) * (0.6 + r() * 0.8); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * (0.25 + r() * 0.7) * (1 - k / 5)), t); }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    src.connect(lp).connect(g).connect(this.master); src.start(t0, r() * 3); src.stop(t0 + len + 0.1);
    return true;
  }

  /** For a capture: the bolts drawn now, the flash and what was heard. */
  inspect() { return { bolts: this.bolts.length, flash: Math.round(this.flashLevel * 100) / 100, heard: this.heard.slice(-6), audio: this.audio?.state ?? 'locked' }; }
}
