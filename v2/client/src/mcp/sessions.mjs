// The hosted sessions behind the MCP endpoint (Engine v2 R21, #3334): one per token, keyed by the hash of the world
// and the token, opened on the first call and closed after IDLE_MS without one. A session is R6's resident daemon
// (`../daemon/daemon.mjs`), unchanged, in a private folder of its own: the daemon is a process with its lock, state
// and socket on disk, so it cannot run inside this one (Step 0). The token is written to that folder's
// credentials.json (mode 0600) only until the daemon has read it, then removed: from there it is held in the
// daemon's memory and this process's, never in a log, an argument or an environment variable.
//
// - A token the gateway refuses (`token.refused`, in the daemon's log) closes the session and is refused for
//   REFUSED_MS without opening another: the endpoint answers 401.
// - Open sessions are capped by memory: each counts as the daemon's resident size when it opened. Past the cap a
//   new session is refused by name (`sessions-full`), never queued.
// - A retried `act` (the same JSON-RPC id) gets the first call's answer and sends nothing (`acts`).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), '../daemon/daemon.mjs');
export const IDLE_MS = 10 * 60_000;
export const REFUSED_MS = 60_000;
const OPEN_WITHIN = 20_000, ACTS_KEPT = 64;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A refusal the endpoint answers by name, with its HTTP status. */
export class SessionRefused extends Error {
  constructor(code, status, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.status = status;
  }
}

/**
 * The sessions of one service. `gatewayOf(slug)` gives a world's gateway (`ws://…/v2/ws`) or null; `root` is a
 * private folder for the sessions; `pkg` replica's wasm-bindgen package; `maxBytes` the memory cap; `log(line)`
 * the service's log, which is given no token, path, world or hash.
 */
