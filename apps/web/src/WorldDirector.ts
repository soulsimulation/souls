/** VF1: Broadcast's "what to look at" — a small, cheap director above the shot solver.
 *
 * WorldBroadcast used to frame whichever Soul ranked first by activity (then by id), so every Soul that started
 * walking took the camera, and an empty lake or sky was a valid shot. This module decides *what* is worth
 * watching and *for how long*; the existing shot solver (mars Director) still decides *how* to frame it.
 *
 * - Interest, highest first: a conversation (two-shot), a presentation, a balloon ride, a Soul doing something
 *   (reading, dancing, painting, eating…), a group, company on a bench, a swimmer, a walker.
 * - When nothing scores above "walking", or on arrival, it holds an establishing landmark of the town, chosen
 *   where people are, with a slow drift.
 * - A choice is held at least `MIN_HOLD` seconds (conversations longer), is only interrupted by something much
 *   more interesting, and is retired after `MAX_HOLD` so the camera tours what is happening.
 * - A subject the solver can only frame small (lost in water/sky/terrain) is dropped for a while.
 * - #2202: which candidate to cut to is a seeded weighted draw, not an argmax with an alphabetical tie-break, so two
 *   visits to the same world state give different cut orders. Priority is eventfulness (`eventfulness`) times novelty:
 *   a subject, place (a 20 m cell) and shot type shown recently weigh less (`exp(-age/90 s)`). The draw is among the
 *   candidates within 20 % of the best priority (Gumbel-max, one draw per cut), so an important event still comes
 *   first. With nothing eventful on, the town views are a plain shuffle (`drawLandmark`).
 * Pure logic over plain data, so it is unit-tested without a renderer. */
import { rng } from './WorldTour.ts';

/** `riding`: standing in a ride carrier's basket this frame (WorldBroadcast knows the carriers), from boarding on. */
export type DirectorBody = { id: string; p: readonly number[]; activity?: string; riding?: boolean };
export type Landmark = { id: string; label: string; p: readonly [number, number, number]; target: readonly [number, number, number] };
export type DirectorInput = {
  bodies: readonly DirectorBody[];
  /** entity id → conversation thread and when it last spoke (seconds, same clock as `now`). */
  speaking: ReadonlyMap<string, { thread: string; at: number }>;
  now: number;
  /** Establishing views available in this world (empty: never a landmark). */
  landmarks: readonly Landmark[];
  /** DIRECTOR2: entity id → when it arrived in the world (WorldDirector fills this from what it has seen). */
  arrivals?: ReadonlyMap<string, number>;
};
export type SubjectChoice = { kind: 'subjects'; key: string; label: string; score: number; focus: string; members: string[]; phase: string; twoShot: boolean };
export type LandmarkChoice = { kind: 'landmark'; key: string; label: string; score: number; landmark: Landmark; since: number };
export type DirectorChoice = SubjectChoice | LandmarkChoice;

/** DIRECTOR2: never two cuts within MIN_CUT seconds; an event is "fresh" (worth a visit) for FRESH seconds; arrivals score for ARRIVAL. */
export const MIN_CUT = 6, FRESH = 10, ARRIVAL = 12, PAIR_LINGER = MIN_CUT;
export const MIN_HOLD = 8, CONVERSATION_MIN_HOLD = 12, MAX_HOLD = 24, CONVERSATION_MAX_HOLD = 36, LANDMARK_HOLD = 14, OPENING = 7;
/** Below this, nothing is happening: show the town. */
export const LANDMARK_SCORE = 2.5;
const IN_WATER_Y = -.8, NEAR = 3.2, GROUP = 6, CONVERSATION_RECENT = 40, BAN_SECONDS = 40, COOLDOWN = 30;
/** #2202: novelty decays over NOVELTY seconds; the draw is among candidates within BAND of the best priority; a place is a
 *  PLACE_CELL-metre grid cell; activity changes count as motion for MOTION_WINDOW seconds. */
export const NOVELTY = 90, BAND = .2, PLACE_CELL = 20;
const MOTION_WINDOW = 20, SPEECH_RECENT = 10;

