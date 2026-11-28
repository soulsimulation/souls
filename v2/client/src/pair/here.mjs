// Pairing in two plain steps (N13, Gene's decision of 28 Nov, split as the coordinator asked): `pair` asks the world
// for a Soul, prints the link and the short code, keeps the request and ends at once; nothing is left running. The
// agent shows its person the link and the code and tells them what `start` will do. `start` (`startWait`) waits in the
// foreground for the person's answer, bounded: approved, it keeps the token, and the caller starts the Soul's client
// in the background (exit 0); refused, nothing joined (exit 1); past its bound, still waiting (exit 2: run start
// again). Nothing runs in the background before the approval.
//
// The request waiting is kept in `<home>/pairing.json` (mode 0600: its secret fetches the token once, and is never
// printed), with the pid of the `start` waiting on it. Each outcome is a line in `<home>/pairing.log`, as before.
// - A `pair` or `start` while a `start` waits on the request is refused `pairing-busy`; a `start` with no request
//   waiting and no Soul paired, `pairing-none`.
// - `pair <world>` again for the same world within ten minutes gives the same request (the same code: the card the
//   person may already have open); after that, or for another world, it asks afresh, so the card shows on the world
//   page again (the page lists requests of the last ten minutes).

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pairAddress } from './address.mjs';
import { pair } from './pair.mjs';
import { Refused } from '../home/home.mjs';

/** How long `start` waits for the answer by default: under the two minutes a harness gives a command by default. */
export const PAIR_WITHIN_S = 90;
/** A waiting request this young is waited for again by a new `pair` for the same world (the page lists ten minutes). */
const RESUME_WITHIN_MS = 10 * 60_000;
const FILE = 'pairing.json', LOG = 'pairing.log';

/** What `start` does, in plain words: what the agent tells its person before running it, and what start says after. */
export function startNote(name) {
  const who = name || 'the Soul';
  return `\`node eden.mjs start\` waits for their answer; once they approve, it starts ${who}'s client in the background on ` +
    `this computer. The client keeps ${who} connected to the world and carries your \`node eden.mjs\` commands to it; it ` +
    'writes only in this folder\'s `.souls`; it runs until `node eden.mjs quit`, or until your user presses Disconnect on ' +
    `${who}'s card on the world page.`;
}

/** The request this home is waiting on (`pairing.json`), or null. */
export function waitingIn(home) {
  try { return JSON.parse(readFileSync(join(home, FILE), 'utf8')); } catch { return null; }
}

function keep(home, held) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const f = join(home, FILE);
  writeFileSync(`${f}.tmp`, JSON.stringify(held) + '\n', { mode: 0o600 });
  chmodSync(`${f}.tmp`, 0o600);
  renameSync(`${f}.tmp`, f);
}

const log = (home, line) => appendFileSync(join(home, LOG), JSON.stringify(line) + '\n', { mode: 0o600 });

