#!/usr/bin/env node
// Films of Souls building together on a real site, shot live: the owner (a Playwright Chromium profile signed in to the
// site) makes or re-opens a world from the Mars camp template, the creator pairs, six agent folders pair and join their
// Souls (Ada, Bo, Cy, Di, Ed, Fay), and the scenes run one after another, every step one Soul's own command. For each
// scene five live cameras on the camera host (cams.sh) record the yard from before the first step to after the last;
// then post.sh makes their mp4s and film.sh cuts the film from the run's step log (plan.mjs, cut.mjs, specs/).
//   node tools/playtest/films/films.mjs --dir <dir> --profile <profile> [--site https://soul.game] [--name "Mars Lab"]
//        [--scenes racks4,shade,loading,racks6] [--slug <world> --key <create key>] [--agents host] [--front-only]
//        [--tag <agents' prefix>] [--scene-tag <takes' prefix>] [--free-shade who:crew,...] [--staged6] [--no-creator]
//        [--generator-first] [--six-tall-only] [--no-cams] [--local]   (--local: the prod-like local stack, test owner)
// The camera host: FILM_SSH (default ssh) runs a command there, FILM_HOST its host argument when set; FILM_DIR (default
// souls-films, under its home) holds cam.mjs, cams.sh, post.sh and cut.mjs; FILM_NODE (default node, Node >= 22.18) runs
// the agents' clients there with --agents host. See README.md.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { browserOwner, creatorSeat, newWorld, soulSeat, testOwner } from '../rack-bay/staged.mjs';
import { AT, AT_LIVE, buildAndTakeDown, findIds, runner, stageLive } from '../rack-bay/rack-bay.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
if (!opt('dir') || (!argv.includes('--local') && !opt('profile'))) { console.error('usage: films.mjs --dir <dir> --profile <signed-in profile> [options]: see the header and README.md'); process.exit(2); }
const dir = resolve(opt('dir')), site = opt('site', 'https://soul.game'), scenes = opt('scenes', 'racks4,shade,loading,racks6').split(',');
mkdirSync(dir, { recursive: true });
const t00 = Date.now(), log = (s) => console.error(`films ${((Date.now() - t00) / 1000).toFixed(0)}s: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAT = process.env.FILM_SSH ?? 'ssh', HOST = process.env.FILM_HOST ? [process.env.FILM_HOST] : [];
const FDIR = process.env.FILM_DIR ?? 'souls-films', FNODE = process.env.FILM_NODE ?? 'node';
const sat = (cmd) => spawnSync(SAT, ['-o', 'BatchMode=yes', ...HOST, cmd], { encoding: 'utf8', timeout: 120_000 });
const out = { site, started: new Date(t00).toISOString(), scenes: {} };
const save = () => writeFileSync(join(dir, 'films.json'), JSON.stringify(out, null, 1));

/** The camera host's five cameras on a yard (stand → bay), recording once each has started. */
async function cameras(tag, world, [sx, sz], [bx, bz], seconds, orbitR = 13, bayC = [bx, bz], pz = 1) {
  if (argv.includes('--no-cams')) return false;
  // --cams-gate <file>: the camera host's GPU may be lent out (a release's eyes check); the cameras start once the file exists
  if (opt('cams-gate')) for (let i = 0; !existsSync(opt('cams-gate')); i++) { if (i % 30 === 0) log(`cameras ${tag}: waiting for ${opt('cams-gate')}`); await sleep(2000); }
  const r = sat(`cd ${FDIR} && ./cams.sh ${tag} '${world}' ${sx},${sz} ${bx},${bz} ${seconds} ${orbitR} ${bayC.join(',')} ${pz}`);
  log(`cameras ${tag}: ${r.stdout.trim().replace(/\n/g, ', ')} ${r.stderr.trim()}`);
  for (let i = 0; i < 60; i++) {
    const n = Number(sat(`ls ${FDIR}/${tag}/*.start 2>/dev/null | wc -l`).stdout.trim());
    if (n >= 5) { log(`cameras ${tag}: all recording`); return true; }
    await sleep(5000);
  }
  log(`cameras ${tag}: not all started in 5 min; going on`);
  return false;
}
const post = (tag) => { if (argv.includes('--no-cams')) return; const p = spawn(SAT, ['-o', 'BatchMode=yes', ...HOST, `cd ${FDIR} && ./post.sh ${tag} > ${tag}/post.log 2>&1`], { detached: true, stdio: 'ignore' }); p.unref(); };

/** One scene: cameras, a lead-in, the steps, a lead-out. */
async function scene(name, world, yard, seconds, steps) {
  const tag = `${opt('scene-tag', opt('tag', ''))}${name}`;   // the camera host's folder for the scene's takes (--scene-tag: a re-take beside the agents' --tag)
  const s = out.scenes[name] = { yard, tag };
  save();
  await cameras(tag, world, yard.from, yard.to, seconds, yard.orbitR, yard.bayC, yard.pz);
  await sleep(10_000);   // a lead-in: the yard before anyone moves
  const t0 = Date.now(), r = runner(seats, log, t0);
  s.play0Ms = t0; s.steps = r.lines;
  try { const v = await steps(r); s.ok = true; Object.assign(s, v ?? {}); }
  catch (e) {
    s.ok = false; s.failed = e.message; log(`${tag} stopped: ${e.message}`);
    // free everyone for the next scene: each Soul leaves the scene's last few crews (a refused leave is harmless)
    const crews = [...new Set((s.steps ?? []).filter((l) => l.crew).map((l) => l.crew))].slice(-4);
    for (const c of crews) await Promise.all(Object.values(seats).map((seat) => seat.cli('carry', 'leave', c).catch(() => null)));
    log(`${tag}: left crews ${crews.join(', ')}`);
  }
  s.playS = (Date.now() - t0) / 1000; save();
  await sleep(12_000);   // a lead-out
  post(tag);
  log(`${tag}: ${s.ok ? 'done' : 'FAILED'} in ${s.playS.toFixed(0)} s, ${r.lines.length} commands`);
}

// --agents host: each agent's folder and daemon on the camera host (FILM_NODE), commands over one shared ssh connection;
// the owner (the signed-in profile) stays here. Commands there answer in a second or two, not 5 to 8 s.
const CM = join(REPO_ROOT, '.local', 'cm');   // a unix socket's path must stay short
mkdirSync(CM, { recursive: true });
const SSH = ['-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', `ControlPath=${CM}/film`, '-o', 'ControlPersist=1800'];
const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
const sshExec = (cmd, ms = 180_000) => new Promise((ok) => {
  const p = spawn(SAT, [...SSH, ...HOST, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = ''; const kill = setTimeout(() => p.kill('SIGKILL'), ms);
  p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
  p.on('close', (code) => { clearTimeout(kill); ok({ out: o, err: e, code }); });
});
const jl = (text) => String(text).split('\n').flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === 'object' ? [j] : []; } catch { return []; } });
async function remoteSeat(world, label, owner, name) {
  const rdir = `${FDIR}/agents/${opt('tag', '')}${label}`, local = join(dir, 'agents', label), logf = join(local, 'commands.jsonl');
  mkdirSync(local, { recursive: true });
  await sshExec(`mkdir -p ${rdir} && cd ${rdir} && { [ -f eden.mjs ] || curl -fsSO ${q(new URL('eden.mjs', world).href)}; }`);
  const run = async (words, ms = 180_000) => {
    const t = Date.now(), { out: o, err } = await sshExec(`cd ${rdir} && SOULS_HOME=$PWD/.souls BRAIN_MODE=fake ${FNODE} eden.mjs ${words.map(q).join(' ')}`, ms);
    const lines = jl(o), answer = lines.at(-1) ?? { ok: false, raw: (o + err).slice(-400) };
    appendFileSync(logf, JSON.stringify({ at: t, ms: Date.now() - t, words, answer }) + '\n');
    return { answer, lines };
  };
  const cli = async (...w) => (await run(w)).answer;
  // a folder paired by an earlier run (the same --tag) keeps its Soul: the run resumes it instead of pairing again
  let soul = jl((await sshExec(`cat ${rdir}/.souls/pairing.log 2>/dev/null`)).out).find((j) => j.ok === true && typeof j.soul === 'string')?.soul ?? null;
  if (soul) log(`${label}: resumes ${soul}`);
  else {
  // a request that did not reach the directory (`failed`, fetch failed) is asked again, up to three times
  let lines = [];
  for (let i = 0; i < 3; i++) { lines = (await run(['pair', world])).lines; if (lines.some((j) => typeof j.code === 'string' && j.code && j.ok !== false) || lines.at(-1)?.code !== 'failed') break; log(`${label}: pair ${lines.at(-1)?.detail ?? 'failed'}, again`); await sleep(3000); }
  const asked = lines.find((j) => typeof j.code === 'string' && j.code && j.ok !== false);
  if (!asked) throw Error(`${label}: pair gave no code (${JSON.stringify(lines.at(-1) ?? {}).slice(0, 200)})`);
  const ap = await owner.post('/v1/pair/approve', { code: asked.code, confirm: true });
  if (ap.status !== 200) throw Error(`${label}: the owner's approval answered ${ap.status} ${ap.body.refused ?? ''}`);
  }
  for (const end = Date.now() + 120_000; !soul && Date.now() < end; await sleep(1000)) {
    const done = jl((await sshExec(`cat ${rdir}/.souls/pairing.log 2>/dev/null`)).out);
    soul = done.find((j) => j.ok === true && typeof j.soul === 'string')?.soul ?? null;
    const failed = done.find((j) => j.ok === false);
    if (failed) throw Error(`${label}: pairing failed ${failed.code ?? ''} ${failed.detail ?? ''}`);
  }
  if (!soul) throw Error(`${label}: pairing did not finish in 120 s after approval`);
  const named = await cli('profile', 'name', name);
  if (!named.ok) log(`${name}: profile name answered ${named.code ?? JSON.stringify(named).slice(0, 120)}`);
  const joined = await cli('act', 'life:join', '--wait');
  let body = null;
  for (let i = 0; i < 60 && !body; i++) { body = (await cli('status')).body ?? null; if (!body) await sleep(500); }
  if (!body) throw Error(`${name}: no body after joining (${JSON.stringify(joined).slice(0, 200)})`);
  return { folder: local, soul, body, cli, run, quit: () => cli('quit') };
}

