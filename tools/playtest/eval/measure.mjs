// Soul Client eval (#1752): the pure measures. Everything here reads what an episode retained (the client's own request
// trace, the seat's turns and transcript, the observer's samples of the public Soul view, the owner card) and returns
// numbers. Nothing reads the agent's own words to decide success: checks read the world (place, posture, receipts) and the
// card's state, never its text.

// ---- routes and the service level (#1750: p99.9 server-side; 50 ms bookkeeping, 100 ms reads, 150 ms an act's acknowledgment)

/** A route as the report groups it: ids in path segments become `:id`, so one receipt read is one route. */
export function normRoute(route) {
  const [path, query] = String(route ?? '').split('?');
  const segs = path.split('/').map((s) => (/^(?:[a-z]{1,4}_[\w.-]+|[0-9a-f-]{16,}|\d+)$/i.test(s) && !/^v\d+$/.test(s) ? ':id' : s));
  return segs.join('/') + (query ? `?${query}` : '');
}
/** Long polls hold the answer open by design (wait, listen, a stream): their time is not a handler's, so no level applies. */
export const isLongPoll = (route) => /\/(?:wait|listen|stream|follow)(?:\/|\?|$)/.test(route) || /[?&]timeout(?:Ms)?(?:&|$)/.test(route);
/** The level a route is held to, in server ms, or null (long polls, setup). */
export function serviceLevel(method, route) {
  if (isLongPoll(route)) return null;
  if (method === 'POST' && /\/v1\/edge\/(?:act|plan)(?:\?|$)/.test(route)) return { kind: 'act', ms: 150 };
  if (method === 'GET') return { kind: 'read', ms: 100 };
  return { kind: 'bookkeeping', ms: 50 };
}

export function quantile(xs, q) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
}
const r1 = (x) => (x == null ? null : Math.abs(x) < 1 ? Math.round(x * 10000) / 10000 : Math.round(x * 10) / 10);
export const spread = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? { median: r1(quantile(a, 0.5)), min: r1(Math.min(...a)), max: r1(Math.max(...a)), n: a.length } : { median: null, min: null, max: null, n: 0 };
};

/** The http records of one trace (soul-trace/1) from `sinceMs` (local wall ms) on. */
export const httpSince = (records, sinceMs = 0, untilMs = Infinity) => records.filter((r) => r?.v === 'soul-trace/1' && r.kind === 'http' && r.at >= sinceMs && r.at <= untilMs);

/** Per route: count, statuses, client and server ms (p50/p99/p99.9/max), its level and how many calls missed it. */
export function routeStats(http) {
  const by = new Map();
  for (const r of http) {
    const route = `${r.method} ${normRoute(r.route)}`;
    const e = by.get(route) ?? { route, method: r.method, n: 0, status: {}, client: [], server: [] };
    e.n++; e.status[r.status ?? 'none'] = (e.status[r.status ?? 'none'] ?? 0) + 1;
    if (Number.isFinite(r.durationMs)) e.client.push(r.durationMs);
    if (Number.isFinite(r.serverMs)) e.server.push(r.serverMs);
    by.set(route, e);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).map(({ client, server, ...e }) => {
    const path = e.route.slice(e.method.length + 1), level = serviceLevel(e.method, path);
    return { ...e, longPoll: isLongPoll(path), level: level?.kind ?? null, levelMs: level?.ms ?? null,
      clientMs: { p50: r1(quantile(client, 0.5)), p99: r1(quantile(client, 0.99)), max: r1(client.length ? Math.max(...client) : null) },
      serverMs: { p50: r1(quantile(server, 0.5)), p99: r1(quantile(server, 0.99)), p999: r1(quantile(server, 0.999)), max: r1(server.length ? Math.max(...server) : null), n: server.length },
      overLevel: level ? server.filter((s) => s > level.ms).length : null };
  });
}

