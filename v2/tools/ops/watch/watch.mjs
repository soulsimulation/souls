#!/usr/bin/env node
// The watcher off the machine (Engine v2 O15, #2808): tells the owner when a world is in trouble or a machine is gone.
// Run it each minute on another machine (any scheduler that runs each minute: a timer, cron, a hosted function), or
// keep it running with `--every 60`. A watcher on the machine dies with it.
//
// One run is three looks 10 s apart (LOOKS, GAP_MS) at each instance's GET /ops/watch (look.mjs, files only, so no
// look wakes a world). A check is the instance itself (reachable, answering) and each awake world on it (look.mjs's
// `down`, `stalled`, `lag`, `restart-loop`). A check failing on all three looks is down; passing on all three, up;
// anything else keeps what it was. A deploy's restart heals inside 20 s, so it sends nothing; a planned stop and a
// sleeping world are healthy in the look itself. One message per change of state: the run's new troubles in one, its
// recoveries in another, nothing while a check stays down. A message that fails to send is sent again next run (the
// change is only recorded once delivered). It reports; it restarts nothing.
//
// One rule more (O25, #3336): a kind of visitors' page error new since the page build went live (the look's
// `page_errors`) sends one message; while the look still lists it, nothing more. A new release starts the list again.
//
//   node watch.mjs --instances <instances.json> --state <state.json> --sink <sink> [--every 60]
// instances.json: {"instances": [{"name": "<short name>", "url": "https://<host>/ops/watch", "token_env": "<VAR>"}]}
//   (the token, when the look asks one, is read from that environment variable, never from the file).
// Sinks: `file:<path>` (a test sink: one JSON line per message), `discord-dm` (today's delivery: a bot's direct
// message, DISCORD_BOT_TOKEN and DISCORD_USER_ID from the environment).
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOOKS = 3;
export const GAP_MS = 10_000;
export const TIMEOUT_MS = 8_000;   // a look pauses 2.5 s between its two reads

/** The prefix of a page-error check: not a trouble that goes down and up, but a kind told once (O25). */
export const PAGE = 'page error';