/** buildTwoBays's last part alone (--six-tall-only, when an earlier take built bay 1): the 6.1 m frame by all six, Ada
 *  in front, Bo at the back, the others beside its grips between, carried to its place and set down. */
async function sixTall({ run, both }, bodies, tall, to) {
  const ends = ['ada', 'bo'], sides = ['cy', 'di', 'ed', 'fy'];
  await both(['ada', 'carry', 'grip', tall, 'front', '--from', '3.1'], ['bo', 'carry', 'grip', tall, 'back', '--from', '3.1'], ...sides.map((s, k) => [s, 'carry', 'grip', tall, 'side', String(k + 1)]));
  const { crew: c } = await run('ada', 'carry', 'offer', ...['bo', ...sides].map((x) => bodies[x]));
  for (const x of ['bo', ...sides]) await run(x, 'carry', 'accept', c);
  await run('ada', 'carry', 'lift', c, tall);
  const where = `${to[0]},${to[1]}`;
  await both(...[...ends, ...sides].map((s) => [s, 'carry', 'to', c, where]));
  await run('bo', 'carry', 'set-down', c);
  await both(...[...ends, ...sides].map((s) => [s, 'carry', 'leave', c]));
  return { tall: Date.now() };
}

/** loading-spot.mjs's haul with pallet 1 last: on soul.game's Mars camp (26 Nov) pallet 1's back grip could not be
 *  reached (its carrier's walk stopped 1.6 m short each time, carry-grip-out-of-reach), so the generator goes first (two
 *  refused, then four), then the bundle by six, pallet 2 by two, and pallet 1 is tried last. */