const WORKING = /dance|paint|garden|plant|eat|read|write|cook|drink|play|craft|yoga|stretch|jump|pushup|situp|browse|piano|game|wave|post-letter|work|bow|clap|cheer|point|nod|shake-head|give|take|sing|fish|feed|swing|seesaw|picnic|tell-story/;
/** Paired touch gestures (together.ts PAIRED, and a hand-over: the giver poses give, the taker take; both bodies share one
 *  start) and the CN5 choreographed games. */
const PAIRED = /^(hug|high-five|handshake|dance|give)$/, GAME = /^play-(frisbee|petanque|volleyball)$/;
const EVENT = /^(conversation:|game:|pair:|arrival:|ride:)/;
const RESTING = /^(sit|warm|sit-ground|rest)$/;
export function activityScore(activity = ''): { score: number; label: string } {
  const a = activity.replace(/^mars:/, '');
  if (/present|talk-floor/.test(a)) return { score: 9, label: 'presenting' };
  if (/ride|balloon/.test(a)) return { score: 8, label: 'riding' };
  if (WORKING.test(a)) return { score: 6, label: 'busy' };
  if (/convers|talk|listen/.test(a)) return { score: 5, label: 'talking' };
  if (RESTING.test(a)) return { score: 2.5, label: 'resting' }; // with company it becomes 4; alone, see candidates()
  if (/swim|tread/.test(a)) return { score: .8, label: 'swimming' };
  if (/sleep|lie|nap/.test(a)) return { score: .3, label: 'sleeping' }; // asleep on a mat at night is not a show
  if (/walk|run|stroll/.test(a)) return { score: 1.5, label: 'walking' };
  return { score: 0.5, label: 'idle' };
}
const flat = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Every candidate worth a shot this moment, best first. */
export function candidates(input: DirectorInput): SubjectChoice[] {
  const bodies = input.bodies.filter(b => b.p.every(Number.isFinite));
  const byId = new Map(bodies.map(b => [b.id, b]));
  const out: SubjectChoice[] = [], inConversation = new Set<string>();
  // Conversations: Souls on the same thread who spoke recently and are still near one another.
  const threads = new Map<string, { ids: string[]; last: number }>();
  for (const [id, s] of input.speaking) {
    if (!byId.has(id) || input.now - s.at > CONVERSATION_RECENT) continue;
    const t = threads.get(s.thread) ?? { ids: [], last: -Infinity };
    t.ids.push(id); t.last = Math.max(t.last, s.at); threads.set(s.thread, t);
  }
  for (const [thread, t] of threads) {
    const ids = t.ids.sort();
    const anchor = byId.get(ids[0])!;
    const members = ids.filter(id => flat(byId.get(id)!.p, anchor.p) < 12).slice(0, 4);
    const recent = input.now - t.last < 10 ? 2 : 0;
    members.forEach(id => inConversation.add(id));
    out.push({ kind: 'subjects', key: 'conversation:' + thread, label: members.length > 1 ? 'conversation' : 'speaking', score: (members.length > 1 ? 10 : 7) + recent,
      focus: members[0], members, phase: 'conversing', twoShot: members.length > 1 });
  }
  // Native talk/listen circles (no edge feed): one candidate whose focus follows whoever is talking.
  for (const b of bodies) {
    if (inConversation.has(b.id) || !/talk|listen|convers/.test(b.activity ?? '') || /talk-floor/.test(b.activity ?? '')) continue;
    const circle = bodies.filter(o => !inConversation.has(o.id) && /talk|listen|convers/.test(o.activity ?? '') && flat(o.p, b.p) < NEAR).map(o => o.id).sort().slice(0, 4);
    if (circle.length < 2) continue;
    circle.forEach(id => inConversation.add(id));
    const speaker = circle.find(id => /^talk$|convers/.test(byId.get(id)!.activity ?? '')) ?? circle[0];
    out.push({ kind: 'subjects', key: 'talk:' + circle[0], label: 'conversation', score: 9, focus: speaker, members: circle, phase: 'conversing', twoShot: false });
  }
  // DIRECTOR2: a game (players of the same CN5 game within a court's reach) is one shot of the whole court.
  for (const b of bodies) {
    const a = (b.activity ?? '').replace(/^mars:/, '');
    if (inConversation.has(b.id) || !GAME.test(a)) continue;
    const players = bodies.filter(o => !inConversation.has(o.id) && (o.activity ?? '').replace(/^mars:/, '') === a && flat(o.p, b.p) < 25).map(o => o.id).sort().slice(0, 6);
    players.forEach(id => inConversation.add(id));
    out.push({ kind: 'subjects', key: 'game:' + a + ':' + players[0], label: players.length > 1 ? 'game' : 'playing', score: players.length > 1 ? 8.5 + .3 * players.length : 6,
      focus: b.id, members: players, phase: 'working', twoShot: false });
  }
  // A paired gesture (a hug, a high five, a handshake, a dance together): brief, so it is the best shot while it lasts.
  // Two Souls who were just talking still get the gesture's own shot (a high five lasts ~2.5 s; inside the conversation's
  // framing it was never shown as the event).
  const paired = new Set<string>();
  for (const b of bodies) {
    const a = (b.activity ?? '').replace(/^mars:/, '');
    if (paired.has(b.id) || !PAIRED.test(a)) continue;
    const want = a === 'give' ? 'take' : a;
    const partner = bodies.filter(o => o.id !== b.id && !paired.has(o.id) && (o.activity ?? '').replace(/^mars:/, '') === want && flat(o.p, b.p) < 2.5)
      .sort((x, y) => flat(x.p, b.p) - flat(y.p, b.p))[0];
    if (!partner) continue;
    const pair = [b.id, partner.id].sort(); pair.forEach(id => { inConversation.add(id); paired.add(id); });
    out.push({ kind: 'subjects', key: 'pair:' + a + ':' + pair.join(':'), label: a === 'dance' ? 'dancing together' : a, score: a === 'dance' ? 8.5 : 10.5,
      focus: pair[0], members: pair, phase: 'working', twoShot: true });
  }
  // Someone riding (in a carrier's basket, from boarding) and someone who just arrived are events of their own.
  for (const b of bodies) {
    if (inConversation.has(b.id)) continue;
    if (b.riding) { inConversation.add(b.id); out.push({ kind: 'subjects', key: 'ride:' + b.id, label: 'riding', score: 8.5, focus: b.id, members: [b.id], phase: 'working', twoShot: false }); continue; }
    const at = input.arrivals?.get(b.id);
    if (at !== undefined && input.now - at < ARRIVAL && b.p[1] >= IN_WATER_Y) {
      inConversation.add(b.id);
      out.push({ kind: 'subjects', key: 'arrival:' + b.id, label: 'arriving', score: 8.5, focus: b.id, members: [b.id], phase: 'walking', twoShot: false });
    }
  }
  for (const b of bodies) {
    if (inConversation.has(b.id)) continue;
    const near = bodies.filter(o => o.id !== b.id && flat(o.p, b.p) < NEAR);
    // A group counts when at least two of its members are doing something (not a row of sleepers or standers).
    const crowd = bodies.filter(o => flat(o.p, b.p) < GROUP), active = crowd.filter(o => activityScore(o.activity).score >= 2.5).length;
    let { score, label } = activityScore(b.activity);
    if (label === 'resting') { if (near.some(o => activityScore(o.activity).score >= 2.5)) { score = 4; label = 'company'; } else score = 2; } // alone on a bench: the tour is better
    const riding = b.p[1] > 4.5 && label !== 'swimming';
    if (riding) { score = Math.max(score, 8); label = 'riding'; }
    // A body below the ground line is in the water (pond, lake): from Broadcast distance the shot is all water,
    // whatever it is doing there. Never worth a shot of its own.
    if (label === 'swimming' || b.p[1] < IN_WATER_Y) { score = .8; label = 'swimming'; }
    if (label !== 'swimming' && label !== 'sleeping' && crowd.length >= 3 && active >= 2 && score < 4 + .5 * (crowd.length - 3)) {
      score = Math.min(6, 4 + .5 * (crowd.length - 3)); label = 'group';
    }
    const members = [b.id, ...near.map(o => o.id).sort()].slice(0, label === 'group' ? 6 : 3);
    if (label === 'group') for (const o of crowd) if (!members.includes(o.id) && members.length < 6) members.push(o.id);
    const phase = label === 'walking' ? 'walking' : label === 'presenting' ? 'presenting' : score >= 4 ? 'working' : 'idle';
    out.push({ kind: 'subjects', key: (label === 'group' ? 'group:' : 'soul:') + b.id, label, score, focus: b.id, members, phase, twoShot: false });
  }
  // One group per cluster: keep the best-scoring anchor of each overlapping group.
  const seen = new Set<string>();
  return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).filter(c => {
    if (!c.key.startsWith('group:')) return true;
    if (c.members.some(id => seen.has(id))) return false;
    c.members.forEach(id => seen.add(id)); return true;
  });
}

