// Wake rules (#1929): when the resident process wakes the mind is data in serve's state, and one pure function reads what serve
// already stores (events, receipts, the plan, the owner's messages, speech said to this Soul, the live copy) against the rules and
// says which fire. Firing only queues {id, kind, why, at}; the budget, merging and delivery are listen's and pending's (#1968).

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

const USAGE = `usage: wake | wake add <${ADDABLE.join("|")}> [params-json] [--every <seconds>] | wake remove <id>`;
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
/** What `wake` prints: each rule with its last match and last firing, and how many wakes wait. */
export function view(wake) {
  const w = { ...fresh(), ...wake };
  return { rules: w.rules.map((r) => ({ id: r.id, kind: r.kind, ...(r.params ? { params: r.params } : {}), ...(r.always ? { always: true } : {}), every: r.every ?? 0, lastMatch: iso(r.lastMatch), lastFired: iso(r.lastFired) })), queued: w.queue?.length ?? 0 };
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
        // only an act the agent sent itself, of the body, not a plan's step, that no wait saw end and pending has not shown
        if (!x || !x.mine || x.waited || x.read || planReceipts.has(h.id)) continue;
        if (now - h.since < ACT_ENDED_GRACE_MS) { r.held.push(h); continue; }
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
