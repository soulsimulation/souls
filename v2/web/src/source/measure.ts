// V13's measure (Engine v2 V13, #2745): A1's delay from an effect's commit to its drawing, A2's private fields and
// A5's bytes a second, with the page's own socket source and clock against a real gateway and view tier.
//
// It starts gatewayd's `owner_view` example (a hall of walkers committed at 20 ticks a second), signs in as soul 1 and
// follows its body at `full`, and steps `NearClock` every 1/60 s as the page's frame loop does. An effect is drawn on
// the first frame whose clock reaches its world time; its commit is the wall time the example handed its tick to the
// view tier (`anchorWallMs + at`). Prints one JSON line.
//
//   node src/source/measure.ts --bin <owner_view binary> --dir <scratch dir> [--seconds 600] [--bodies 30]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NearClock } from './near.ts';
import { SocketSource } from './socket.ts';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const seconds = Number(arg('--seconds', '600'));
const bodies = arg('--bodies', '30')!;
const child = spawn(arg('--bin')!, ['--bodies', bodies, '--seconds', String(seconds + 15), '--dir', arg('--dir')!], { stdio: ['ignore', 'pipe', 'inherit'] });
const first: string = await new Promise((ok) => createInterface({ input: child.stdout! }).once('line', ok));
const run = JSON.parse(first) as { url: string; token1: string; follow: string; anchorWallMs: number; soul1: string; soul2: string };

const now = () => performance.timeOrigin + performance.now();
const src = new SocketSource({ url: run.url, token: run.token1, follow: run.follow, level: 1, budget: 16_000, now });
const pending: { at: number; commit: number }[] = [];
const delays: number[] = [];
let measuring = false;
src.start({
  part: (p) => measuring && pending.push({ at: p.to, commit: run.anchorWallMs + p.to / 1000 }),
  pointer: () => {},
  error: (m) => console.error(m),
});

const clock = new NearClock();
let last = now(), bytes0 = 0, t0 = 0;
const frame = setInterval(() => {
  const n = now();
  const t = clock.step(n - last, src.liveNow(), (n - run.anchorWallMs) * 1000, null);
  last = n;
  if (t === null) return;
  while (pending.length && pending[0].at <= t) delays.push(n - pending.shift()!.commit);
}, 1000 / 60);

// Ten seconds to settle, then the measured window.
await new Promise((ok) => setTimeout(ok, 10_000));
measuring = true;
bytes0 = src.bytes;
t0 = now();
await new Promise((ok) => setTimeout(ok, seconds * 1000));
const span = (now() - t0) / 1000;
clearInterval(frame);
src.stop();
child.kill();

delays.sort((a, b) => a - b);
const q = (f: number) => Math.round(delays[Math.min(delays.length - 1, Math.floor(f * delays.length))]);
console.log(JSON.stringify({
  seconds: Math.round(span), bodies: Number(bodies), effects_drawn: delays.length,
  delay_ms: { median: q(0.5), p95: q(0.95), max: Math.round(delays[delays.length - 1]) },
  grant: src.grant,
  bytes_per_s: Math.round((src.bytes - bytes0) / span),
  entries_by_audience: { public: src.seen.get('public') ?? 0, own: src.seen.get(run.soul1) ?? 0, another_owner: src.seen.get(run.soul2) ?? 0 },
}));
process.exit(0);