/** #2202: the next town view, a shuffle: none of the last half of the views shown, weighted by the people around each
 *  (1 + crowd), so with nobody about it is a plain shuffle. */
export function drawLandmark(input: DirectorInput, recent: readonly string[], random: () => number): Landmark | null {
  const all = input.landmarks;
  if (!all.length) return null;
  const skip = new Set(recent.slice(-Math.floor(all.length / 2)));
  const pool = all.filter(l => !skip.has(l.id));
  const from = pool.length ? pool : all;
  const w = from.map(l => 1 + input.bodies.filter(b => Math.hypot(b.p[0] - l.target[0], b.p[2] - l.target[2]) < 30).length);
  let x = random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < from.length; i++) { x -= w[i]; if (x <= 0) return from[i]; }
  return from[from.length - 1];
}
const cell = (p: readonly number[]) => Math.floor(p[0] / PLACE_CELL) + ',' + Math.floor(p[2] / PLACE_CELL);

export class WorldDirector {
  /** #2202: seeded once per page load; tests pass a seed. */
  constructor(seed: number = Date.now()) { this.random = rng(seed); }
  private random: () => number;
  /** #2202: when each subject (entity), place (cell) and shot type (label) was last on screen. */
  private shown = { subject: new Map<string, number>(), place: new Map<string, number>(), type: new Map<string, number>() };
  /** #2202: one Gumbel draw per candidate key, kept until the next cut, so the choice is stable between cuts. */
  private noise = new Map<string, number>();
  /** #2202: entity → last activity, when it changed, last position and speed (motion energy). */
  private motion = new Map<string, { activity: string; changed: number; p: readonly number[]; at: number; speed: number }>();
  current: DirectorChoice | null = null;
  since = -Infinity;
  private started: number | null = null;
  private banned = new Map<string, number>();
  private cooling = new Map<string, number>();
  private recentLandmarks: string[] = [];
  private landmarkRun = 0;
  /** DIRECTOR2: entity → [first seen, last seen] (an arrival is a body first seen after the opening, or back after a while away);
   *  event key → [first seen, last seen] (a new event is fresh: the camera visits it). */
  private seen = new Map<string, [number, number]>();
  private eventSeen = new Map<string, [number, number]>();
  private lastCut = -Infinity;
  /** DIRECTOR2: a paired gesture lasts 2.5-5 s; when it starts inside the cut window of an unrelated cut it would be over
   *  before the camera may move. It stays a candidate for PAIR_LINGER s after it ends (the two are still face to face). */
  private pairs = new Map<string, { c: SubjectChoice; until: number }>();
  reset() { this.shown.subject.clear(); this.shown.place.clear(); this.shown.type.clear(); this.noise.clear(); this.motion.clear(); this.pairs.clear(); this.current = null; this.since = -Infinity; this.started = null; this.banned.clear(); this.cooling.clear(); this.recentLandmarks = []; this.landmarkRun = 0; this.seen.clear(); this.eventSeen.clear(); this.lastCut = -Infinity; }
  /** The solver could only frame this choice small or not at all: leave it alone for a while. */
  reject(key: string, now: number) { this.banned.set(key, now + BAN_SECONDS); if (this.current?.key === key) { this.since = -Infinity; this.lastCut = -Infinity; } }

