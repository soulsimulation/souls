// #1952 diagnosis preload (logging only, not committed): every 100 ticks, for the walks the scorer counted frozen in cand-1,
// the walk record, its exec (phase, leg, climbT, cancelTo) and the programme's wait-bound/1 state.
const main = process.argv[1] ?? '';
if (main.endsWith('apps/server/src/main.ts')) {
  const { MarsEngine } = await import(`${process.cwd()}/packages/engine-mars/src/engine.ts`);
  const P = MarsEngine.prototype, st = P.step;
  const W = (process.env.PROBE_WINDOWS ?? '').split(',').filter(Boolean).map(s => { const [id, a, b] = s.split(':'); return { id, a: +a, b: +b }; });
  P.step = function (...a) {
    const r = st.apply(this, a), rt = this.rt, t = rt?.tick;
    if (t % 50 !== 0) return r;
    for (const w of W) {
      if (t < w.a || t > w.b) continue;
      const e = rt.world.entities[w.id]; if (!e) continue;
      const task = e.human?.task, rec = task ? rt.records.get(task) : undefined, x = task ? rt.services.walkExecs?.get(task) : undefined;
      const prog = [...this.programs.values()].find(p => p.actor === w.id);
      console.error('[probe]', JSON.stringify({ t, id: w.id, p: e.pose.p.map(v => +v.toFixed(3)), lvl: e.human?.level, act: e.human?.activity,
        rec: rec && { verb: rec.verb, st: rec.status, code: rec.diagnostic?.code, msg: rec.diagnostic?.message?.slice(0, 120) },
        ex: x && { phase: x.phase, leg: x.leg, legs: x.route.legs.map(l => l.kind + (l.link ? ':' + l.link.id : '')).join('>'), climbT: +(x.climbT ?? 0).toFixed(3), cancelTo: x.cancelTo },
        prog: prog && { label: prog.label, index: prog.index, action: prog.action, until: prog.until, wb: prog.waitBoundV1, walkStopping: prog.walkStopping?.code } }));
    }
    return r;
  };
}
