// #2124 MEASUREMENT BRANCH ONLY (never merged): a V8 .cpuprofile folded into what a report can carry: self and inclusive
// time per function, and the long synchronous turns (consecutive samples with JS or GC on the stack, broken by idle or
// program samples), each with the functions it spent its time in. Paths are made relative to the repository.
import { readFileSync } from 'node:fs';

export function summarizeProfile(file, repo, { turnMs = 100, top = 40 } = {}) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(p.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const rel = (u) => String(u || '').replace(/^file:\/\//, '').split(repo + '/').pop().replace(/^.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'nm:').replace(/^\/.*\/([^/]+\/[^/]+)$/, '…/$1');
  const label = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${rel(f.url)}:${f.lineNumber + 1}`; };
  const stackOf = new Map();
  const stack = (id) => { if (stackOf.has(id)) return stackOf.get(id); const out = []; for (let x = id; x != null; x = parent.get(x)) out.push(x); stackOf.set(id, out); return out; };
  const BREAK = new Set(['(idle)', '(program)', '(root)']);
  const self = new Map(), incl = new Map(), turns = [];
  let cur = null, total = 0, busy = 0;
  const n = p.samples.length;
  for (let i = 0; i < n; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000; total += dt;
    const node = byId.get(p.samples[i]), name = node.callFrame.functionName;
    if (BREAK.has(name)) { if (cur) { turns.push(cur); cur = null; } continue; }
    busy += dt;
    const s = stack(node.id), lb = label(node);
    self.set(lb, (self.get(lb) ?? 0) + dt);
    const seen = new Set(); for (const id of s) { const l = label(byId.get(id)); if (seen.has(l)) continue; seen.add(l); incl.set(l, (incl.get(l) ?? 0) + dt); }
    if (!cur) cur = { ms: 0, startMs: 0, fns: new Map(), selfs: new Map() };
    cur.ms += dt; for (const l of seen) cur.fns.set(l, (cur.fns.get(l) ?? 0) + dt); cur.selfs.set(lb, (cur.selfs.get(lb) ?? 0) + dt);
  }
  if (cur) turns.push(cur);
  const r1 = (x) => Math.round(10 * x) / 10;
  const topOf = (m, k = top) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, ms]) => ({ f, ms: r1(ms) }));
  const app = (f) => /(apps|packages|mars)\//.test(f) && !/prof-hook/.test(f);
  const long = turns.filter((t) => t.ms >= turnMs).sort((a, b) => b.ms - a.ms);
  // across the turns of 300 ms or more: each app function's time inside them (counted once per turn), and how many
  const over = long.filter((t) => t.ms >= 300), acc = new Map(), cnt = new Map();
  for (const t of over) for (const [f, ms] of t.fns) if (app(f)) { acc.set(f, (acc.get(f) ?? 0) + ms); cnt.set(f, (cnt.get(f) ?? 0) + 1); }
  const hist = {}; for (const b of [50, 100, 200, 300, 500, 1000]) hist[`>=${b}`] = turns.filter((t) => t.ms >= b).length;
  return {
    totalMs: r1(total), busyMs: r1(busy), turns: turns.length, turnHist: hist,
    overMs300: { n: over.length, ms: r1(over.reduce((s, t) => s + t.ms, 0)), appFns: [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([f, ms]) => ({ f, ms: r1(ms), turns: cnt.get(f) })) },
    self: topOf(self, 60), inclusiveApp: topOf(new Map([...incl].filter(([f]) => app(f))), 80),
    longTurns: long.slice(0, 40).map((t) => ({ ms: r1(t.ms), app: [...t.fns.entries()].filter(([f]) => app(f)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([f, ms]) => ({ f, ms: r1(ms) })), self: topOf(t.selfs, 8) })),
  };
}