export function openSessions({ gatewayOf, root, pkg, maxBytes = 2 * 1024 ** 3, idleMs = IDLE_MS, log = () => {} }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const sessions = new Map(); // key → session, or the promise of one opening
  const refused = new Map(); // key → until when it is refused
  let opened = 0;
  const used = () => [...sessions.values()].reduce((n, s) => n + (s.rss ?? 0), 0);

  const keyOf = (slug, token) => createHash('sha256').update(`${slug}\n${token}`).digest('hex');

  async function open(key, slug, token) {
    const gateway = gatewayOf(slug);
    if (!gateway) throw new SessionRefused('no-such-world', 404, 'no world has that address');
    const open = [...sessions.values()].filter((s) => s.rss);
    const each = open.length ? used() / open.length : 0;
    if (open.length && used() + each > maxBytes) {
      log(`refused: sessions-full (${open.length} open, ${Math.round(used() / 1e6)} MB)`);
      throw new SessionRefused('sessions-full', 503, 'this service holds as many sessions as its memory allows; try again later');
    }
    // A folder of its own each time: a session being closed removes its folder a moment later.
    const id = key.slice(0, 16), dir = join(root, `${id}-${++opened}`), soul = `s_${id}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds: { [slug]: { gateway } } }));
    const credentials = join(dir, 'credentials.json');
    writeFileSync(credentials, JSON.stringify({ souls: { [soul]: { [slug]: { token } } } }), { mode: 0o600 });
    chmodSync(credentials, 0o600);
    const rt = runtimeOf(dir, soul);
    const child = spawn(process.execPath, [DAEMON, '--home', dir, '--soul', soul, '--pkg', pkg], { cwd: rt.dir, stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
    let ended = false;
    child.on('exit', () => { ended = true; });
    const s = { key, dir, soul, rt, child, busy: 0, last: Date.now(), logAt: 0, acts: new Map(), rss: null, refused: false };
    try {
      const until = Date.now() + OPEN_WITHIN;
      for (;;) {
        scan(s);
        if (s.refused) throw new SessionRefused('token-refused', 401, 'the world refused this token');
        if (s.synced) break;
        if (ended) throw new SessionRefused('session-failed', 503, 'the session ended as it opened');
        if (Date.now() > until) throw new SessionRefused('world-not-answering', 503, 'the world did not answer in time');
        await sleep(25);
      }
      s.rss = (await request(rt.socket, { op: 'status' })).rssBytes;
    } catch (e) {
      close(s, 'not opened');
      throw e;
    } finally {
      rmSync(credentials, { force: true }); // the daemon has read it, or never will
    }
    log(`session opened (${[...sessions.values()].filter((x) => x.rss).length + 1} open)`);
    return s;
  }

  /** What the daemon's log says since it was last read: signed in and current, or the token refused. */
  function scan(s) {
    let size;
    try { size = statSync(s.rt.log).size; } catch { return; }
    if (size <= s.logAt) return;
    const fd = openSync(s.rt.log, 'r'), buf = Buffer.alloc(size - s.logAt);
    try { readSync(fd, buf, 0, buf.length, s.logAt); } finally { closeSync(fd); }
    s.logAt = size;
    const text = buf.toString('utf8');
    if (/ synced \(| signed in: stream\.resumed/.test(text)) s.synced = true;
    if (/ token\.refused/.test(text)) s.refused = true;
  }

  function close(s, why) {
    if (sessions.get(s.key) === s) sessions.delete(s.key);
    request(s.rt.socket, { op: 'stop' }, 1000).catch(() => {}).finally(() => {
      setTimeout(() => { s.child.kill(); rmSync(s.dir, { recursive: true, force: true }); }, 200).unref();
    });
    if (s.rss) log(`session closed: ${why}`);
  }

  /** The session for this world and token, opening it if there is none. */
  async function sessionFor(slug, token) {
    const key = keyOf(slug, token);
    if ((refused.get(key) ?? 0) > Date.now()) throw new SessionRefused('token-refused', 401, 'the world refused this token');
    let s = sessions.get(key);
    if (!s) {
      const opening = open(key, slug, token);
      sessions.set(key, opening);
      try {
        s = await opening;
        sessions.set(key, s);
      } catch (e) {
        if (sessions.get(key) === opening) sessions.delete(key);
        if (e.code === 'token-refused') { refused.set(key, Date.now() + REFUSED_MS); log('refused: a token the world refused'); }
        throw e;
      }
    } else if (s instanceof Promise) {
      s = await s;
    }
    scan(s);
    if (s.refused) {
      close(s, 'token refused');
      refused.set(key, Date.now() + REFUSED_MS);
      throw new SessionRefused('token-refused', 401, 'the world refused this token');
    }
    return s;
  }

  /**
   * One daemon request in this world for this token. `rpcId` is the host's JSON-RPC id: an `act` with an id already
   * answered gets that answer again and is not sent. A daemon that is gone is reopened once.
   */
  async function call(slug, token, req, rpcId) {
    for (let tries = 0; ; tries++) {
      const s = await sessionFor(slug, token);
      const actKey = req.op === 'act' && rpcId !== undefined && rpcId !== null ? `${typeof rpcId}:${rpcId}` : null;
      if (actKey && s.acts.has(actKey)) { s.last = Date.now(); return s.acts.get(actKey); }
      s.busy++;
      try {
        const pending = request(s.rt.socket, req, req.op === 'wait' ? (req.seconds ?? 30) * 1000 + 5000 : 5000);
        if (actKey) { s.acts.set(actKey, pending); if (s.acts.size > ACTS_KEPT) s.acts.delete(s.acts.keys().next().value); }
        const answer = await pending;
        if (req.op === 'stop') close(s, 'stopped');
        return answer;
      } catch (e) {
        if (actKey) s.acts.delete(actKey);
        // Never connected: the request reached no daemon, so nothing was sent and it is safe to open another.
        if (['ENOENT', 'ECONNREFUSED'].includes(e.code) && tries === 0) { close(s, 'gone'); continue; }
        throw e;
      } finally {
        s.busy--;
        s.last = Date.now();
      }
    }
  }

  const sweep = setInterval(() => {
    for (const s of [...sessions.values()]) if (!(s instanceof Promise) && s.busy === 0 && Date.now() - s.last > idleMs) close(s, 'idle');
    for (const [k, until] of refused) if (until < Date.now()) refused.delete(k);
  }, Math.min(30_000, idleMs)).unref();

  return {
    call,
    /** Opens or checks the session for this world and token; throws SessionRefused (401 for a refused token). */
    check: async (slug, token) => { await sessionFor(slug, token); },
    get open() { return [...sessions.values()].filter((s) => !(s instanceof Promise)).length; },
    /** The folder of the session for this world and token, if one is open (for tests and the runbook's checks). */
    dirOf: (slug, token) => sessions.get(keyOf(slug, token))?.dir ?? null,
    async closeAll() {
      clearInterval(sweep);
      const all = [...sessions.values()].filter((s) => !(s instanceof Promise));
      for (const s of all) close(s, 'service stopping');
      await sleep(300);
    },
  };
}