async function haulGeneratorFirst(ls, r, bodies) {
  const out = {};
  await r.both(['cy', 'carry', 'grip', 'generator', 'front'], ['di', 'carry', 'grip', 'generator', 'back']);
  const { crew: two } = await r.run('cy', 'carry', 'offer', bodies.di);
  await r.run('di', 'carry', 'accept', two);
  const small = await seats.cy.cli('carry', 'lift', two, 'generator');
  r.lines.push({ at: null, who: 'cy', words: ['carry', 'lift', two, 'generator'], ok: !!small.ok, code: small.code ?? null, detail: small.detail ?? null, expected: 'carry-crew-too-small' });
  log(`cy: carry lift ${two} generator -> ${small.ok ? 'ok (expected a refusal)' : `REFUSED ${small.code} ${small.detail ?? ''}`}`);
  if (small.ok) throw Error('two lifted the generator');
  await r.both(['cy', 'carry', 'leave', two], ['di', 'carry', 'leave', two]);
  out.generator = await ls.carryToSpot(r, bodies, 'generator', ['cy', 'di', ['ed', 'right', 1], ['fay', 'right', 2]]);
  out['timber-bundle'] = await ls.carryToSpot(r, bodies, 'timber-bundle', ['ada', 'bo', ['cy', 'right', 1], ['di', 'left', 2], ['ed', 'right', 3], ['fay', 'left', 4]]);
  out['pallet-crates-2'] = await ls.carryToSpot(r, bodies, 'pallet-crates-2', ['ed', 'fay']);
  // pallet 1 last, and only tried: a refusal is recorded and its crew let go
  try { out['pallet-crates-1'] = await ls.carryToSpot(r, bodies, 'pallet-crates-1', ['ada', 'bo']); }
  catch (e) { out['pallet-crates-1'] = { refused: e.message }; for (const c of [...new Set(r.lines.filter((l) => l.crew).map((l) => l.crew))].slice(-1)) await Promise.all(['ada', 'bo'].map((w) => seats[w].cli('carry', 'leave', c))); }
  return out;
}