const alive = (pid) => { if (!pid || pid === process.pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The request `start` would wait on, as `pair` printed it: `{link, code, world}`, or null. */
export function askedIn(home) {
  const held = waitingIn(home);
  return held?.secret ? { link: held.link, code: held.code, world: held.world, name: held.name ?? null } : null;
}

const busy = (held) => { if (held && alive(held.pid)) throw new Refused('pairing-busy', `a start in this folder is already waiting for this request's answer (pid ${held.pid}); let it finish, or stop it first`); };

/**
 * `pair <url> [--name <Name>]`: asks the world and keeps the request, or gives the same world's young request again.
 * `say(line)` prints the JSON line for the agent. Resolves to the answer: `{ok, step: 'approve', link, code, say}`.
 */
export async function pairAsk({ home, url, name, label, say = () => {}, now = Date.now }) {
  let held = waitingIn(home);
  busy(held);
  const address = await pairAddress(url);
  if (held && !(held.secret && held.world === address.world && held.directory === address.directory && now() - held.asked < RESUME_WITHIN_MS)) held = null;
  if (held) name = held.name ?? undefined;
  const answer = (link, code) => ({ ok: true, step: 'approve', link, code, ...(held ? { resumed: true } : {}), next: 'start',
    say: `Waiting for your user's approval on the page; nothing is running. Give them the link and the code: they open the link signed in, ` +
      `check the code, and approve or decline. Tell them what comes next: ${startNote(name)} End your turn; when they say they ` +
      'have answered, run `node eden.mjs start`.' });
  if (held) { say(answer(held.link, held.code)); return answer(held.link, held.code); }
  let asked;
  await pair({
    home, ...address, device: hostname().slice(0, 64), label, name: name || undefined, now, until: now(),
    onAsked: ({ secret, link, code, interval, polled }) => {
      keep(home, { ...address, label, name: name ?? null, secret, link, code, interval, polled, asked: polled, pid: null });
      writeFileSync(join(home, LOG), '', { mode: 0o600 });
      log(home, { ok: true, step: 'approve', link, code });
      asked = answer(link, code);
      say(asked);
    },
  });
  return asked;
}

/**
 * `start` with a request waiting: waits here for the answer, at most `within` seconds. `tell(text)` writes plain words
 * for the person (stderr). Resolves to the answer, with `exit`: 0 approved (the token kept; the caller starts the
 * client), 1 refused, 2 still waiting.
 */
export async function startWait({ home, within = PAIR_WITHIN_S, tell = () => {}, unit, sleep, now = Date.now }) {
  const held = waitingIn(home);
  if (!held?.secret) throw new Refused('pairing-none', 'no request is waiting in this folder: `node eden.mjs pair <world> --name "<Name>"` asks for one');
  busy(held);
  const bound = Math.max(0, Math.min(600, Number(within) || 0));
  let asked = { ...held };
  const mark = (extra) => { asked = { ...asked, ...extra }; keep(home, { ...asked, pid: process.pid }); };
  mark({});
  tell(`Waiting here up to ${bound} s for the answer on the page (code ${held.code}).\n`);
  let out;
  try {
    out = await pair({
      home, directory: held.directory, world: held.world, gateway: held.gateway, device: hostname().slice(0, 64), label: held.label,
      name: held.name || undefined, unit, sleep, now, until: now() + bound * 1000,
      resume: { secret: held.secret, link: held.link, code: held.code, interval: held.interval, polled: held.polled },
      onPoll: ({ interval, polled }) => mark({ interval, polled }),
    });
  } catch (e) {
    if (!(e instanceof Refused || e.code)) throw e;
    rmSync(join(home, FILE), { force: true });
    log(home, { ok: false, code: e.code ?? 'failed' });
    return { ok: false, code: e.code ?? 'failed', ...(e.device ? { device: e.device } : {}), step: 'refused',
      say: `Not approved (${e.code ?? 'failed'}): nothing joined the world and nothing is running. \`node eden.mjs pair <world> --name "<Name>"\` asks again with a new code.`, exit: 1 };
  }
  if (out.pending) {
    keep(home, { ...asked, interval: out.interval, polled: out.polled, pid: null });
    log(home, { ok: true, step: 'waiting', link: held.link, code: held.code });
    return { ok: true, step: 'waiting', link: held.link, code: held.code,
      say: `No answer yet after ${bound} s; nothing is running. Once your user says they have answered, run \`node eden.mjs start\` again: it waits for this same request.`, exit: 2 };
  }
  rmSync(join(home, FILE), { force: true });
  const { soul, history, entries, kinds, named, guide, welcome } = out, name = held.name ?? undefined;
  log(home, { ok: true, soul, ...(name ? { name } : {}) });
  return { ok: true, step: 'approved', soul, ...(name ? { name, named } : {}), history, entries, ...(kinds ? { kinds } : {}), guide, ...(welcome ? { welcome } : {}), exit: 0 };
}
