// The run gate's transport for Engine v2's form runner (#3314), beside the built-in `today` one:
//
//   node tools/entry/run.mjs <family> --transport tools/entry/v2.mjs [--repeats 2]
//
// It builds and starts tools/entry/v2/ (Rust, from v2/ so v2's toolchain applies, into v2/target): one body on open
// ground and the things the gate places, driven by the new engine's own code. An act is decided by R2's rules on the
// case's state with the things' fields as they stand, committed to the form runner (bound into steps, its effects
// bound, who may), and run tick by tick until it ends with a name; its effects are read back from the log. The
// disturbances are the forms' own: leave, a logged removal, and a restart that recovers the forms from the log alone.
// The world is stepped (it changes only when asked), so the gate never waits on it. `--world` is not needed.
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const V2 = join(ROOT, 'v2'), BIN = join(V2, 'target/release/entry-v2');

export default function v2Transport({build = true} = {}) {
  let child, lines, waiting = [];
  const ask = q => new Promise((ok, no) => {
    waiting.push({ok, no});
    child.stdin.write(JSON.stringify(q) + '\n');
  });
  const call = async q => { const a = await ask(q); if (a.error) throw new Error(`v2 ${q.op}: ${a.error}`); return a; };
  const t = {
    name: 'v2', stepped: true, timers: false, events: false, reads: [],
    async start(loaded) {
      if (build !== 'no') {
        const r = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', '../tools/entry/v2/Cargo.toml', '--target-dir', 'target'], {cwd: V2, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe']});
        if (r.status !== 0) throw new Error(`building tools/entry/v2 failed: ${r.stderr.split(ROOT).join('')}`);
      }
      if (!existsSync(BIN)) throw new Error('tools/entry/v2 is not built');
      child = spawn(BIN, [], {stdio: ['pipe', 'pipe', 'inherit']});
      lines = createInterface({input: child.stdout});
      lines.on('line', l => waiting.shift()?.ok(JSON.parse(l)));
      child.on('exit', code => { for (const w of waiting.splice(0)) w.no(new Error(`the v2 world ended (${code})`)); });
      const kinds = Object.fromEntries(loaded.filter(r => r.kind && r.entry?.forms).map(r => [r.kind, r.entry]));
      await call({op: 'define', kinds});
    },
    async stop() { child?.stdin.end(); },
    async place(kind) { return (await call({op: 'place', kind})).id; },
    async set(id, fields) { await call({op: 'set', id, fields}); },
    async remove(id) { await call({op: 'remove', id}); },
    async offers(id) { return (await call({op: 'offers', id})).forms; },
    async fields(id) { return (await call({op: 'fields', id})).fields; },
    async act(id, form, args, scene = {}) { return call({op: 'act', id, ...sceneOf(id, form, args, scene)}); },
    async begin(id, form, args, scene = {}) { return call({op: 'begin', id, ...sceneOf(id, form, args, scene)}); },
    async progress(rid) { return call({op: 'progress', rid}); },
    async wait(rid) { return call({op: 'wait', rid}); },
    async leave() { await call({op: 'leave'}); },
    async body() { return call({op: 'body'}); },
    async restart() { await call({op: 'restart'}); },
  };
  return t;
}

/** The case the world decides on: the gate's, or (with none) the thing alone and a body with free hands. */
function sceneOf(id, form, args, {case: c, ids}) {
  if (c) return {case: {act: c.act, state: c.state}, ids: ids ?? {}};
  return {case: {act: {this: 't', form, ...(args ? {args} : {})}, state: {actor: 'b', nodes: {t: {}, b: {hands: {left: null, right: null}}}}}, ids: {t: id}};
}
