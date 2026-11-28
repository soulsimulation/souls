// P7b lever E1: index.html's two-phase loader (phased-entry.ts) and the head script's decision (snapshot-prefetch.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APP_CDN_HANG_MS, PHASE2_FALLBACK_MS, PHASE2_FILL, PHASE2_GLOBAL, SOCKET_FALLBACK_MS, phasedLoaderScript, rewritePhasedHtml } from './phased-entry.ts';
import { phasedEntryWanted } from './snapshot-prefetch.ts';
import { pickQualityTier } from './quality-tier.ts';
import { earlyArrivalWanted } from './early-arrival.ts';

const HTML = `<head>
    <script>prefetch()</script>
    <script type="module" crossorigin src="/worlds/assets/main-A.js"></script>
    <link rel="modulepreload" crossorigin href="/worlds/assets/three-B.js">
    <link rel="modulepreload" crossorigin href="/worlds/assets/react-C.js">
    <link rel="modulepreload" crossorigin href="/worlds/assets/Shell-D.js">
    <link rel="stylesheet" crossorigin href="/worlds/assets/main.css">
  </head>`;

/** Run the loader against a recording document; returns the tags it added, in order, and the window. */
function runLoader(js: string, phased: boolean) {
  const added: { tag: string; url: string; el: Record<string, unknown> }[] = [], timers: (() => void)[] = [];
  const win: Record<string, unknown> = { __soulsPhased: phased, __soulsOpenSocket: () => { added.push({ tag: 'socket', url: '', el: {} }); } };
  const document = { createElement: (tag: string) => ({ tag }), head: { appendChild: (el: Record<string, unknown>) => { added.push({ tag: el.type === 'module' ? 'entry' : String(el.rel), url: String(el.src ?? el.href), el }); } } };
  vm.runInNewContext(js, { window: win, document, setTimeout: (f: () => void) => timers.push(f) });
  return { added, win, timers };
}

