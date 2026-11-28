// `pair` in the foreground (N13, Gene's decision of 28 Nov): it asks the world for a Soul, prints the link and the
// short code, and waits here, in this command, for the person's answer on the page. It ends when the answer comes:
// approved (the token kept, exit 0), refused (nothing joined, exit 1), or after its wait bound (exit 2), saying how
// to wait again: `pair --wait` waits for the same request. Nothing is left running when it ends, and nothing runs in
// the background: the Soul's client starts only when the agent runs `start`, after telling its person (`START`).
//
// The request waiting is kept in `<home>/pairing.json` (mode 0600: its secret fetches the token once, and is never
// printed), with the pid of the command waiting on it. Each outcome is a line in `<home>/pairing.log`, as before.
// - A second `pair` while one waits is refused `pairing-busy`; `pair --wait` with no request waiting, `pairing-none`.
// - `pair <world>` again for the same world, within ten minutes, waits for the same request (the same code: the card
//   the person may already have open); after that, or for another world, it asks afresh, so the card shows on the
//   world page again (the page lists requests of the last ten minutes).

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pairAddress } from './address.mjs';
import { pair } from './pair.mjs';
import { Refused } from '../home/home.mjs';

/** How long `pair` waits for the answer by default: under the two minutes a harness gives a command by default. */
export const PAIR_WITHIN_S = 90;
/** A waiting request this young is waited for again by a new `pair` for the same world (the page lists ten minutes). */
const RESUME_WITHIN_MS = 10 * 60_000;
const FILE = 'pairing.json', LOG = 'pairing.log';

/** What the agent tells its person before it runs `start`, and what `start` says once it has: plain facts. */
export function startNote(name) {
  const who = name || 'the Soul';
  return `The Soul's client is not running yet. Before you run \`node eden.mjs start\`, tell your user what it does: it ` +
    `starts the Soul's client in the background on this computer. It keeps ${who} connected to the world and carries ` +
    'your `node eden.mjs` commands to it; it writes only in this folder\'s `.souls`; it runs until `node eden.mjs quit`, ' +
    `or until your user presses Disconnect on ${who}'s card on the world page.`;
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

/** The last outcome `pairing.log` holds for an approved Soul, or null. */
function lastApproved(home) {
  try {
    const lines = readFileSync(join(home, LOG), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const last = lines.at(-1);
    return last?.ok === true && typeof last.soul === 'string' ? last : null;
  } catch { return null; }
}

/**
 * `pair <url> [--name <Name>]` (url given) or `pair --wait` (none): waits here for the answer, at most `within`
 * seconds. `say(line)` prints a JSON line for the agent, `tell(text)` plain words for the person (stderr).
 * Resolves to the last answer, with `exit`: 0 approved, 1 refused, 2 still waiting.
 */
export async function pairHere({ home, url, name, within = PAIR_WITHIN_S, label, say, tell = () => {}, unit, sleep, now = Date.now }) {
  let held = waitingIn(home);
  if (held && alive(held.pid)) throw new Refused('pairing-busy', `another pair command in this folder is already waiting for this request (pid ${held.pid}); let it finish, or stop it first`);
  let address;
  if (url) {
    address = await pairAddress(url);
    // The same world's young request is waited for again; an old one, or another world's, is left and asked afresh.
    if (held && !(held.world === address.world && held.directory === address.directory && now() - held.asked < RESUME_WITHIN_MS)) held = null;
  } else if (!held) {
    const done = lastApproved(home);
    if (done) return { ok: true, step: 'approved', soul: done.soul, ...(done.name ? { name: done.name } : {}), already: true, next: 'start', say: `Already approved: nothing is waiting. ${startNote(done.name)}`, exit: 0 };
    throw new Refused('pairing-none', 'no request is waiting in this folder: `node eden.mjs pair <world> --name "<Name>"` asks for one');
  }
  const where = held ?? { ...address, name: name ?? null, label };
  if (held) name = held.name ?? undefined;
  const bound = Math.max(0, Math.min(600, Number(within) || 0));
  const until = now() + bound * 1000;
  let asked = held ? { ...held } : null;
  const mark = (extra) => { asked = { ...asked, ...extra }; keep(home, { ...asked, pid: process.pid }); };
  let out;
  try {
    out = await pair({
      home, directory: where.directory, world: where.world, gateway: where.gateway, device: hostname().slice(0, 64), label: where.label ?? label,
      name: name || undefined, unit, sleep, now, until,
      resume: held ? { secret: held.secret, link: held.link, code: held.code, interval: held.interval, polled: held.polled } : undefined,
      onAsked: ({ secret, link, code, interval, polled }) => {
        if (existsSync(join(home, LOG)) && !held) writeFileSync(join(home, LOG), '', { mode: 0o600 });
        mark({ directory: where.directory, world: where.world, gateway: where.gateway, label: where.label ?? label, name: name ?? null, secret, link, code, interval, polled, asked: polled });
      },
      onAsk: ({ link, code }) => {
        if (held) mark({});
        const line = { ok: true, step: 'approve', link, code, ...(held ? { resumed: true } : {}),
          say: `Give your user the link and the code: they open the link signed in, check the code, and approve or decline. This command waits here up to ${bound} s for their answer.` };
        log(home, { ok: true, step: 'approve', link, code });
        say(line);
        tell(`Waiting here up to ${bound} s for the answer on the page (code ${code}). Nothing runs in the background meanwhile.\n`);
      },
      onPoll: ({ interval, polled }) => mark({ interval, polled }),
    });
  } catch (e) {
    if (e instanceof Refused || e.code) {
      rmSync(join(home, FILE), { force: true });
      log(home, { ok: false, code: e.code ?? 'failed' });
      return { ok: false, code: e.code ?? 'failed', ...(e.device ? { device: e.device } : {}), step: 'refused',
        say: `Not approved (${e.code ?? 'failed'}): nothing joined the world and nothing is running. \`node eden.mjs pair <world> --name "<Name>"\` asks again with a new code.`, exit: 1 };
    }
    throw e;
  }
  if (out.pending) {
    keep(home, { ...asked, interval: out.interval, polled: out.polled, pid: null });
    log(home, { ok: true, step: 'waiting', link: asked.link, code: asked.code });
    return { ok: true, step: 'waiting', link: asked.link, code: asked.code,
      say: `No answer yet after ${bound} s. Nothing is running now. Give your user the link and the code if you have not, ` +
        'and once they say they answered, run `node eden.mjs pair --wait`: it waits for this same request.', exit: 2 };
  }
  rmSync(join(home, FILE), { force: true });
  const { soul, history, entries, kinds, named, guide, welcome } = out;
  log(home, { ok: true, soul, ...(name ? { name } : {}) });
  return { ok: true, step: 'approved', soul, ...(name ? { name, named } : {}), history, entries, ...(kinds ? { kinds } : {}), guide, ...(welcome ? { welcome } : {}),
    next: 'start', say: `Approved: ${name || 'the Soul'} is yours. ${startNote(name)}`, exit: 0 };
}
