// Wake rules (#1929): when the resident process wakes the mind is data in serve's state, and one pure function reads what serve
// already stores (events, receipts, the plan, the owner's messages, speech said to this Soul, the live copy) against the rules and
// says which fire. Firing only queues {id, kind, why, at}; the budget, merging and delivery are listen's and pending's (#1968).
// #1968: ambient wakes (the rules an owner adds, and act-ended) reach a reader within the owner's budget, merged to one entry per
// rule over it, and stay held until a command from another process reaches serve, or go back to the queue after HELD_MS. Each
// handing to a reader is one delivery and is charged once: the budget's count is the deliveries made, never more than it allows.

/** A rule added with `wake add` fires at most once per this many seconds unless it names its own --every. */
export const WAKE_EVERY_S = 300;
export const WAKE_QUEUE_MAX = 50;
/** An act's end waits this long before it wakes: an `act --wait` that sees the end reads the receipt within it. */
export const ACT_ENDED_GRACE_MS = 3_000;
const ENDED = new Set(["completed", "failed", "refused", "cancelled", "interrupted", "replaced"]);
const FIRED_KEEP = 200;   // receipt ids act-ended has woken for, so one end wakes once (serve keeps the newest 200 ended receipts)
/** Kinds that are always on: the three wakes serve had before rules. */
export const ALWAYS = ["owner-message", "speech-to-me", "plan-stopped"];
/** Kinds `wake add` takes. act-ended is on by default and can be removed and added again. */
export const ADDABLE = ["act-ended", "soul-arrives", "place-busy"];

export function fresh() {
  return { rules: [...ALWAYS.map((kind) => ({ id: kind, kind, always: true, every: 0 })), { id: "act-ended", kind: "act-ended", every: 0 }], cursor: null, queue: [], next: 1 };
}

/** Ambient wakes an hour per budget name; null is no limit. Until the owner chooses, `normal`. */
export const BUDGETS = { quiet: 4, normal: 12, lively: 60, unlimited: null };
/** A delivered wake no later agent command confirmed goes back to the queue after this long, to be delivered again within the budget. */
export const HELD_MS = 600_000;
/** speech-to-me: at most one wake per speaker in this long; their further lines join the next one. */
export const SPEAKER_MS = 60_000;
const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;