test('rewritePhasedHtml: one loader in place of the module script and preloads; phase one = the early entry and its imports', () => {
  const out = rewritePhasedHtml(HTML, 'assets/main-A.js', 'assets/early-E.js', ['assets/three-B.js']);
  assert.doesNotMatch(out, /<script type="module"|<link rel="modulepreload"/);
  assert.match(out, /<link rel="stylesheet" crossorigin href="\/worlds\/assets\/main.css">/, 'stylesheets stay');
  assert.ok(out.indexOf('prefetch()') < out.indexOf('__soulsPhase2'), 'after the head script');
  const js = /<script>(\(function\(\)\{var d=document[\s\S]*?)<\/script>/.exec(out)![1];
  // one phase (desktop, old world): main first, then the early entry, socket with main
  const one = runLoader(js, false);
  assert.deepEqual(one.added.map((a) => `${a.tag} ${a.url}`), ['modulepreload /worlds/assets/react-C.js', 'modulepreload /worlds/assets/Shell-D.js', 'entry /worlds/assets/main-A.js', 'socket ', 'modulepreload /worlds/assets/three-B.js', 'entry /worlds/assets/early-E.js']);
  assert.equal(one.added[2].el.crossOrigin, '', 'crossorigin as Vite wrote it (no second fetch)');
  // two phases: the early entry only, then the rest once phase two is called (once)
  const two = runLoader(js, true);
  assert.deepEqual(two.added.map((a) => a.url), ['/worlds/assets/three-B.js', '/worlds/assets/early-E.js']);
  (two.win[PHASE2_GLOBAL] as () => void)(); (two.win[PHASE2_GLOBAL] as () => void)(); two.timers.forEach((f) => f());
  assert.deepEqual(two.added.slice(2).map((a) => `${a.tag} ${a.url}`), ['modulepreload /worlds/assets/react-C.js', 'modulepreload /worlds/assets/Shell-D.js', 'entry /worlds/assets/main-A.js', 'socket ']);
  // P7d: phase two's downloads first (held entry); t4-phone: no socket yet, then at the early renderer's fill the entry's
  // download and the socket, the entry itself at the next plain call or the fallback
  const held = runLoader(js, true), call = held.win[PHASE2_GLOBAL] as (h?: true | string) => void; call(true); call(true);
  assert.deepEqual(held.added.slice(2).map((a) => `${a.tag} ${a.url}`), ['modulepreload /worlds/assets/react-C.js', 'modulepreload /worlds/assets/Shell-D.js']);
  call(PHASE2_FILL); call(PHASE2_FILL);
  assert.deepEqual(held.added.slice(4).map((a) => `${a.tag} ${a.url}`), ['modulepreload /worlds/assets/main-A.js']);
  // t4-phone3: the socket opens once the entry has downloaded (its join after the entry on the link)
  (held.added[4].el.onload as () => void)();
  assert.deepEqual(held.added.slice(5).map((a) => `${a.tag} ${a.url}`), ['socket ']);
  held.timers.forEach((f) => f()); call();
  assert.deepEqual(held.added.slice(6).map((a) => `${a.tag} ${a.url}`), ['entry /worlds/assets/main-A.js']);
  // t4-phone3: phase two's entry downloads once its other downloads are in and the arrival gate (nearest models) is clear
  const auto = runLoader(js, true), go = auto.win[PHASE2_GLOBAL] as (h?: true | string) => void; go(true);
  let pending = true; const subs: (() => void)[] = [];
  auto.win.__arrivalGate = { pending: () => pending, subscribe: (f: () => void) => { subs.push(f); return () => { subs.length = 0; }; } };
  (auto.added[2].el.onload as () => void)();
  assert.equal(auto.added.length, 4, 'one of two preloads in: nothing more');
  (auto.added[3].el.onerror as () => void)();
  assert.equal(auto.added.length, 4, 'all in, near models still coming: nothing more');
  pending = false; subs.forEach((f) => f());
  assert.deepEqual(auto.added.slice(4).map((a) => `${a.tag} ${a.url}`), ['modulepreload /worlds/assets/main-A.js'], 'gate clear: the entry downloads');
  go(PHASE2_FILL); go();
  assert.deepEqual(auto.added.slice(5).map((a) => `${a.tag} ${a.url}`), ['entry /worlds/assets/main-A.js'], 'the run waits for the download; still no socket');
  (auto.added[5].el.onload as () => void)(); (auto.added[4].el.onload as () => void)();
  assert.deepEqual(auto.added.slice(6).map((a) => `${a.tag} ${a.url}`), ['socket '], 'the socket once');
  // the early entry failing to load starts phase two
  const fail = runLoader(js, true); (fail.added[1].el.onerror as () => void)();
  assert.equal(fail.added.filter((a) => a.tag === 'entry').length, 2);
  assert.throws(() => rewritePhasedHtml(HTML.replace('main-A', 'other-A'), 'assets/main-A.js', 'assets/early-E.js', []), /expected one module script/);
  assert.match(phasedLoaderScript({ entry: 'e', preloads: [] }, { entry: 'm', preloads: [] }), new RegExp(`setTimeout\\(two,${PHASE2_FALLBACK_MS}\\)`));
});

test('PF2: a late snapshot no longer holds the socket: it opens by itself within 2.5 s, phase two by 8 s', () => {
  const added: string[] = [], timers: { f: () => void; ms: number }[] = [];
  const win: Record<string, unknown> = { __soulsPhased: true, __soulsOpenSocket: () => { added.push('socket'); } };
  const document = { createElement: (tag: string) => ({ tag }), head: { appendChild: (el: Record<string, unknown>) => { added.push(`${el.type === 'module' ? 'entry' : el.rel} ${el.src ?? el.href}`); } } };
  const entries: Record<string, unknown>[] = [];
  const doc2 = { ...document, head: { appendChild: (el: Record<string, unknown>) => { if (el.src === '/e.js') entries.push(el); document.head.appendChild(el); } } };
  vm.runInNewContext(phasedLoaderScript({ entry: '/e.js', preloads: [] }, { entry: '/m.js', preloads: ['/r.js'] }), { window: win, document: doc2, setTimeout: (f: () => void, ms: number) => { timers.push({ f, ms }); } });
  const until = (ms: number) => { const due = timers.filter((t) => t.ms <= ms); timers.splice(0, timers.length, ...timers.filter((t) => t.ms > ms)); due.forEach((t) => t.f()); };
  // the snapshot never reports in (__soulsPhase2 is not called): live answers in ~0.3-0.6 s, a stalled one held it 15 s
  assert.ok(SOCKET_FALLBACK_MS <= 2_500 && PHASE2_FALLBACK_MS <= 8_000);
  until(2_500);
  assert.deepEqual(added, ['entry /e.js'], 't4-phone3: the 2.5 s count from the early entry\'s load (a phone\'s link was still bringing phase one)');
  (entries[0].onload as () => void)();
  until(2_500);
  assert.deepEqual(added, ['entry /e.js', 'socket'], 'the socket alone, phase two\'s downloads and entry still wait');
  until(8_000);
  assert.deepEqual(added, ['entry /e.js', 'socket', 'modulepreload /r.js', 'entry /m.js'], 'phase two by the fallback, the socket once');
  (win[PHASE2_GLOBAL] as () => void)();
  assert.equal(added.length, 4, 'the snapshot coming later changes nothing');
});

test('t4-phone: once the snapshot has answered, the socket waits for the fill (or phase two), not for 2.5 s', async () => {
  const added: string[] = [], timers: { f: () => void; ms: number }[] = [];
  const win: Record<string, unknown> = { __soulsPhased: true, __soulsOpenSocket: () => { added.push('socket'); }, __soulsSnapshotPrefetch: { response: Promise.resolve({}) } };
  const els: Record<string, unknown>[] = [];
  const document = { createElement: (tag: string) => ({ tag }), head: { appendChild: (el: Record<string, unknown>) => { els.push(el); added.push(`${el.type === 'module' ? 'entry' : el.rel} ${el.src ?? el.href}`); } } };
  vm.runInNewContext(phasedLoaderScript({ entry: '/e.js', preloads: [] }, { entry: '/m.js', preloads: ['/r.js'] }), { window: win, document, setTimeout: (f: () => void, ms: number) => { timers.push({ f, ms }); } });
  await new Promise((r) => setImmediate(r));   // the snapshot's answer
  timers.filter((t) => t.ms <= SOCKET_FALLBACK_MS).forEach((t) => t.f());
  assert.deepEqual(added, ['entry /e.js'], 'no socket at the 2.5 s fallback: its join would share the poster\'s link');
  const call = win[PHASE2_GLOBAL] as (h?: true | string) => void;
  call(true); assert.deepEqual(added.slice(1), ['modulepreload /r.js'], 'held: downloads only');
  call(PHASE2_FILL); assert.deepEqual(added.slice(2), ['modulepreload /m.js'], 'fill: the entry downloads');
  (els[2].onload as () => void)(); assert.deepEqual(added.slice(3), ['socket'], 't4-phone3: the socket opens once it is in');
  timers.filter((t) => t.ms === PHASE2_FALLBACK_MS).forEach((t) => t.f());
  assert.deepEqual(added.slice(4), ['entry /m.js'], 'the entry runs (once), the socket stays one');
  // without the fill (the early renderer gave up or never came), phase two's plain call opens it
  const a2: string[] = [], t2: { f: () => void; ms: number }[] = [];
  const w2: Record<string, unknown> = { __soulsPhased: true, __soulsOpenSocket: () => { a2.push('socket'); }, __soulsSnapshotPrefetch: { response: Promise.resolve({}) } };
  vm.runInNewContext(phasedLoaderScript({ entry: '/e.js', preloads: [] }, { entry: '/m.js', preloads: [] }), { window: w2, document: { createElement: (tag: string) => ({ tag }), head: { appendChild: (el: Record<string, unknown>) => { a2.push(`${el.type === 'module' ? 'entry' : el.rel} ${el.src ?? el.href}`); } } }, setTimeout: (f: () => void, ms: number) => { t2.push({ f, ms }); } });
  await new Promise((r) => setImmediate(r));
  (w2[PHASE2_GLOBAL] as (h?: true) => void)(true); (w2[PHASE2_GLOBAL] as () => void)();
  // t4-phone3: no other downloads and no arrival gate, so the entry downloads at the held call; the socket waits for it
  assert.deepEqual(a2, ['entry /e.js', 'modulepreload /m.js', 'entry /m.js']);
});

test('phasedEntryWanted = the early layer\'s gate (lever D on the page\'s tier) for a new world', () => {
  const searches = ['', '?early=0', '?early=1', '?quality=phone', '?quality=full', '?shot', '?shot&early=1', '?earlyLayer=0', '?phased=0', '?quality=phone&early=0'];
  for (const search of searches) for (const coarse of [false, true]) for (const screen of [[390, 844], [820, 1180], [1440, 900], [0, 0]] as const) for (const mem of [undefined, 2, 8]) {
    const tier = pickQualityTier({ search, coarsePointer: coarse, screen, deviceMemory: mem }).tier, q = new URLSearchParams(search);
    const want = q.get('earlyLayer') !== '0' && q.get('phased') !== '0' && earlyArrivalWanted(tier, true, search, q.has('shot'));
    assert.equal(phasedEntryWanted(search, coarse, screen[0], screen[1], mem), want, `${search} ${coarse} ${screen} ${mem}`);
  }
});

/** #4986: the loader on a page whose config may name the CDN; records the tags, reloads, workers, blobs, the window's
 *  listeners and the timers, and lets a test say which files the browser has had (resource timing). */
function runCdn(js: string, config: unknown, search = '') {
  type Ev = Record<string, unknown> & { fire: (type: string, e?: unknown) => void; listens: (type: string) => number };
  const added: { tag: string; url: string; el: Ev }[] = [], replaced: string[] = [], timers: { f: () => void; ms: number }[] = [];
  const on = (o: Record<string, unknown>): Ev => {
    const ls: Record<string, ((e?: unknown) => void)[]> = {};
    o.addEventListener = (type: string, f: () => void) => { if (type === 'error') o.failed = f; (ls[type] ??= []).push(f); };
    o.fire = (type: string, e?: unknown) => (ls[type] ?? []).forEach((f) => f(e));
    o.listens = (type: string) => (ls[type] ?? []).length;
    return o as Ev;
  };
  const document = { createElement: (tag: string) => on({ tag }), head: { appendChild: (el: Ev) => { added.push({ tag: el.type === 'module' ? 'entry' : String(el.rel), url: String(el.src ?? el.href), el }); } } };
  const location = { pathname: '/w/eden/', search, hash: '#watch', href: 'https://soul.game/w/eden/', replace: (u: string) => replaced.push(u) };
  // the browser's Worker, recording what it was started with; and enough of URL and Blob for the wrapper
  class Worker { static started: [string, unknown][] = []; static made: Ev[] = []; constructor(u: string, o: unknown) { Worker.started.push([u, o]); Worker.made.push(on(this as unknown as Record<string, unknown>)); } }
  const blobs: string[] = [], revoked: string[] = [], arrived: string[] = [], window = on({ __soulsPhased: false, __simConfig: config, Worker });
  const URL_ = Object.assign(function (u: string, b?: string) { return new URL(u, b); }, { createObjectURL: (b: { text: string }) => { blobs.push(b.text); return `blob:https://soul.game/${blobs.length}`; }, revokeObjectURL: (u: string) => { revoked.push(u); } });
  class Blob { text: string; constructor(parts: string[]) { this.text = parts.join(''); } }
  const performance = { getEntriesByType: (type: string) => type === 'resource' ? arrived.map((name) => ({ name })) : [] };
  vm.runInNewContext(js, { window, document, location, URL: URL_, Blob, performance, setTimeout: (f: () => void, ms: number) => { timers.push({ f, ms }); return timers.length; } });
  const after = (ms: number) => { const due = timers.filter((t) => t.ms === ms); due.forEach((t) => t.f()); return due.length; };
  return { added, replaced, window, Original: Worker, blobs, revoked, arrived, after };
}

test('#4986: where the launcher says the build is on the asset CDN, both phases are asked for there, by file name', () => {
  const js = /<script>(\(function\(\)\{var d=document[\s\S]*?)<\/script>/.exec(rewritePhasedHtml(HTML, 'assets/main-A.js', 'assets/early-E.js', ['assets/three-B.js']))![1];
  const run = (config: unknown, search = '') => runCdn(js, config, search);
  const CDN = 'https://cdn.soul.game/assets/app/';
  const on = run({ appCdn: CDN });
  assert.deepEqual(on.added.map((a) => `${a.tag} ${a.url}`), [`modulepreload ${CDN}react-C.js`, `modulepreload ${CDN}Shell-D.js`, `entry ${CDN}main-A.js`, `modulepreload ${CDN}three-B.js`, `entry ${CDN}early-E.js`]);
  assert.ok(on.added.every((a) => a.el.crossOrigin === ''), 'read as another origin\'s module needs it');
  // an entry that does not load from the CDN: the page once more, from the origin; a preload's failure alone does nothing
  assert.equal(on.added[0].el.failed, undefined);
  (on.added[2].el.failed as () => void)();
  assert.deepEqual(on.replaced, ['/w/eden/?appcdn=0#watch']);
  assert.deepEqual(run({ appCdn: CDN }, '?hour=12:00').added[2].url, `${CDN}main-A.js`);
  const off = ['/worlds/assets/react-C.js', '/worlds/assets/Shell-D.js', '/worlds/assets/main-A.js', '/worlds/assets/three-B.js', '/worlds/assets/early-E.js'];
  // not named, another place named, or the visitor (or the loader's own fallback) asked for the origin: as before
  for (const [config, search] of [[undefined, ''], [{}, ''], [{ appCdn: 'https://cdn.soul.game/assets/' }, ''], [{ appCdn: 'https://evil.example/assets/app/' }, ''], [{ appCdn: [CDN] }, ''], [{ appCdn: CDN }, '?appcdn=0'], [{ appCdn: CDN }, '?hour=12:00&appcdn=0']] as const) {
    const r = run(config, search);
    assert.deepEqual(r.added.map((a) => a.url), off, JSON.stringify([config, search]));
    assert.ok(r.added.every((a) => a.el.failed === undefined), 'no reload from the origin\'s own failures');
    assert.equal(r.window.Worker, r.Original, 'Worker is the browser\'s own');
  }
  // workers on a page whose code came from the CDN: a module worker asked for at the CDN's origin (the built code names
  // it by the site's path, resolved beside a CDN file) starts from a same-origin blob that imports it from the CDN folder
  const W = on.window.Worker as unknown as new (u: string | URL, o?: unknown) => object, Original = on.Original;
  assert.notEqual(W, Original); assert.equal((W as unknown as { prototype: unknown }).prototype, Original.prototype, 'instanceof still holds');
  const w = new W(new URL('/assets/worker-C1tn-FgR.js', `${CDN}early-layer-AAAAbbbb.js`), { type: 'module' });
  assert.ok(w instanceof Original);
  assert.deepEqual(Original.started.at(-1), ['blob:https://soul.game/1', { type: 'module' }]);
  assert.deepEqual(on.blobs, [`import ${JSON.stringify(`${CDN}worker-C1tn-FgR.js`)}`]);
  new W(`${CDN}history-worker-D7OBKG8k.js`, { type: 'module' });
  assert.equal(on.blobs[1], `import ${JSON.stringify(`${CDN}history-worker-D7OBKG8k.js`)}`, 'already in the CDN folder: the same file');
  // any other worker is started as asked: a library's blob worker, a same-origin file, a classic worker
  for (const [u, o] of [['blob:https://soul.game/abc', undefined], ['/assets/worker-C1tn-FgR.js', { type: 'module' }], ['https://soul.game/assets/worker-C1tn-FgR.js', { type: 'module' }], ['https://cdn.soul.game/assets/app/x.js', undefined]] as const) {
    new W(u, o);
    assert.deepEqual(Original.started.at(-1), [u, o]);
  }
  assert.equal(on.blobs.length, 2);
});

test('#4986 review: a hung CDN, a lazy chunk or style that fails, a worker that does not load: one reload from the origin, never a loop', () => {
  const js = /<script>(\(function\(\)\{var d=document[\s\S]*?)<\/script>/.exec(rewritePhasedHtml(HTML, 'assets/main-A.js', 'assets/early-E.js', ['assets/three-B.js']))![1];
  const CDN = 'https://cdn.soul.game/assets/app/', early = (r: ReturnType<typeof runCdn>) => r.added.find((a) => a.url.endsWith('early-E.js'))!.el;
  assert.ok(APP_CDN_HANG_MS >= 5_000 && APP_CDN_HANG_MS <= 10_000, 'a few seconds');
  // hung: nothing of the CDN has arrived by the limit
  const hung = runCdn(js, { appCdn: CDN });
  assert.equal(hung.after(APP_CDN_HANG_MS), 1);
  assert.deepEqual(hung.replaced, ['/w/eden/?appcdn=0#watch']);
  // slow, not hung: a file of the CDN has arrived (the rest still coming), or the early entry is in: no reload
  const slow = runCdn(js, { appCdn: CDN }); slow.arrived.push('https://soul.game/w/eden/v1/scene', `${CDN}three-B.js`); slow.after(APP_CDN_HANG_MS);
  assert.deepEqual(slow.replaced, []);
  const loaded = runCdn(js, { appCdn: CDN }); early(loaded).fire('load'); loaded.after(APP_CDN_HANG_MS);
  assert.deepEqual(loaded.replaced, [], 'the early entry is in');
  const origin = runCdn(js, { appCdn: CDN }); origin.arrived.push('https://soul.game/assets/three-B.js'); origin.after(APP_CDN_HANG_MS);
  assert.deepEqual(origin.replaced, ['/w/eden/?appcdn=0#watch'], 'only the CDN\'s own files count');
  // after the entry: a lazy chunk or style that fails (Vite's event) reloads once, however many fail
  const lazy = runCdn(js, { appCdn: CDN }); early(lazy).fire('load');
  lazy.window.fire('vite:preloadError'); lazy.window.fire('vite:preloadError');
  (lazy.added[2].el.failed as () => void)();
  assert.deepEqual(lazy.replaced, ['/w/eden/?appcdn=0#watch'], 'once');
  // a worker from the CDN that does not load reloads once; an error inside a running worker (it has a message) does not
  const wk = runCdn(js, { appCdn: CDN }), W = wk.window.Worker as unknown as new (u: string, o?: unknown) => object;
  new W(`${CDN}worker-C1tn-FgR.js`, { type: 'module' }); new W('/assets/plain.js');
  const [cdnWorker, plain] = wk.Original.made.slice(-2);
  assert.equal(plain.listens('error'), 0, 'a worker not from the CDN is left alone');
  cdnWorker.fire('error', { message: 'Uncaught TypeError: x is not a function' });
  assert.deepEqual(wk.replaced, []);
  cdnWorker.fire('error', { type: 'error' });
  assert.deepEqual(wk.replaced, ['/w/eden/?appcdn=0#watch']);
  // the blob it started from is freed once the worker has read it
  assert.equal(wk.after(60_000), 1); assert.deepEqual(wk.revoked, ['blob:https://soul.game/1']);
  // never a loop: after the reload (?appcdn=0) none of it is armed
  for (const search of ['?appcdn=0', '?hour=12:00&appcdn=0']) {
    const r = runCdn(js, { appCdn: CDN }, search);
    assert.equal(r.window.listens('vite:preloadError'), 0);
    assert.equal(r.after(APP_CDN_HANG_MS), 0, 'no hang timer');
    assert.equal(r.window.Worker, r.Original);
    assert.deepEqual(r.replaced, []);
  }
  // and a page whose config names no CDN: as before
  const none = runCdn(js, undefined); assert.equal(none.window.listens('vite:preloadError'), 0); assert.equal(none.after(APP_CDN_HANG_MS), 0);
});