/** Refusals by code: an answer the world gave as `accepted: false`, or an HTTP error with its code. */
export function refusalCounts(http) {
  const out = {};
  for (const r of http) {
    const code = r.facts?.accepted === false ? r.facts.code ?? 'refused' : r.status >= 400 ? r.facts?.code ?? `http.${r.status}` : null;
    if (code) out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

// ---- the seat's side: model turns, API calls, tokens, CLI calls

/** The eden.mjs command a shell call ran (`node eden.mjs [name] act …` → act), or null. */
export function cliCommand(cmd) {
  const m = /(?:^|[\s;&|(])node\s+(?:\S*\/)?eden(?:-agent)?\.mjs((?:\s+[^\s;&|]+)*)/.exec(String(cmd ?? ''));
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => /^[a-z][a-z-]*$/.test(w));
  return words.find((w) => COMMANDS.has(w)) ?? words[0] ?? 'help';
}
const COMMANDS = new Set(['look', 'find', 'query', 'act', 'plan', 'here', 'inspect', 'wait', 'stop', 'say', 'ack', 'result', 'listen', 'serve', 'pending', 'status', 'receipt',
  'resolve', 'catalog', 'map', 'around', 'help', 'now', 'note', 'consolidate', 'register', 'create', 'import', 'whoami', 'travel', 'memory', 'schema']);

/** From turns (turns.jsonl) and transcript lines ({turn, ...stream event}) of the turns that started in [sinceMs, untilMs):
 *  model turns, API calls (distinct assistant messages), tokens in (input + cache read + cache write) and out, cost, CLI calls. */
export function seatStats(turns, transcript, sinceMs, untilMs = Infinity) {
  const mine = turns.filter((t) => { const s = Date.parse(t.startedAt); return s >= sinceMs && s < untilMs && !t.refused; });
  const ns = new Set(mine.map((t) => t.turn));
  const msgs = new Map(), cli = {}, tools = {};
  for (const e of transcript) {
    if (!ns.has(e.turn) || e.type !== 'assistant') continue;
    const key = e.message?.id ?? `${e.turn}:${msgs.size}`;
    if (e.message?.usage && !msgs.has(key)) msgs.set(key, e.message.usage);
    for (const c of e.message?.content ?? []) if (c.type === 'tool_use') {
      tools[c.name] = (tools[c.name] ?? 0) + 1;
      const k = c.name === 'Bash' ? cliCommand(c.input?.command) ?? 'other-shell' : null;
      if (k) cli[k] = (cli[k] ?? 0) + 1;
    }
  }
  let tokensIn = 0, tokensOut = 0, cost = 0, costKnown = true;
  for (const t of mine) {
    const u = t.usage ?? {};
    tokensIn += (u.inputTokens ?? 0) + (u.cachedTokens ?? 0) + (u.cacheCreationTokens ?? 0); tokensOut += u.outputTokens ?? 0;
    if (u.costUsd == null) costKnown = mine.length ? costKnown && (u.costUsd === 0) : costKnown; else cost += u.costUsd;
  }
  return { modelTurns: mine.length, apiCalls: msgs.size, tokensIn, tokensOut, costUsd: costKnown ? Math.round(cost * 10000) / 10000 : null, cliCalls: cli, toolCalls: tools,
    turnWallMs: mine.reduce((s, t) => s + (t.wallMs ?? 0), 0), timedOutTurns: mine.filter((t) => t.timedOut).length };
}

// ---- the observer: what the public Soul view says, and the battery's checks

/** One sample of /v1/edge/public/souls/<id>: where the body is, its posture and activity, its receipts. */
export function observe(pub) {
  const self = pub?.self ?? {};
  return { placeIds: (self.placePath ?? []).map((p) => p?.id).filter(Boolean), place: self.placePath?.[0]?.id ?? null, posture: self.bodyState?.posture ?? null,
    activity: self.bodyState?.activity ?? null, receipts: Array.isArray(pub?.receipts) ? pub.receipts : [] };
}
/** The card is closed when the Soul reported a result. */
export const cardClosed = (card) => !!(card && (card.resultAt || card.outcome || ['done', 'failed', 'closed', 'resolved'].includes(card.state)));
const cardOutcome = (card) => card?.outcome ?? (['done', 'failed'].includes(card?.state) ? card.state : null);

/** judge(check, {obs, newReceipts, card, catalog}) → {ok, why}. A check is one of:
 *   {all:[…]} {any:[…]}                     composition
 *   {place:[ids]}                           the body is in (or under) one of these places
 *   {placeKind:"mill"}                      the body is in a place of this catalog kind
 *   {posture:"seated"}                      bodyState.posture
 *   {receipt:{verb, phases?, thingKind?}}   a receipt since the owner's message for this verb, started or completed
 *                                           (thingKind: its chosen target is a thing of that catalog kind)
 *   {card:"failed"|"done"|"closed"}         the card's state (closed: either)
 *   {calendarInterest:"first"}              the first item the calendar listed for the next hour when the instruction was
 *                                           sent (ctx.calendarFirst) lists the Soul as coming (#1924; ctx.calendar) */
export function judge(check, ctx) {
  const { obs, newReceipts = [], card = null, catalog = null } = ctx;
  if (check.calendarInterest) {
    const it = (ctx.calendar ?? []).find((x) => x.id === ctx.calendarFirst), ok = !!it?.interested?.some((x) => x.soulId === ctx.soulId);
    return ok ? { ok: true, why: `interested in ${it.id}` } : { ok: false, why: it ? `not interested in ${it.id}` : 'no first calendar item' };
  }
  if (check.all) { for (const c of check.all) { const r = judge(c, ctx); if (!r.ok) return r; } return { ok: true, why: 'all held' }; }
  if (check.any) { const rs = check.any.map((c) => judge(c, ctx)); const hit = rs.find((r) => r.ok); return hit ?? { ok: false, why: rs.map((r) => r.why).join('; ') }; }
  if (check.place) { const hit = check.place.find((p) => obs.placeIds.includes(p)); return hit ? { ok: true, why: `in ${hit}` } : { ok: false, why: `at ${obs.place}, not in ${check.place.join('|')}` }; }
  if (check.placeKind) {
    const hit = obs.placeIds.find((p) => catalog?.placeKind(p) === check.placeKind);
    return hit ? { ok: true, why: `in ${hit} (${check.placeKind})` } : { ok: false, why: `at ${obs.place}, no ${check.placeKind} around it` };
  }
  if (check.posture) return obs.posture === check.posture ? { ok: true, why: `posture ${obs.posture}` } : { ok: false, why: `posture ${obs.posture}, not ${check.posture}` };
  if (check.receipt) {
    const { verb, phases = ['started', 'completed'], thingKind = null } = check.receipt;
    const hit = newReceipts.find((r) => String(r.capability ?? '').split(':')[0] === verb && phases.includes(r.phase)
      && (!thingKind || catalog?.thingKind(r.chosen?.target ?? String(r.capability).split(':')[1]) === thingKind));
    return hit ? { ok: true, why: `${hit.capability} ${hit.phase}` } : { ok: false, why: `no ${verb}${thingKind ? ` on a ${thingKind}` : ''} receipt ${phases.join('|')}` };
  }
  if (check.card) {
    if (ctx.noCard) return { ok: false, unknown: true, why: 'no card (instruction typed in chat)' };
    const ok = check.card === 'closed' ? cardClosed(card) : cardOutcome(card) === check.card;
    return ok ? { ok: true, why: `card ${cardOutcome(card) ?? card?.state}` } : { ok: false, why: `card ${cardOutcome(card) ?? card?.state ?? 'none'}, not ${check.card}` };
  }
  throw new Error(`unknown check ${JSON.stringify(check)}`);
}
/** Every place id and kind a check names, for validating a battery against the world's catalog before a run. */
export function checkRefs(check, out = { places: [], placeKinds: [], thingKinds: [] }) {
  for (const c of [...(check.all ?? []), ...(check.any ?? [])]) checkRefs(c, out);
  if (check.place) out.places.push(...check.place);
  if (check.placeKind) out.placeKinds.push(check.placeKind);
  if (check.receipt?.thingKind) out.thingKinds.push(check.receipt.thingKind);
  return out;
}
/** A catalog lookup from the client's world copy (soul-catalog/1). */
export function catalogIndex(cat) {
  const places = new Map((cat?.places ?? []).map((p) => [p.id, p])), things = new Map((cat?.things ?? []).map((t) => [t.id, t]));
  return { placeKind: (id) => places.get(id)?.kind ?? null, thingKind: (id) => things.get(id)?.kind ?? null, hasPlace: (id) => places.has(id),
    hasPlaceKind: (k) => [...places.values()].some((p) => p.kind === k), hasThingKind: (k) => [...things.values()].some((t) => t.kind === k) };
}
export function validateBattery(battery, catalog = null) {
  const errs = [], ids = new Set();
  if (!Array.isArray(battery?.items) || !battery.items.length) return ['battery.items[] required'];
  for (const [i, it] of battery.items.entries()) {
    const at = `items[${i}]${it?.id ? ` (${it.id})` : ''}`;
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(it?.id ?? '')) errs.push(`${at}.id: lowercase, digits, dashes`);
    if (ids.has(it.id)) errs.push(`${at}.id repeats`); ids.add(it.id);
    if (typeof it.instruction !== 'string' || !it.instruction.trim()) errs.push(`${at}.instruction required`);
    if (!it.check || typeof it.check !== 'object') { errs.push(`${at}.check required`); continue; }
    try { judge(it.check, { obs: observe(null), card: null, catalog: catalogIndex(null) }); } catch (e) { errs.push(`${at}.check: ${e.message}`); }
    if (catalog) {
      const refs = checkRefs(it.check);
      for (const p of [...refs.places, ...(it.start ? [it.start] : [])]) if (!catalog.hasPlace(p)) errs.push(`${at}: place ${p} is not in this world`);
      for (const k of refs.placeKinds) if (!catalog.hasPlaceKind(k)) errs.push(`${at}: no place of kind ${k} in this world`);
      for (const k of refs.thingKinds) if (!catalog.hasThingKind(k)) errs.push(`${at}: no thing of kind ${k} in this world`);
    }
  }
  return errs;
}

// ---- totals over repeats

const sum = (o) => Object.values(o ?? {}).reduce((s, v) => s + v, 0);
/** Per item and overall: success n/N, and median (min to max) of each per-episode number over its repeats. */
export function summarize(episodes) {
  const items = new Map();
  for (const e of episodes) items.set(e.item, [...(items.get(e.item) ?? []), e]);
  const fold = (es) => ({
    episodes: es.length, succeeded: es.filter((e) => e.succeeded).length,
    modelTurns: spread(es.map((e) => e.seat.modelTurns)), apiCalls: spread(es.map((e) => e.seat.apiCalls)),
    worldCalls: spread(es.map((e) => e.worldCalls)), cliCalls: spread(es.map((e) => sum(e.seat.cliCalls))),
    firstMotionMs: spread(es.map((e) => e.firstMotionMs)), successMs: spread(es.map((e) => e.successMs)),
    clientMsPerCall: spread(es.map((e) => e.clientMsPerCall)), serverMsPerCall: spread(es.map((e) => e.serverMsPerCall)),
    refusals: es.reduce((o, e) => { for (const [k, v] of Object.entries(e.refusals)) o[k] = (o[k] ?? 0) + v; return o; }, {}),
    tokensIn: spread(es.map((e) => e.seat.tokensIn)), tokensOut: spread(es.map((e) => e.seat.tokensOut)), costUsd: spread(es.map((e) => e.seat.costUsd)),
  });
  return { items: [...items].map(([item, es]) => ({ item, ...fold(es) })), total: fold(episodes) };
}