const USAGE = `usage: wake | wake add <${ADDABLE.join("|")}> [params-json] [--every <seconds>] | wake remove <id> | wake budget <${Object.keys(BUDGETS).join("|")}|n> | wake budget --day <n>`;
/** `wake budget` arguments as a change: {hour} or {day}. Throws what is wrong. */
export function parseBudget(argv) {
  const [a, b, ...extra] = argv;
  const n = (v) => /^\d{1,6}$/.test(v ?? "");
  if (a === "--day" && (n(b) || b === "unlimited") && !extra.length) return { day: b === "unlimited" ? null : Number(b) };
  if (a !== undefined && (a in BUDGETS || n(a)) && b === undefined) return { hour: n(a) ? Number(a) : a };
  throw new Error(USAGE);
}
/** `wake add` arguments as a rule (without its id). Throws what is wrong. */
export function parseRule(argv) {
  const rest = [];
  let every = WAKE_EVERY_S;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--every") { const v = argv[++i]; if (!/^\d+$/.test(v ?? "")) throw new Error("--every takes whole seconds"); every = Number(v); }
    else rest.push(argv[i]);
  }
  const [kind, text, ...extra] = rest;
  if (ALWAYS.includes(kind)) throw new Error(`${kind} is always on`);
  if (!ADDABLE.includes(kind) || extra.length) throw new Error(USAGE);
  let p = {};
  if (text !== undefined) { try { p = JSON.parse(text); } catch { throw new Error(`${kind}: params must be JSON`); } }
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${kind}: params must be a JSON object`);
  const id = (v) => typeof v === "string" && /^\S{1,100}$/.test(v);
  if (kind === "act-ended") { if (Object.keys(p).length) throw new Error("act-ended takes no params"); return { kind, every }; }
  if (kind === "soul-arrives") {
    const params = { who: p.who ?? "any", where: p.where ?? "here" };
    if (Object.keys(p).some((k) => !["who", "where"].includes(k)) || !id(params.who) || !id(params.where)) throw new Error('soul-arrives takes {"who":"any"|"<soulId>","where":"here"|"<placeId>"}');
    return { kind, params, every };
  }
  if (Object.keys(p).some((k) => !["place", "atLeast"].includes(k)) || !id(p.place) || !Number.isInteger(p.atLeast) || p.atLeast < 1) throw new Error('place-busy takes {"place":"<placeId>","atLeast":<n ≥ 1>}');
  return { kind, params: { place: p.place, atLeast: p.atLeast }, every };
}

/** Pure: one `wake add` ({add: rule}) or `wake remove` ({remove: id}) on the wake state. {wake} or {error}. */
export function change(wake, c) {
  const w = { ...fresh(), ...wake };
  if (!c) return { wake: w };
  if (c.budget) return { wake: { ...w, budget: { ...w.budget, ...c.budget } } };
  if (c.add) {
    const rule = { id: `w${w.next ?? 1}`, ...c.add };
    return { wake: { ...w, rules: [...w.rules, rule], next: (w.next ?? 1) + 1 }, rule };
  }
  const r = w.rules.find((x) => x.id === c.remove);
  if (!r) return { error: `no wake rule ${c.remove}: wake lists them` };
  if (r.always) return { error: `${r.id} is always on` };
  return { wake: { ...w, rules: w.rules.filter((x) => x !== r) }, removed: r.id };
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
/** What `wake` prints: each rule with its last match and last firing, how many wakes wait, and the budget. */
export function view(wake, now = 0) {
  const w = { ...fresh(), ...wake };
  return { rules: w.rules.map((r) => ({ id: r.id, kind: r.kind, ...(r.params ? { params: r.params } : {}), ...(r.always ? { always: true } : {}), every: r.every ?? 0, lastMatch: iso(r.lastMatch), lastFired: iso(r.lastFired) })), queued: w.queue?.length ?? 0, budget: budgetView(w, now) };
}

const perHour = (w) => { const h = w.budget?.hour ?? "normal"; return typeof h === "number" ? h : h in BUDGETS ? BUDGETS[h] : BUDGETS.normal; };
/** What `status` shows: the budget, whether the owner chose it, and the ambient wakes delivered in the last hour and 24 hours. */
export function budgetView(wake, now) {
  const w = wake ?? {}, sent = (w.delivered ?? []).map((d) => d.at), hour = perHour(w);
  return { budget: w.budget?.hour ?? "normal", perHour: hour, perDay: w.budget?.day ?? null, chosen: w.budget?.hour !== undefined,
    deliveredLastHour: sent.filter((t) => now - t < HOUR_MS).length, deliveredLast24h: sent.filter((t) => now - t < DAY_MS).length };
}

/** Pure: fired wakes into the queue, one entry per rule: a count and the latest why. */
export function enqueue(queue, fired) {
  const q = (queue ?? []).map((x) => ({ ...x }));
  for (const f of fired) {
    const e = q.find((x) => x.id === f.id);
    if (e) Object.assign(e, { why: f.why, at: f.at, count: (e.count ?? 1) + (f.count ?? 1) }); else q.push({ ...f, count: f.count ?? 1 });
  }
  return q.slice(-WAKE_QUEUE_MAX);
}

/** Pure: held deliveries older than heldMs go back to the queue, under what queued since. The delivery made stays counted: the
 *  reader was handed it, and a refund would let a reader that never confirms take more turns than the budget (review of #2053). */
export function expire(wake, now, heldMs = HELD_MS) {
  const w = { ...fresh(), ...wake }, old = (w.held ?? []).filter((g) => now - g.at >= heldMs);
  if (!old.length) return w;
  const queue = enqueue(old.flatMap((g) => g.wakes), w.queue ?? []);   // what queued since is newer: its why stands
  return { ...w, queue, held: w.held.filter((g) => !old.includes(g)) };
}

/** Pure: what a reader is handed now. The always-on kinds come by their own paths (the owner's messages, speech, the plan), so
 *  their entries leave the queue; the ambient ones are handed over, all at once, when the budget allows one more delivery
 *  (`free`: they ride with a wake that is coming anyway, and cost nothing). Handed wakes are held, not gone: confirm() ends that. */
/** `reader`: the process asking, so its own later requests confirm nothing. `rehand` (pending, a run that is awake anyway): wakes
 *  still held for another reader, which no command has confirmed, are handed to this one too, at no new charge. */
export function deliver(wake, now, { free = false, heldMs = HELD_MS, reader = null, rehand = false } = {}) {
  const w0 = expire(wake, now, heldMs), queue = (w0.queue ?? []).filter((x) => !ALWAYS.includes(x.kind));
  const delivered = (w0.delivered ?? []).filter((d) => now - d.at < DAY_MS);
  const again = rehand ? (w0.held ?? []).filter((g) => g.reader !== reader) : [];
  const held = [...(w0.held ?? []).filter((g) => !again.includes(g)), ...again.map((g) => ({ ...g, at: now, reader }))];
  const w = { ...w0, queue, delivered, held }, before = enqueue([], again.flatMap((g) => g.wakes));
  if (!queue.length) return { wake: w, wakes: before };
  const hour = perHour(w), day = w.budget?.day ?? null;
  const over = !free && ((hour !== null && delivered.filter((d) => now - d.at < HOUR_MS).length >= hour) || (day !== null && delivered.length >= day));
  if (over) return { wake: w, wakes: before, over: true };
  return { wake: { ...w, queue: [], held: [...held, { at: now, wakes: queue, charged: !free, reader }], delivered: free ? delivered : [...delivered, { at: now }] }, wakes: enqueue(before, queue) };
}

/** Pure: a command reached serve from `reader`: what was handed to any other process was taken. A reader's own requests (a listen's
 *  next poll) confirm nothing it was handed. Without a reader, everything held is taken. */
export function confirm(wake, reader) {
  const held = (wake?.held ?? []).filter((g) => reader != null && g.reader === reader);
  return held.length === (wake?.held?.length ?? 0) ? wake : { ...wake, held };
}

const speaker = (a) => a.soulId ?? a.from ?? "someone";
/** Pure: does any of these lines said to this Soul come from a speaker who has not woken it within SPEAKER_MS? */
export const speechDue = (lines, spoke, now) => lines.some((a) => now - (spoke?.[speaker(a)] ?? -Infinity) >= SPEAKER_MS);
/** Pure: the speakers' last wake, with these lines' speakers waking now. */
export function spokeNow(spoke, lines, now) {
  const o = Object.fromEntries(Object.entries(spoke ?? {}).filter(([, t]) => now - t < SPEAKER_MS));
  for (const a of lines) o[speaker(a)] = now;
  return o;
}

/** The items after the cursor's id; all of them when the id is gone (the list was cut from the front), none on a first look. */
function after(list, cursorId, first) {
  if (first) return [];
  const i = cursorId ? list.findIndex((x) => x?.id === cursorId) : -1;
  return i >= 0 ? list.slice(i + 1) : list;
}
const who = (live, id) => live.souls.find((r) => r.id === id)?.name ?? id;

/** Pure: the rules against serve's state at `now` (ms). state: serve's state ({events, receipts, plan, planEnded, messages,
 *  addressed, addressedSeq, wake: {cursor}}) with `live` (the live copy's picture, or null) and `me` (this Soul's id).
 *  Returns the rules with their last match, last firing and change state, the engine's cursor, and the wakes fired now. */
export function evaluate(rules, state, now) {
  const prev = state.wake?.cursor ?? null, first = !prev;
  const events = state.events ?? [], messages = state.messages ?? [], addressed = state.addressed ?? [], receipts = state.receipts ?? {};
  const newEvents = after(events, prev?.event, first);
  const newMessages = first ? [] : prev.message && messages.some((m) => m.id === prev.message) ? after(messages, prev.message, false) : messages.filter((m) => (m.seenAt ?? 0) > (prev.messageAt ?? 0));
  const newSpeech = first ? [] : addressed.filter((x) => x.seq > (prev.addressed ?? 0));
  const last = messages.at(-1);
  const cursor = { event: events.at(-1)?.id ?? prev?.event ?? null, message: last?.id ?? prev?.message ?? null, messageAt: last?.seenAt ?? prev?.messageAt ?? 0, addressed: Math.max(state.addressedSeq ?? 0, prev?.addressed ?? 0) };
  const live = Array.isArray(state.live?.souls) ? state.live : null;
  const planReceipts = new Set([state.plan, ...(state.planEnded ?? [])].flatMap((p) => p?.steps ?? []).map((s) => s.receipt).filter(Boolean));
  const fired = [];
  const out = rules.map((r0) => {
    const r = { ...r0 };
    const fire = (why) => {
      r.lastMatch = now;
      if (r.every && r.lastFired && now - r.lastFired < r.every * 1000) return false;
      r.lastFired = now;
      fired.push({ id: r.id, kind: r.kind, why, at: new Date(now).toISOString() });
      return true;
    };
    if (r.kind === "owner-message") for (const m of newMessages) { if (!m.acked) fire(`the owner wrote (${m.id})`); }
    else if (r.kind === "speech-to-me") for (const x of newSpeech) fire(`${x.from ?? x.soulId ?? "someone"} spoke to you`);
    else if (r.kind === "plan-stopped") {
      const p = state.plan, key = p?.state === "stopped" ? `${p.id}:${p.stoppedAt}` : null;
      if (key && key !== r.seen) { const s = p.steps[p.at]; fire(`plan step ${p.at + 1} refused (${s?.why?.code ?? "refused"})`); }
      r.seen = key ?? r.seen;
    } else if (r.kind === "act-ended") {
      const done = new Set(r.done ?? []), held = [...(r.held ?? [])];
      for (const e of newEvents) {
        const id = e?.receipt?.id;
        if (id && ENDED.has(e.receipt.phase) && !done.has(id) && !held.some((h) => h.id === id)) held.push({ id, since: now });
      }
      r.held = [];
      for (const h of held) {
        const x = receipts[h.id];
        // only an act the agent sent itself, of the body, not a plan's step, that no wait saw end and pending has not shown.
        // Held through the grace before asking whose it is: the stream's end can come before the act's answer marks it mine (#2054).
        if (x?.waited || x?.read || planReceipts.has(h.id)) continue;
        if (now - h.since < ACT_ENDED_GRACE_MS) { r.held.push(h); continue; }
        if (!x?.mine) continue;
        done.add(h.id); fire(`${x.capability ?? "your act"} ${x.phase}${x.reason ? `: ${x.reason}` : ""}`);
      }
      r.done = [...done].slice(-FIRED_KEEP);
    } else if (r.kind === "soul-arrives" && live) {
      const place = r.params.where === "here" ? live.souls.find((x) => x.id === state.me)?.place : r.params.where;
      if (place) {
        const ids = live.souls.filter((x) => x.id !== state.me && x.place === place && (r.params.who === "any" || x.id === r.params.who)).map((x) => x.id);
        if (r.inside) { const came = ids.filter((id) => !r.inside.includes(id)); if (came.length) fire(`${came.map((id) => who(live, id)).join(", ")} arrived at ${place}`); }
        r.inside = ids;
      }
    } else if (r.kind === "place-busy" && live) {
      const n = live.souls.filter((x) => x.id !== state.me && x.place === r.params.place).length, busy = n >= r.params.atLeast;
      if (busy && r.busy === false) fire(`${n} Souls at ${r.params.place}`);
      r.busy = busy;
    }
    return r;
  });
  return { rules: out, cursor, fired };
}
