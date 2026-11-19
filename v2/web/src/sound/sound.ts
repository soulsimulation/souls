// The world heard on the page (V21, #2765): each frame, what `plan.ts` says is heard at the time drawn, played with
// WebAudio from `synth.ts`'s buffers, each placed at its source around the camera. Live and in replay it is fed the
// same rows (`record.ts`) and motion samples, and asks the same question of the time drawn, so a sound starts with the
// moment it belongs to; a jump of the clock (a seek, a cut) stops every voice and the plan is asked again, with nothing
// remembered from before. Before the visitor's first gesture the browser allows no sound: the switch says sound is off
// and the first click or key starts it. The switch silences effects and is remembered (`settings.ts`); of two open
// tabs, only the one that holds the focus sounds (`focus.ts`).
//
// `globalThis.v2sound` reports for the proof: `log()` every one-shot started (its world time, its offset, when it was
// heard by the performance clock), `frames()` the time drawn by the performance clock, `lags()` how far each sound's
// start fell from its drawn moment, `happened()` the record's sounds other than steps, `state()` the voices, and
// `record()` / `stop()` a recording of what was played.
import { audioFocus } from './focus.ts';
import { heardAt, lastingOf, plain, Steps, soundsOf, type Heard, type Lasting, type Sounding } from './plan.ts';
import type { Happened } from './record.ts';
import { loadSettings, saveSettings, type SoundSettings } from './settings.ts';
import { loop, shot, LOOPS, type LoopSound, type ShotSound } from './synth.ts';

type Vec = [number, number, number];
type Sample = readonly [string, string, number | null, number, number, number, number];
type NodeLike = { id: string; kind: string; outline?: number[][] };
/** The listener: the camera's position, the way it looks and its up, world metres. */
export type Ear = { pos: Vec; forward: Vec; up: Vec };
export type Placing = {
  /** A node's place in the world (m), or a point given in its frame (µm); null while it is not known. */
  where(node: string, local?: Vec): Vec | null;
  kindOf(node: string): string | undefined;
  heightAt(x: number, z: number): number | null;
};
type Voice = { src: AudioBufferSourceNode; gain: GainNode; pan: PannerNode; loop: boolean; ends: number };

/** A one-shot is scheduled at most AHEAD µs of world time before its moment (a slow frame, under software GL, can
 *  be a few hundred ms), and no earlier than two and a half frames before it, so a change in the clock's rate moves it
 *  little; a jump of the clock beyond these is a seek. */
const AHEAD = 600_000, BACK_JUMP = 100_000, FORWARD_JUMP = 2_000_000;
const store = () => { try { return localStorage; } catch { return null; } };

export class WorldSound {
  readonly settings: SoundSettings = loadSettings(store());
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private shots = new Map<string, Sounding>();
  private lasting = new Map<string, Lasting & { node: string }>();
  private steps = new Steps();
  private voices = new Map<string, Voice>();
  private started = new Map<string, number>();
  private lastT: number | null = null;
  private lastWall = 0;
  private rate = 1;
  private place: Placing;
  private button: HTMLButtonElement;
  private focus = audioFocus();
  private shotLog: { key: string; sound: string; at: number; offset: number; heardMs: number; fresh: boolean }[] = [];
  /** True until the first frame heard after a start, an unmute or a jump: what it starts part-way, it starts on purpose. */
  private fresh = true;
  private frameLog: [number, number][] = [];
  private recorder: { rec: MediaRecorder; parts: Blob[] } | null = null;

  constructor(place: Placing) {
    this.place = place;
    this.button = document.createElement('button');
    Object.assign(this.button.style, { position: 'fixed', top: '8px', right: '8px', zIndex: '10', font: '12px system-ui', padding: '4px 8px', opacity: '0.85' });
    document.body.append(this.button);
    // The switch: before sound has started, a click starts it (as any gesture does); after, it turns effects off or on.
    this.button.onclick = (e) => {
      e.stopPropagation();
      if (this.ctx?.state === 'running') this.toggle();
      else this.start();
    };
    const gesture = (e: Event) => { if (e.target !== this.button && this.ctx?.state !== 'running') this.start(); };
    addEventListener('pointerdown', gesture, { capture: true });
    addEventListener('keydown', gesture, { capture: true });
    this.focus?.subscribe(() => this.label());
    this.label();
    Object.assign(globalThis, { v2sound: this.report() });
  }

  /** A part's rows, motion samples and changed nodes, live or from a history bundle. */
  part(nodes: readonly NodeLike[], removed: readonly string[], samples: readonly Sample[], rows: readonly Happened[]): void {
    for (const id of removed) for (const k of [...this.lasting.keys()]) if (this.lasting.get(k)!.node === id) this.lasting.delete(k);
    for (const n of nodes) {
      const area = n.outline && n.outline.length > 2 ? n.outline.map(([x, z]) => [x / 1000, z / 1000] as [number, number]) : undefined;
      for (const l of lastingOf(n.id, n.kind, [NaN, NaN, NaN], area)) this.lasting.set(l.key, { ...l, node: n.id });
    }
    for (const s of soundsOf(rows, (id) => this.place.kindOf(id) ?? nodes.find((n) => n.id === id)?.kind)) this.shots.set(s.key, s);
    for (const s of this.steps.add(samples)) this.shots.set(s.key, s);
  }