const stamp = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/** One look at one instance: `{[check]: reason | null}`. */
export async function lookAt(inst, { fetchImpl = fetch, env = process.env } = {}) {
  const name = `instance ${inst.name}`;
  let body;
  try {
    const headers = inst.token_env && env[inst.token_env] ? { authorization: `Bearer ${env[inst.token_env]}` } : {};
    const r = await fetchImpl(inst.url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { [name]: `HTTP ${r.status}` };
    body = await r.json();
  } catch (e) {
    return { [name]: e?.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000} s` : `unreachable (${e?.cause?.code ?? e?.name ?? 'error'})` };
  }
  if (!Array.isArray(body?.worlds)) return { [name]: 'the look is not JSON with worlds' };
  const out = { [name]: null };
  for (const w of body.worlds) out[`world ${w.world} on ${inst.name}`] = w.trouble ? `${w.trouble}: ${w.detail}` : null;
  for (const k of body.page_errors?.new ?? []) out[`${PAGE} ${k.fp} on ${inst.name}`] = `${k.kind}: ${k.message} (new since build ${body.page_errors.build})`;
  return out;
}

/** Three looks: `{[check]: [reason | null | undefined, ...]}` (undefined: not seen on that look). */
export async function looks(instances, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl, env } = {}) {
  const seen = {};
  for (let i = 0; i < LOOKS; i++) {
    if (i) await sleep(GAP_MS);
    const results = await Promise.all(instances.map((inst) => lookAt(inst, { fetchImpl, env })));
    for (const r of results) for (const [k, v] of Object.entries(r)) (seen[k] ??= Array(LOOKS).fill(undefined))[i] = v;
  }
  return seen;
}

/** Edge-trigger: `{down, up, checks}`, `checks` the new {name: {since, reason}} of what is down. */
export function transitions(prev, seen, instances, now) {
  const checks = { ...prev }, down = [], up = [];
  const reachable = (inst) => seen[`instance ${inst}`]?.every((v) => v === null);
  for (const [name, vals] of Object.entries(seen)) {
    if (vals.every((v) => typeof v === 'string') && !checks[name]) {
      checks[name] = { since: now, reason: vals[LOOKS - 1] };
      down.push(`- ${name}: ${vals[LOOKS - 1]} (${LOOKS} looks over ${(GAP_MS * (LOOKS - 1)) / 1000} s)`);
    } else if (vals.every((v) => v === null) && checks[name]) {
      up.push(`- ${name} (down since ${stamp(checks[name].since)}, ${Math.round((now - checks[name].since) / 60_000)} min)`);
      delete checks[name];
    }
  }
  // A world that was down and is on no look of a reachable instance (it was moved or removed) is no longer watched.
  for (const name of Object.keys(checks)) {
    const m = /^world .+ on (.+)$/.exec(name);
    if (m && !seen[name] && instances.includes(m[1]) && reachable(m[1])) {
      up.push(`- ${name} (no longer on the machine)`);
      delete checks[name];
    }
  }
  return { down, up, checks };
}

/** One run: three looks, then the messages. `send(text)` is true when delivered. Returns the new state. */
export async function run(instances, state, send, { now = Date.now, ...io } = {}) {
  const seen = await looks(instances, io);
  const t = now();
  const page = Object.entries(seen).filter(([k]) => k.startsWith(`${PAGE} `));
  for (const [k] of page) delete seen[k];
  const { down, up, checks } = transitions(state.checks ?? {}, seen, instances.map((i) => i.name), t);
  // O25: each page-error kind on any look; told once, forgotten once an answering look no longer lists it (a new
  // release). An instance that did not answer keeps what was told of it.
  const pageNow = Object.fromEntries(page.map(([k, v]) => [k, v.findLast((x) => typeof x === 'string')]).filter(([, v]) => v));
  for (const [k, v] of Object.entries(state.pageErrors ?? {})) if (!seen[`instance ${k.split(' on ').at(-1)}`]?.every((x) => x === null)) pageNow[k] ??= v;
  const fresh = Object.entries(pageNow).filter(([k]) => !(state.pageErrors ?? {})[k]);
  const msgs = [];
  if (down.length) msgs.push(`Souls alert: a world or machine is in trouble\n${down.join('\n')}`);
  if (up.length) msgs.push(`Souls recovered:\n${up.join('\n')}`);
  if (fresh.length) msgs.push(`Souls: a new kind of error in visitors' pages\n${fresh.map(([k, v]) => `- ${k.slice(PAGE.length + 1)}: ${v}`).join('\n')}`);
  let delivered = true;
  for (const m of msgs) delivered = (await send(m)) && delivered;
  return {
    checks: delivered ? checks : (state.checks ?? {}),
    pageErrors: delivered ? pageNow : (state.pageErrors ?? {}),
    last: { at: t, seen, sent: msgs, delivered },
  };
}

/** `file:<path>` or `discord-dm`. */
export function sink(spec, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (spec.startsWith('file:')) {
    const path = spec.slice(5);
    return async (text) => { appendFileSync(path, JSON.stringify({ at_unix_ms: now(), text }) + '\n'); return true; };
  }
  if (spec === 'discord-dm') {
    const headers = { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' };
    const call = async (path, payload) => {
      const r = await fetchImpl(`https://discord.com/api/v10${path}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    return async (text) => {
      try {
        const { id } = await call('/users/@me/channels', { recipient_id: env.DISCORD_USER_ID });
        await call(`/channels/${id}/messages`, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } });
        return true;
      } catch (e) { console.error(`message not delivered: ${e.message}`); return false; }
    };
  }
  throw new Error(`unknown sink ${spec}`);
}

const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const instances = read(opt('instances')).instances ?? [];
  const statePath = opt('state'), send = sink(opt('sink')), every = Number(opt('every', 0)) * 1000;
  for (;;) {
    const started = Date.now();
    const state = await run(instances, read(statePath), send);
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
    renameSync(`${statePath}.tmp`, statePath);
    console.log(JSON.stringify({ at: state.last.at, down: Object.keys(state.checks), sent: state.last.sent.length }));
    if (!every) break;
    await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - started))));
  }
}