const seats = {}, fronts = new Map(), lastGrip = new Map();
let owner = null, god = null, stack = null, tunnel = null, localGod = null;
try {
  if (argv.includes('--local')) {
    const { startOldPage } = await import('../arena/new-engine/old-page.mjs');
    // the template's world with its facts exported with the Mars map (every yard in its construction kinds), as
    // rack-bay.mjs and shade.mjs run locally; the creator is the seeded test person Ada (rack-bay's pairCreator)
    const rb = await import('../rack-bay/rack-bay.mjs');
    stack = await startOldPage({ template: rb.TEMPLATE, dir: join(dir, 'stack'), facts: rb.templateFacts({ template: rb.TEMPLATE, out: dir }), history: false, log });
    localGod = () => rb.pairCreator({ world: stack.world, worldDir: join(dir, 'stack', 'world'), dir });
    owner = testOwner(stack.base);
    if (!argv.includes('--no-cams')) {
      // the camera host's cameras reach this stack through a tunnel on the same port (the page names its own address)
      const port = new URL(stack.base).port, t = spawn(SAT, ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-R', `${port}:localhost:${port}`, ...HOST], { stdio: 'ignore' });
      tunnel = t; log(`tunnel ${port} to the camera host`);
    }
  } else owner = await browserOwner(site, resolve(opt('profile')), log);
  if (stack) { out.world = stack.page; save(); log(`world ${out.world}`); god = await localGod(); }
  else {
    const c0 = Date.now();
    // --slug: a world already made (its create finished after an earlier run gave up)
    // the create's key and slug are logged with every answer (a re-ask needs both); --key with --slug resumes one
    const ownerLogged = { ...owner, post: async (path, body) => { const a = await owner.post(path, body); if (path === '/__sim/worlds') { log(`create answered ${a.status} ${a.body.code ?? ''} key ${a.body.key ?? body.key ?? '-'} slug ${a.body.slug ?? body.slug ?? '-'}`); out.create = { key: a.body.key ?? body.key ?? out.create?.key, slug: a.body.slug ?? body.slug ?? out.create?.slug }; save(); } return a; } };
    if (opt('key') && opt('slug')) {
      // a re-ask of a create already made: the same key and slug, until it answers 201
      let ask = { name: opt('name', 'Mars Lab'), template: 'mars-camp', key: opt('key'), slug: opt('slug') };
      for (const end = Date.now() + 600_000; ;) {
        const { status, body } = await ownerLogged.post('/__sim/worlds', ask);
        if (status === 201 && body.slug) { out.slug = body.slug; break; }
        if (!((status === 202 || status === 503) && body.key)) throw Error(`re-ask refused ${status} ${body.code ?? ''}: ${body.message ?? JSON.stringify(body).slice(0, 200)}`);
        if (Date.now() > end) throw Error(`the world ${ask.slug} did not start in 600 s`);
        await sleep(Math.max(1, body.retry_after ?? 2) * 1000);
      }
    } else out.slug = await newWorld(ownerLogged, { name: opt('name', 'Mars Lab'), log });
    out.createS = (Date.now() - c0) / 1000; log(`New world answered with ${out.slug} in ${out.createS.toFixed(1)} s`);
    out.world = `${site.replace(/\/$/, '')}/w/${out.slug}/`; save();
    log(`world ${out.world}`);
    // the directory's switch (its creator's), else the launcher's (the world's owner), as staged.mjs unlists
    const u = await owner.post('/v1/worlds/settings', { world: out.slug, unlisted: true });
    const v = u.status === 200 ? u : await owner.post(`/__sim/worlds/${out.slug}/unlisted`, { unlisted: true });
    out.unlisted = v.status === 200; save();
    log(out.unlisted ? 'unlisted' : `unlisting answered ${u.status} ${u.body.refused ?? ''} and ${v.status} ${v.body.code ?? ''}: the world stays listed`);
    // the world's page live: its inline config names the stream
    for (const t1 = Date.now(); Date.now() - t1 < 300_000; await sleep(2000)) {
      const html = await fetch(out.world, { headers: { accept: 'text/html' } }).then((r) => r.text(), () => '');
      if (/"v2Stream"/.test(html)) { out.liveS = (Date.now() - c0) / 1000; log(`page live at ${out.liveS.toFixed(1)} s`); break; }
    }
    save();
    // the creator is needed only to place the six's yard: a refused creator pairing is reported and the rest goes on
    if (!argv.includes('--no-creator')) {
      // a served client older than #5061 (soul.game served 0.142.0 on 26 Nov) sends a creator's request without its
      // world and the owner's approval is refused 409 world-required: the creator's copy gets #5061's one change
      const cfile = join(dir, 'creator', 'eden.mjs');
      if (!existsSync(cfile)) {
        mkdirSync(join(dir, 'creator'), { recursive: true });
        const src = await fetch(new URL('eden.mjs', out.world)).then((r) => r.text());
        const old = "device, label, force, ...(creator ? { scope: 'creator', soul: creator } : { scope: 'soul', world, ";
        const fixed = src.includes(old) ? src.replace(old, "device, label, force, world, ...(creator ? { scope: 'creator', soul: creator } : { scope: 'soul', ") : src;
        if (fixed !== src) log('creator: the served client lacks #5061 (a creator\'s request names its world); its copy is patched');
        writeFileSync(cfile, fixed);
      }
      try { god = await creatorSeat(out.world, join(dir, 'creator'), owner); log(`creator paired at ${((Date.now() - c0) / 1000).toFixed(1)} s`); }
      catch (e) { out.creatorFailed = e.message; log(`creator pairing failed: ${e.message}`); god = null; }
    }
  }
  const kinds = god ? ((await god('describe')).nodes ?? []).map((n) => n.kind) : [];
  out.kinds = [...new Set(kinds.filter((k) => /^mars:/.test(k)))]; save();
  log(`the world's construction kinds: ${out.kinds.join(', ') || 'none'}`);
  for (const l of ['ada', 'bo', 'cy', 'di', 'ed', 'fay']) {
    seats[l] = opt('agents') === 'host' ? await remoteSeat(out.world, l, owner, l[0].toUpperCase() + l.slice(1)) : await soulSeat(out.world, join(dir, 'agents', l), owner, l[0].toUpperCase() + l.slice(1), log);
    // a daemon too busy to answer (a loaded laptop) is asked again, up to three times
    const raw = seats[l].cli;
    seats[l].cli = async (...w) => {
      // --front-only (#5005: the crew walks with its front): only the crew's front sends `carry to`
      if (argv.includes('--front-only') && w[0] === 'carry' && w[1] === 'to' && fronts.has(w[2]) && fronts.get(w[2]) !== l) return { ok: true, skipped: 'front-only' };
      // a lift or take asked while a carrier is still walking to its grip (agents here answer in a second or two) is
      // asked again once they have had time to get there, as an agent waits and asks again
      // a carrier whose walk to its grip stopped short (another body in the way) is sent to its grip again, as its agent
      // would: the one the refusal names, or every carrier of that load when it names none
      if ((w[0] === 'carry' && w[1] === 'lift') || (w[0] === 'part' && w[1] === 'take')) {
        let a; for (let i = 0; i < 10; i++) {
          a = await raw(...w); if (!/out-of-reach/.test(a.code ?? '')) break;
          log(`${l}: ${w.slice(0, 2).join(' ')} ${a.code} (${(a.detail ?? '').slice(0, 90)}), again in 3 s`);
          if (i % 3 === 1) {
            const load = w[3], named = Object.keys(seats).filter((k) => (a.detail ?? '').includes(seats[k].body));
            const who = (named.length ? named : Object.keys(seats)).filter((k) => lastGrip.get(k)?.[2] === load);
            for (const k of who) { log(`${k}: to its grip again (${lastGrip.get(k).join(' ')})`); await seats[k].cli(...lastGrip.get(k)); }
          }
          await sleep(3000);
        }
        return a;
      }
      if (w[0] === 'carry' && w[1] === 'grip') lastGrip.set(l, w);
      let a; for (let i = 0; i < 4; i++) { a = await raw(...w); if (a.code !== 'daemon-not-answering' && !(a.ok === false && a.raw)) { if (w[0] === 'carry' && w[1] === 'offer' && a.crew) fronts.set(a.crew, l); return a; } log(`${l}: ${w.slice(0, 2).join(' ')} ${a.code ?? 'no answer'}, again`); await sleep(4000); } return a; };
    log(`${l}: body ${seats[l].body}`);
  }
  const bodies = Object.fromEntries(Object.entries(seats).map(([l, s]) => [l, s.body]));
  out.bodies = bodies; save();

  // --free-shade <who>:<hold crew>,...: Souls left holding the shade's bents up (a take-down stopped short: a bent
  // braced by nothing cannot be let go, support.none) are freed the way shade.mjs's takeDown ends: Bo and Di take
  // each bent from its holder and carry it to where it lay
  if (opt('free-shade')) {
    const sh = await import('../shade/shade.mjs'), ids = await sh.findIds(seats.ada), r = runner(seats, log, Date.now());
    for (const [who, hold] of opt('free-shade').split(',').map((x) => x.split(':'))) {
      const k = who === 'ada' ? 1 : 0, bent = ids.bents[k], xz = sh.AT.bents[k].join(',');
      await r.both(['bo', 'carry', 'grip', bent, 'back'], ['di', 'carry', 'grip', bent, 'front']);
      const { crew } = await r.run('bo', 'carry', 'offer', bodies.di, '--on', bent); await r.run('di', 'carry', 'accept', crew);
      await r.run(who, 'carry', 'leave', hold);
      await r.run('bo', 'part', 'unseat', crew, bent);
      await r.both(['bo', 'carry', 'to', crew, xz], ['di', 'carry', 'to', crew, xz]);
      await r.run('bo', 'part', 'put', crew, xz);
      await r.both(['bo', 'carry', 'leave', crew], ['di', 'carry', 'leave', crew]);
      log(`free-shade: ${who} let go of bent ${k + 1}; it lies at ${xz}`);
    }
  }

  if (scenes.includes('racks4')) {
    // the template's own yard when Ada's copy finds it in the construction kinds, else one the creator places live
    let at = AT, ids = await findIds(seats.ada).catch(() => null);
    if (!ids && !god) log('racks4: no template yard and no creator to place one');
    else if (!ids) { at = AT_LIVE; const st = await stageLive(god, log, at); if (!st.ok) throw Error(`staging refused: ${JSON.stringify(st.failed).slice(0, 300)}`); ids = await findIds(seats.ada); }
    out.racks4Yard = !ids ? 'none' : at === AT ? 'template' : 'live'; log(`racks4 yard: ${out.racks4Yard}`);
    // the template's yard has the shade and the loading row east of it: the front and pass cameras stand farther south
    if (ids) await scene('racks4', out.world, { from: at.stand, to: at.bay, at, pz: at === AT ? 1.35 : 1 }, 1500, (r) => buildAndTakeDown(r, bodies, ids, at.beams.map((b) => b.join(','))).then((v) => ({ builtAtS: (v.built - out.scenes.racks4.play0Ms) / 1000 })));
  }
  if (scenes.includes('shade')) {
    const sh = await import('../shade/shade.mjs').catch((e) => { log(`shade: ${e.message}`); return null; });
    const ids = sh ? await sh.findIds(seats.ada).catch((e) => { log(`shade: no yard (${e.message})`); return null; }) : null;
    if (ids) {
      // shade.mjs names its fifth Soul Eve
      const seatsE = { ...seats, eve: seats.ed }, bodiesE = { ...bodies, eve: bodies.ed };
      // four build it and take it down, then six (the yard back where it was between them), as shade.mjs --crew 4,6
      await scene('shade', out.world, { from: [9, 15], to: [19, 15], at: sh.AT, orbitR: 10, bayC: sh.AT.site, pz: 0.8 }, 3000, async () => {
        const sc = out.scenes.shade, r2 = runner(seatsE, log, sc.play0Ms), at = () => (Date.now() - sc.play0Ms) / 1000;
        sc.steps = r2.lines; sc.marks = {};
        // four raise the bents and seat the rails (buildFour's steps), then all six lift the cloth onto the rails (the
        // crew of six's part of buildSix: its two crews at once were refused carry-blocked in rehearsal), then four take
        // it down as far as the world lets them (a blocked take-down is cut from the film, the build kept)
        const A = sh.AT, xz = (p) => p.join(',');
        const crewOf = async (a, others, on = null) => { const { crew } = await r2.run(a, 'carry', 'offer', ...others.map((o) => bodiesE[o]), ...(on ? ['--on', on] : [])); for (const o of others) await r2.run(o, 'carry', 'accept', crew); return crew; };
        const raise = async (bent, slot, a, b) => { await r2.both([a, 'carry', 'grip', bent, 'back'], [b, 'carry', 'grip', bent, 'front']); const c = await crewOf(a, [b]); await r2.run(a, 'part', 'take', c, bent); await r2.both([a, 'carry', 'to', c, ids.site, slot], [b, 'carry', 'to', c, ids.site, slot]); await r2.run(a, 'part', 'put', c, ids.site, slot); await r2.run(a, 'carry', 'leave', c); return c; };
        const rail = async (rl, slot, stop, a, b, c = null) => { await r2.both([a, 'carry', 'grip', rl, 'back'], [b, 'carry', 'grip', rl, 'front']); c ??= await crewOf(a, [b]); await r2.run(a, 'part', 'take', c, rl); await r2.both([a, 'carry', 'to', c, xz(stop)], [b, 'carry', 'to', c, xz(stop)]); await r2.run(a, 'part', 'put', c, ids.site, slot); return c; };
        sc.marks.start4 = at(); log('shade: four raise the frame');
        const holdA = await raise(ids.bents[0], 'bent_a', 'ada', 'bo');
        const holdB = await raise(ids.bents[1], 'bent_b', 'ada', 'cy');
        const rc = await rail(ids.rails[0], 'rail_l', A.railIn[0], 'ada', 'di');
        await rail(ids.rails[1], 'rail_r', A.railIn[1], 'ada', 'di', rc);
        await r2.run('bo', 'carry', 'leave', holdA); await r2.run('cy', 'carry', 'leave', holdB);
        await r2.both(['ada', 'carry', 'leave', rc], ['di', 'carry', 'leave', rc]);
        sc.marks.frame4 = at(); save(); log('shade: six lift the cloth');
        const who = ['ada', 'bo', 'cy', 'di', 'eve', 'fay'], [a, b, ...sides] = who;
        await Promise.all([r2.run(a, 'carry', 'grip', ids.cloth, 'back'), r2.run(b, 'carry', 'grip', ids.cloth, 'front'), ...sides.map((x, k) => r2.run(x, 'carry', 'grip', ids.cloth, k % 2 ? 'left' : 'right', '--from', '1.3'))]);
        const cc = await crewOf(a, [b, ...sides]);
        sc.marks.cloth6 = at();
        await r2.run(a, 'part', 'take', cc, ids.cloth);
        for (const leg of A.clothIn) await r2.both(...who.map((x) => [x, 'carry', 'to', cc, xz(leg)]));
        await r2.run(a, 'part', 'put', cc, ids.site, 'cloth');
        await r2.both(...who.map((x) => [x, 'carry', 'leave', cc]));
        sc.marks.built = at(); sc.builtAtS = sc.marks.built; save();
        await sh.takeDown(r2, bodiesE, ids); sc.marks.down = at(); save();
      });
    }
  }
  if (scenes.includes('loading')) {
    const ls = await import('../loading-spot/loading-spot.mjs').catch(() => null);
    const loads = ls ? ((await seats.ada.cli('query', JSON.stringify([{ find: 'generator' }]))).answers ?? []).flatMap((a) => a.found ?? []) : [];
    if (ls && !loads.length) log('loading: this world has no generator to haul');
    else if (ls) await scene('loading', out.world, { from: [11.6, 24], to: ls.AT.spot }, 1200, (r) => argv.includes('--generator-first') ? haulGeneratorFirst(ls, r, bodies) : ls.haul(r, bodies, seats, log));
    else log('loading: no loading-spot.mjs in this checkout');
  }
  if (scenes.includes('racks6') && !god && !argv.includes('--staged6')) log('racks6: no creator to place the six\'s yard');
  else if (scenes.includes('racks6')) {
    const m = await import(opt('rack6-module') ? pathToFileURL(resolve(opt('rack6-module'))).href : '../rack-bay/rack-bay.mjs').catch((e) => { log(`racks6: ${e.message}`); return {}; });
    if (!m.buildTwoBays) log('racks6: this rack-bay.mjs has no buildTwoBays');
    else {
      // the six's yard west of the four's, its things titled apart ("six …") so no name is shared with the four's yard
      const dx = Number(opt('six-dx', -20)), sh = ([x, z]) => [x + dx, z];
      const at6 = { stands: m.AT6.stands.map(sh), beams: m.AT6.beams.map(sh), bays: m.AT6.bays.map(sh), tall: { at: sh(m.AT6.tall.at), to: sh(m.AT6.tall.to) } };
      const batch = (ground, at) => m.stageBatch6(ground, at).map((op) => ({ ...op, title: op.title.replace(/^rack /, 'six ').replace(/^frame stand/, 'six stand').replace(/^tall frame/, 'six tall frame') }));
      // a yard an earlier run staged (the same world) is used again, never staged twice
      const had = ((await seats.ada.cli('query', JSON.stringify([{ find: 'six bay' }]))).answers ?? []).flatMap((x) => x.found ?? []).some((f) => f.name === 'six bay 1');
      const st = had ? (log('racks6: the six\'s yard is already staged'), { ok: true }) : await stageLive(god, log, at6, batch);
      if (!st.ok) log(`racks6 staging refused: ${JSON.stringify(st.failed).slice(0, 300)}`);
      else {
        const a = await seats.ada.cli('query', JSON.stringify([{ find: 'six frame' }, { find: 'six beam' }, { find: 'six bay' }, { find: 'six tall' }, { find: 'six stand' }]));
        const found = (a.answers ?? []).flatMap((x) => x.found ?? []), named = (w) => { const f = found.find((x) => x.name === w); if (!f) throw Error(`no "${w}"`); return f.id; };
        const ids = { bays: [1, 2].map((k) => ({ bay: named(`six bay ${k}`), fa: named(`six frame ${2 * k - 1}`), fb: named(`six frame ${2 * k}`), beams: [1, 2, 3, 4].map((b) => named(`six beam ${4 * (k - 1) + b}`)) })), tall: named('six tall frame'), stands: [1, 2].map((k) => named(`six stand ${k}`)) };
        const six = Object.fromEntries(Object.entries(bodies).map(([l, b]) => [l === 'fay' ? 'fy' : l, b]));
        const seatsFy = { ...seats, fy: seats.fay };
        await scene('racks6', out.world, { from: [at6.stands[0][0], (at6.stands[0][1] + at6.tall.at[1]) / 2], to: [at6.bays[0][0] + 2, (at6.stands[0][1] + at6.tall.at[1]) / 2], at: at6 }, 2400, (r) => {
          const r6 = runner(seatsFy, log, out.scenes.racks6.play0Ms); out.scenes.racks6.steps = r6.lines;
          if (argv.includes('--six-tall-only')) return sixTall(r6, six, ids.tall, at6.tall.to);
          return m.buildTwoBays(r6, six, { ...ids, bays: ids.bays.slice(0, Number(opt('six-bays', 1))) }, at6.tall.to);   // bay 1, then all six carry the tall frame (bay 2 stops at its third beam: a known gap)
        });
      }
    }
  }
} catch (e) { out.failed = e.message; log(`stopped: ${e.stack ?? e.message}`); }
finally {
  save();
  for (const s of Object.values(seats)) await s.quit().catch(() => null);
  await god?.quit().catch(() => null);
  await owner?.close().catch(() => null);
  if (stack && !argv.includes('--keep')) await stack.stop();
  tunnel?.kill();
  log('end');
}