  /** One frame at world time `t` (µs), heard from `ear`. */
  frame(t: number | null, ear: Ear): void {
    const wall = performance.now();
    if (t === null) return;
    this.frameLog.push([wall, t]);
    if (this.frameLog.length > 4000) this.frameLog.splice(0, 1000);
    const step = this.lastT === null ? 0 : t - this.lastT;
    if (this.lastT !== null) {
      if (t < this.lastT - BACK_JUMP || t > this.lastT + FORWARD_JUMP) this.cut();
      else if (wall > this.lastWall) this.rate = this.rate * 0.5 + 0.5 * Math.min(8, Math.max(0, (t - this.lastT) / ((wall - this.lastWall) * 1000)));
    }
    this.lastT = t;
    this.lastWall = wall;
    for (const [k, s] of this.shots) if (s.at < t - 10_000_000) this.shots.delete(k);
    for (const [k, at] of this.started) if (at < t - 10_000_000) this.started.delete(k);
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.settings.muted || !(this.focus?.audible() ?? true)) return void this.silence();
    const l = ctx.listener;
    l.positionX.value = ear.pos[0], l.positionY.value = ear.pos[1], l.positionZ.value = ear.pos[2];
    l.forwardX.value = ear.forward[0], l.forwardY.value = ear.forward[1], l.forwardZ.value = ear.forward[2];
    l.upX.value = ear.up[0], l.upY.value = ear.up[1], l.upZ.value = ear.up[2];
    const lasting: Lasting[] = [];
    for (const x of this.lasting.values()) {
      if (Number.isNaN(x.pos[0])) {
        if (x.area) {
          const c = x.area.reduce((s, p) => [s[0] + p[0] / x.area!.length, s[1] + p[1] / x.area!.length], [0, 0]);
          x.pos = [c[0], this.place.heightAt(c[0], c[1]) ?? 0, c[1]];
        } else x.pos = this.place.where(x.node) ?? x.pos;
      }
      if (!Number.isNaN(x.pos[0])) lasting.push(x);
    }
    const heard = heardAt(t, this.rate > 0.05 ? Math.min(AHEAD, Math.max(0, step) * 2.5) : 0, ear.pos, [...this.shots.values()], lasting, (n, local) => this.place.where(n, local));
    const now = new Set<string>();
    for (const h of heard) {
      now.add(h.key);
      const v = this.voices.get(h.key);
      if (v) this.move(v, h);
      else if (h.loop) this.play(h, ctx.currentTime, h.offset);
      else if (!this.started.has(h.key)) {
        // Started early by the output's own latency, so it is heard, not just sent, at its moment.
        const latency = (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0);
        const when = ctx.currentTime + Math.max(0, (h.at - t) / 1e6 / Math.max(0.05, this.rate) - latency);
        this.play(h, when, h.offset);
        this.started.set(h.key, h.at);
        const ts = ctx.getOutputTimestamp();
        const heardMs = (ts.performanceTime ?? wall) + (when - (ts.contextTime ?? ctx.currentTime)) * 1000 - h.offset * 1000;
        this.shotLog.push({ key: h.key, sound: h.sound, at: h.at, offset: h.offset, heardMs, fresh: this.fresh });
        if (this.shotLog.length > 4000) this.shotLog.splice(0, 1000);
      }
    }
    for (const [k, v] of this.voices) if (v.loop && !now.has(k)) this.end(k, v, ctx.currentTime);
    this.fresh = false;
  }

  private start(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings.volume;
      this.master.connect(this.ctx.destination);
      this.ctx.onstatechange = () => this.label();
    }
    void this.ctx.resume().then(() => this.label());
    this.focus?.claim();
  }

  private toggle(): void {
    this.settings.muted = !this.settings.muted;
    saveSettings(store(), this.settings);
    if (this.settings.muted) this.silence();
    this.label();
  }

  private label(): void {
    const b = this.button, ctx = this.ctx;
    b.textContent = !ctx || ctx.state !== 'running' ? 'sound off: click to hear the world'
      : this.settings.muted ? 'effects off' : !(this.focus?.audible() ?? true) ? 'sound is in another tab' : 'effects on';
    b.setAttribute('aria-pressed', String(!!ctx && !this.settings.muted));
  }

  private buffer(sound: ShotSound | LoopSound, variant: number): AudioBuffer {
    const ctx = this.ctx!, key = `${sound}:${variant}`;
    let b = this.buffers.get(key);
    if (!b) {
      const data = (LOOPS as readonly string[]).includes(sound) ? loop(sound as LoopSound, variant, ctx.sampleRate) : shot(sound as ShotSound, variant, ctx.sampleRate);
      b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(key, b);
    }
    return b;
  }

  private play(h: Heard, when: number, offset: number): void {
    const ctx = this.ctx!, src = ctx.createBufferSource(), gain = ctx.createGain();
    const pan = new PannerNode(ctx, { panningModel: 'equalpower', distanceModel: 'linear', rolloffFactor: 0, positionX: h.pos[0], positionY: h.pos[1], positionZ: h.pos[2] });
    src.buffer = this.buffer(h.sound, h.variant);
    src.loop = h.loop;
    if (h.loop) (gain.gain.value = 0), gain.gain.setTargetAtTime(h.gain, when, 0.15);
    else gain.gain.value = h.gain;
    src.connect(gain).connect(pan).connect(this.master!);
    src.start(when, offset);
    const v: Voice = { src, gain, pan, loop: h.loop, ends: h.loop ? Infinity : when + src.buffer.duration - offset };
    this.voices.set(h.key, v);
    src.onended = () => { if (this.voices.get(h.key) === v) this.voices.delete(h.key); src.disconnect(); gain.disconnect(); pan.disconnect(); };
  }

  private move(v: Voice, h: Heard): void {
    const t = this.ctx!.currentTime;
    if (v.loop) v.gain.gain.setTargetAtTime(h.gain, t, 0.15);
    v.pan.positionX.setTargetAtTime(h.pos[0], t, 0.05);
    v.pan.positionY.setTargetAtTime(h.pos[1], t, 0.05);
    v.pan.positionZ.setTargetAtTime(h.pos[2], t, 0.05);
  }

  private end(key: string, v: Voice, at: number): void {
    this.voices.delete(key);
    v.gain.gain.setTargetAtTime(0, at, 0.08);
    try { v.src.stop(at + 0.4); } catch { /* not started */ }
  }

  private silence(): void {
    this.fresh = true;
    const at = this.ctx?.currentTime ?? 0;
    for (const [k, v] of this.voices) this.end(k, v, at);
  }

  /** A jump of the clock: every voice stops, and the plan is asked afresh at the new time. */
  private cut(): void {
    this.silence();
    this.started.clear();
  }

  private report() {
    return {
      log: () => this.shotLog.slice(),
      frames: () => this.frameLog.slice(),
      state: () => ({ context: this.ctx?.state ?? 'none', muted: this.settings.muted, audible: this.focus?.audible() ?? true, voices: [...this.voices.keys()], shots: this.shots.size, lasting: this.lasting.size, kinds: [...new Set([...this.lasting.values()].map((l) => plain(this.place.kindOf(l.node) ?? '')))] }),
      lags: () => lags(this.shotLog, this.frameLog),
      happened: () => [...this.shots.values()].filter((s) => s.shot.sound !== 'step').map((s) => ({ at: s.at, node: s.node, sound: s.shot.sound })),
      record: () => {
        const ctx = this.ctx!, dest = ctx.createMediaStreamDestination();
        this.master!.connect(dest);
        const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm' }), parts: Blob[] = [];
        rec.ondataavailable = (e) => parts.push(e.data);
        rec.start(1000);
        this.recorder = { rec, parts };
        return performance.now();
      },
      stop: () => new Promise<string>((done) => {
        const r = this.recorder!;
        r.rec.onstop = () => { const f = new FileReader(); f.onload = () => done(String(f.result)); f.readAsDataURL(new Blob(r.parts, { type: 'audio/webm' })); };
        r.rec.stop();
      }),
    };
  }
}

/** For each one-shot, the ms between when it began to be heard and when its moment was drawn (the performance time
 *  at which the time drawn passed its world time, between the two frames around it). One started part-way by a seek,
 *  a start or an unmute (`fresh`) is left out: it is meant to start late; one started part-way otherwise counts its
 *  lost start as lag. */
export function lags(shots: readonly { sound: string; at: number; offset: number; heardMs: number; fresh?: boolean }[], frames: readonly [number, number][]): { sound: string; lagMs: number }[] {
  const out: { sound: string; lagMs: number }[] = [];
  for (const s of shots) {
    if (s.offset > 0 && s.fresh) continue;
    const i = frames.findIndex(([, t], k) => k > 0 && frames[k - 1][1] <= s.at && t >= s.at);
    if (i < 1) continue;
    const [w0, t0] = frames[i - 1], [w1, t1] = frames[i];
    const drawn = t1 > t0 ? w0 + ((s.at - t0) / (t1 - t0)) * (w1 - w0) : w1;
    out.push({ sound: s.sound, lagMs: s.heardMs + s.offset * 1000 - drawn });
  }
  return out;
}
