// V13b (#3407) A2, end to end on a local world: the page's own sign-in (`exchange`, `chooseFollow`) and socket source
// against the real directory (`directoryd`, its test sign-in for a local world) and a real gateway and view tier
// (gatewayd's `owner_view` example). From a test person's session alone, with no token in any address, the page gets a
// view token, picks the body to follow from the account's own Souls and receives its view near live: its Soul's
// private entries and the public ones, never another owner's.
//
// In v2: `cargo build -p directoryd && cargo build --release -p gatewayd --example owner_view`, then in v2/web
// `node src/source/signin-e2e.ts --directoryd ../target/debug/directoryd --view ../target/release/examples/owner_view
// --dir <scratch dir> [--seconds 10]`. Prints one JSON line and exits 0 when every check holds.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SocketSource, chooseFollow, exchange } from './socket.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = resolve(arg('--dir') ?? '.local/signin-e2e');
const seconds = Number(arg('--seconds') ?? 10);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const keyFile = join(dir, 'view.key');
writeFileSync(keyFile, randomBytes(32).toString('hex'));

const children: ChildProcess[] = [];
const firstLine = (c: ChildProcess) => new Promise<string>((ok) => createInterface({ input: c.stdout! }).once('line', ok));
let directoryLog = '';
try {
  // The local world: a gateway and view tier, soul 1's body and five others walking; soul 2 has private fields too.
  const world = spawn(resolve(arg('--view')!), ['--bodies', '5', '--seconds', String(seconds + 20), '--dir', dir, '--view-key', keyFile]);
  children.push(world);
  world.stderr!.resume();
  const w = JSON.parse(await firstLine(world)) as { url: string; follow: string; grant1: string; soul1: string; soul2: string };
  // The directory, with the test sign-in for a local world: Ada owns soul 1, whose body is followed.
  const directory = spawn(resolve(arg('--directoryd')!), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:5173',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--view-key', keyFile, '--test-own', `Ada=${w.grant1}@${w.follow}`]);
  children.push(directory);
  directory.stderr!.on('data', (b) => (directoryLog += b));
  const at = (await firstLine(directory)).replace('listening on ', '');
  const origin = `http://${at}`;

  // The page's sign-in: the session (Ada, a test person) for a view token; the follow target from what she owns.
  const session = { testName: 'Ada' };
  const g = await exchange(origin, session);
  const follow = chooseFollow(g.owned, null);
  const src = new SocketSource({ url: w.url, token: g.token, expires: g.expires, follow: follow!, renew: () => exchange(origin, session) });
  let parts = 0, followed = 0, error = '';
  src.start({ pointer: () => {}, part: (p) => void (parts++, (followed += p.samples.filter((s) => s[0] === follow).length)), error: (m) => (error = m) });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  src.stop();
  const seen = Object.fromEntries(src.seen);
  const mac = g.token.slice(-64);
  const out = {
    exchanged: g.token.startsWith('view.'), expiresIn: g.expires - Math.floor(Date.now() / 1000), owned: g.owned.length,
    followChosen: follow === w.follow, up: src.up || parts > 0, parts, followedSamples: followed,
    public: seen.public ?? 0, ownPrivate: seen[w.soul1] ?? 0, anothersPrivate: seen[w.soul2] ?? 0,
    tokenInAddress: w.url.includes(mac) || origin.includes(mac), tokenInDirectoryLog: directoryLog.includes(mac), error,
  };
  console.log(JSON.stringify(out));
  const ok = out.exchanged && out.followChosen && parts > 0 && followed > 0 && out.ownPrivate > 0 && out.anothersPrivate === 0
    && !out.tokenInAddress && !out.tokenInDirectoryLog && !error;
  process.exitCode = ok ? 0 : 1;
} finally {
  for (const c of children) c.kill();
}