  private arrivals(input: DirectorInput): Map<string, number> {
    const now = input.now, first = this.seen.size === 0, out = new Map<string, number>();
    for (const b of input.bodies) {
      const s = this.seen.get(b.id);
      if (!s || now - s[1] > 20) this.seen.set(b.id, [first || (this.started !== null && now - this.started < OPENING) ? -Infinity : now, now]);
      else s[1] = now;
      const at = this.seen.get(b.id)![0];
      if (Number.isFinite(at)) out.set(b.id, at);
    }
    return out;
  }

  choose(input: DirectorInput): DirectorChoice | null {
    const now = input.now;
    // The opening starts when the town views are available (the Eden scenery may arrive a moment after people).
    // A placeholder framing before the scenery loads does not count against cut discipline: the opening is the real first cut.
    if (input.landmarks.length && this.started === null) { this.started = now; this.lastCut = -Infinity; }
    for (const [k, until] of this.banned) if (until <= now) this.banned.delete(k);
    for (const [k, until] of this.cooling) if (until <= now) this.cooling.delete(k);
    const all = candidates({ ...input, arrivals: input.arrivals ?? this.arrivals(input) }).filter(c => !this.banned.has(c.key));
    for (const c of all) if (c.key.startsWith('pair:')) this.pairs.set(c.key, { c, until: now + PAIR_LINGER });
    const ids = new Set(input.bodies.map(b => b.id));
    for (const [k, p] of this.pairs) {
      if (p.until <= now || !p.c.members.every(id => ids.has(id))) this.pairs.delete(k);
      else if (!this.banned.has(k) && !all.some(c => c.key === k)) all.push(p.c);
    }
    for (const c of all) if (EVENT.test(c.key)) { const e = this.eventSeen.get(c.key); if (!e || now - e[1] > 5) this.eventSeen.set(c.key, [now, now]); else e[1] = now; }
    for (const [k, e] of this.eventSeen) if (now - e[1] > 5) this.eventSeen.delete(k);
    this.track(input);
    const choice = this.decide(input, all);
    // Cut discipline: at most one cut per MIN_CUT seconds (a subject the solver rejected is the only exception).
    if (choice && choice.key !== this.current?.key) {
      if (this.current && now - this.lastCut < MIN_CUT) { this.mark(this.current, input); return this.current; }
      this.lastCut = now; this.noise.clear();
    }
    if (choice && choice !== this.current) { if (choice.key !== this.current?.key) this.since = now; this.current = choice; }
    if (choice) this.mark(choice, input);
    return choice;
  }
  /** #2202: activity changes and speed of every body, for motion energy. */
  private track(input: DirectorInput) {
    const now = input.now;
    for (const b of input.bodies) {
      const a = b.activity ?? '', m = this.motion.get(b.id);
      if (!m) { this.motion.set(b.id, { activity: a, changed: -Infinity, p: b.p, at: now, speed: 0 }); continue; }
      if (m.activity !== a) { m.activity = a; m.changed = now; }
      const dt = now - m.at;
      if (dt >= .2) { m.speed = Math.min(5, Math.hypot(b.p[0] - m.p[0], b.p[2] - m.p[2]) / dt); m.p = b.p; m.at = now; }
    }
  }
  /** #2202: what is on screen now counts as shown (subject members, the focus's place, the shot type). */
  private mark(c: DirectorChoice, input: DirectorInput) {
    const now = input.now;
    if (c.kind === 'landmark') { this.shown.type.set('landmark', now); this.shown.place.set(cell(c.landmark.target), now); return; }
    for (const id of c.members) this.shown.subject.set(id, now);
    const f = input.bodies.find(b => b.id === c.focus);
    if (f) this.shown.place.set(cell(f.p), now);
    this.shown.type.set(c.label, now);
  }
  private novelty(map: Map<string, number>, key: string, now: number) { const t = map.get(key); return t === undefined ? 0 : Math.exp(-Math.max(0, now - t) / NOVELTY); }
  /** #2202: eventfulness E of a candidate: its effective score, plus 0.5 per active member beyond two, plus 2 for speech
   *  in the last 10 s (a conversation's score already counts it), plus up to 1.5 for motion (members' activity changes in
   *  the last 20 s, 0.5 each, and their mean speed). */
  eventfulness(c: SubjectChoice, input: DirectorInput, effective: number): number {
    const now = input.now, byId = new Map(input.bodies.map(b => [b.id, b]));
    const members = c.members.map(id => byId.get(id)).filter(b => !!b);
    const active = members.filter(b => activityScore(b.activity).score >= 2.5).length;
    const speech = !c.key.startsWith('conversation:') && c.members.some(id => { const s = input.speaking.get(id); return !!s && now - s.at < SPEECH_RECENT; }) ? 2 : 0;
    const ms = c.members.map(id => this.motion.get(id)).filter(m => !!m);
    const changes = ms.filter(m => now - m.changed < MOTION_WINDOW).length, speed = ms.length ? ms.reduce((a, m) => a + m.speed, 0) / ms.length : 0;
    return effective + .5 * Math.max(0, active - 2) + speech + Math.min(1.5, .5 * changes + .25 * speed);
  }
  /** #2202: priority = E · (1 − 0.6·N_subject)(1 − 0.3·N_place)(1 − 0.2·N_type), N = exp(−age/90 s). */
  priority(c: SubjectChoice, input: DirectorInput, effective: number): number {
    const now = input.now, f = input.bodies.find(b => b.id === c.focus);
    const subject = Math.max(0, ...c.members.map(id => this.novelty(this.shown.subject, id, now)));
    const place = f ? this.novelty(this.shown.place, cell(f.p), now) : 0, type = this.novelty(this.shown.type, c.label, now);
    return Math.max(0, this.eventfulness(c, input, effective)) * (1 - .6 * subject) * (1 - .3 * place) * (1 - .2 * type);
  }
  /** #2202: a seeded weighted draw among the candidates within BAND of the best priority (Gumbel-max: argmax of log P plus
   *  a Gumbel draw per key, kept until the next cut). `pool` holds the candidates eligible at all. */
  private draw(pool: SubjectChoice[], input: DirectorInput, effective: (c: SubjectChoice) => number): SubjectChoice | null {
    if (!pool.length) return null;
    const scored = pool.map(c => ({ c, p: this.priority(c, input, effective(c)) }));
    const top = Math.max(...scored.map(x => x.p));
    if (!(top > 0)) return [...pool].sort((a, b) => effective(b) - effective(a))[0];
    let best: SubjectChoice | null = null, bestKey = -Infinity;
    for (const { c, p } of scored) {
      if (p < (1 - BAND) * top) continue;
      let g = this.noise.get(c.key);
      if (g === undefined) { g = -Math.log(-Math.log(Math.min(1 - 1e-12, Math.max(1e-12, this.random())))); this.noise.set(c.key, g); }
      if (Math.log(p) + g > bestKey) { bestKey = Math.log(p) + g; best = c; }
    }
    return best;
  }
  /** Fresh: an event that started within FRESH seconds and the camera has not shown yet. */
  private fresh(c: SubjectChoice, now: number) { const e = this.eventSeen.get(c.key); return !!e && now - e[0] < FRESH && this.current?.key !== c.key; }
  private decide(input: DirectorInput, all: SubjectChoice[]): DirectorChoice | null {
    const now = input.now;
    const cur = this.current, held = now - this.since;
    const curNow = cur?.kind === 'subjects' ? all.find(c => c.key === cur.key) ?? null : null;
    const effective = (c: SubjectChoice) => c.score - (this.cooling.has(c.key) ? 3 : 0) + (this.fresh(c, now) ? 4 : 0);
    // Something happening: an event (conversation, game, paired gesture, arrival, ride) or a talk; one Soul busy alone is not.
    const happening = (c: SubjectChoice) => EVENT.test(c.key) || c.key.startsWith('talk:') || c.score >= 9;
    if (cur?.kind === 'subjects' && curNow && held >= (cur.phase === 'conversing' ? CONVERSATION_MAX_HOLD : MAX_HOLD)) {
      // Variety: a long-held subject gives way to something else that is happening, else to a wide view of the town; while
      // nothing else happens the camera stays with it (never an empty landmark while something happens).
      const other = all.some(c => c.key !== cur.key && happening(c));
      if (other || !happening(curNow)) { this.cooling.set(cur.key, now + COOLDOWN); if (!other && input.landmarks.length) return this.landmark(input, now, false); }
      else this.since = now - (cur.phase === 'conversing' ? CONVERSATION_MIN_HOLD : MIN_HOLD);
    }
    // #2202: the next subject is drawn by priority among those worth leaving the town for (all of them when none is), so
    // a walker never takes the place of someone busy and the landmark fallback below is exactly as before.
    const worth = all.filter(c => effective(c) >= LANDMARK_SCORE);
    const best = this.draw(worth.length ? worth : all, input, effective);
    // Opening: an establishing view of the town before the first cut, unless something big is on.
    if (input.landmarks.length && this.started !== null && now - this.started < OPENING && (!best || best.score < 9)) return this.landmark(input, now, true);
    if (cur?.kind === 'subjects') {
      if (curNow && !this.cooling.has(cur.key)) {
        const better = best && best.key !== cur.key ? effective(best) - effective(curNow) : -Infinity;
        const min = cur.phase === 'conversing' ? CONVERSATION_MIN_HOLD : MIN_HOLD;
        const freshBest = !!best && best.key !== cur.key && this.fresh(best, now);
        if (!(held >= MIN_CUT && freshBest && better > 0) && !(held >= 3 && better >= 4) && !(held >= min && better >= 1)) return this.keep(curNow);
      } else if (!curNow && held < 2) return cur; // briefly lost (a moment between chunks): hold the framing
    }
    if (cur?.kind === 'landmark' && held < LANDMARK_HOLD && !(best && effective(best) >= 6)) return cur;
    // Nothing is happening (walkers and idlers are not a show): the town tour.
    const threshold = !input.landmarks.length ? -Infinity : LANDMARK_SCORE;
    if (!best || effective(best) < threshold) return this.landmark(input, now, false);
    this.landmarkRun = 0;
    return best.key === cur?.key ? this.keep(best) : best;
  }
  private keep(c: SubjectChoice) { const cur = this.current as SubjectChoice; return { ...c, focus: c.twoShot && cur.focus && c.members.includes(cur.focus) ? cur.focus : c.focus }; }
  private landmark(input: DirectorInput, now: number, opening: boolean): DirectorChoice | null {
    const cur = this.current;
    if (cur?.kind === 'landmark' && (opening || now - this.since < LANDMARK_HOLD)) return cur;
    const l = opening ? input.landmarks[0] : drawLandmark(input, this.recentLandmarks, this.random);
    if (!l) return null;
    if (cur && now - this.lastCut < MIN_CUT) return cur;
    this.recentLandmarks = [...this.recentLandmarks, l.id].slice(-6);
    this.landmarkRun = cur?.kind === 'landmark' ? this.landmarkRun + 1 : 1;
    return { kind: 'landmark', key: 'landmark:' + l.id, label: l.label, score: LANDMARK_SCORE, landmark: l, since: now };
  }
}

/** A landmark pose with a slow drift: a few degrees of orbit and a gentle push-in over the hold. */
export function landmarkPose(l: Landmark, seconds: number): { position: [number, number, number]; target: [number, number, number]; fov: number } {
  const [px, py, pz] = l.p, [tx, ty, tz] = l.target;
  const k = Math.min(1, Math.max(0, seconds / LANDMARK_HOLD));
  const ease = k * k * (3 - 2 * k);
  const angle = (ease - .5) * 0.07, push = 1 - 0.05 * ease;
  const dx = px - tx, dz = pz - tz, c = Math.cos(angle), s = Math.sin(angle);
  return { position: [tx + (dx * c - dz * s) * push, ty + (py - ty) * push, tz + (dx * s + dz * c) * push], target: [tx, ty, tz], fov: 45 };
}
