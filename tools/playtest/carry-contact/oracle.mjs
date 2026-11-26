// Production observations only; this self-contained factory also installs through Playwright.evaluate.
export function contactTools(config) {
// Final-draw observations only. Native assignments are required to certify contact; any-grip distances prove misses.
const CONTACT_LIMIT_M = 0.03;
const finite3 = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const fail = reason => { throw new Error(`carry-contact: ${reason}`); };
const opaque = material => (Array.isArray(material) ? material : [material]).some(m => m?.visible && m.opacity > 0);
const visible = object => { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; };
const attached = (object, scene) => { for (let o = object; o; o = o.parent) if (o === scene) return true; return false; };
const validMatrix = m => m && m.elements?.length === 16 && m.elements.every(Number.isFinite) && Math.abs(m.determinant()) > 1e-12;

/** Read the transform actually submitted for this entity, including instancing's geometry-local offsets. */
function drawnLoad(layer, scene, entity) {
  const d = layer.drawn?.get(entity);
  if (!d || d.removing) fail('load missing or removing');
  if (!d.inst) {
    if (!attached(d.obj, scene) || !visible(d.obj) || !validMatrix(d.obj.matrixWorld)) fail('load root is not visibly attached');
    let meshes = 0;
    d.obj.traverse(o => { if (o.isMesh && visible(o) && o.material && opaque(o.material)) meshes++; });
    if (!meshes) fail('load has no visible meshes');
    return { matrix: d.obj.matrixWorld.clone(), source: 'visible-root', parts: meshes, entity };
  }
  if (d.shown === false) fail('load instance hidden');
  const pool = layer.instancer?.pools?.get(d.inst), slot = pool?.slots?.get(entity);
  if (!pool || !Number.isInteger(slot) || slot < 0 || !pool.parts.length || pool.parts.length !== pool.meshes.length) fail('instance entity/slot unavailable');
  let matrix;
  const matrices = [];
  for (let i = 0; i < pool.parts.length; i++) {
    const mesh = pool.meshes[i], local = pool.parts[i].local;
    if (!mesh?.isInstancedMesh || slot >= mesh.count || !attached(mesh, scene) || !visible(mesh) || !validMatrix(local) || !validMatrix(mesh.matrixWorld)) fail('instance part unavailable');
    if (!opaque(mesh.material)) fail('instance part material hidden');
    const instance = mesh.matrixWorld.clone();
    mesh.getMatrixAt(slot, instance);
    if (!validMatrix(instance)) fail('instance transform unavailable');
    const root = mesh.matrixWorld.clone().multiply(instance).multiply(local.clone().invert());
    if (!validMatrix(root)) fail('recovered root unavailable');
    if (matrix && Math.max(...matrix.elements.map((n, k) => Math.abs(n - root.elements[k]))) > 1e-7) fail('instance parts disagree');
    matrix ??= root;
    matrices.push({ mesh: mesh.uuid, slot, matrixWorld: mesh.matrixWorld.toArray(), instance: instance.toArray(), local: local.toArray() });
  }
  return { matrix, source: 'actual-instance', parts: matrices.length, matrices, entity };
}

/** Declared entry points use whole millimetres; the page's actual draw transform uses metres. */
function drawnGrips(entry, matrix, makeVector) {
  if (entry?.format !== 'souls-entry/1' || !validMatrix(matrix)) fail('entry or load matrix unavailable');
  const grips = Object.entries(entry.points ?? {}).filter(([, p]) => p?.role === 'grip').map(([name, p]) => {
    if (!finite3(p.at_mm) || !p.at_mm.every(Number.isSafeInteger)) fail('grip is not declared in whole millimetres');
    const local = p.at_mm.map(n => n / 1000), world = makeVector(...local).applyMatrix4(matrix).toArray();
    if (!finite3(world)) fail('grip world point unavailable');
    return { name, at_mm: [...p.at_mm], world };
  });
  if (!grips.length) fail('entry has no declared grips');
  return grips;
}

/** Render wrapper: never changes invocation count, this, arguments, return value, or the draw's pose/order. */
function observeRender(renderer, world, sample, onError) {
  const original = renderer.render;
  function wrapped(...args) {
    const before = { canvas: renderer.domElement, target: renderer.getRenderTarget(), scene: args[0], camera: args[1] };
    const result = original.apply(this, args);
    if (before.scene === world.scene && before.camera === world.camera && before.target === null && renderer.getRenderTarget() === null) {
      try {
        if (world.renderer !== renderer || renderer.domElement !== before.canvas || !before.canvas.isConnected) fail('canvas changed');
        sample({ frame: renderer.info.render.frame, canvas: before.canvas });
      } catch (error) { onError(error); }
    }
    return result;
  }
  renderer.render = wrapped;
  return () => { if (renderer.render === wrapped) renderer.render = original; else fail('render observer ownership changed'); };
}

/** Reject stale or non-final data before distance grading. Unknown assignment never becomes a pass. */
function gradeContact(sample, { now, previousFrame = -1, maxAgeMs = 250, limitM = CONTACT_LIMIT_M } = {}) {
  const invalid = reason => ({ status: 'failed-measurement', ok: false, reason, contacts: [] });
  if (!sample || sample.stage !== 'after-world-render' || sample.units !== 'm' || !sample.currentCanvas || sample.renderTarget !== null) return invalid('not an actual final world draw in metres');
  if (![sample.frame, sample.at, sample.worldSeconds, now].every(Number.isFinite) || sample.frame <= previousFrame || now < sample.at || now - sample.at > maxAgeMs) return invalid('stale or missing draw');
  if (!sample.load?.native || !sample.load?.entity || !sample.load?.entrySha256 || !sample.load?.kind || !sample.load?.parts || !sample.grips?.length || !sample.bodies?.length || !Number.isFinite(limitM) || limitM <= 0 || limitM > CONTACT_LIMIT_M) return invalid('missing identity, geometry or threshold');
  if (new Set(sample.grips.map(g => g.name)).size !== sample.grips.length || sample.grips.some(g => !g.name || !finite3(g.world))) return invalid('invalid declared grip points');
  const contacts = [];
  for (const body of sample.bodies) {
    if (!body.native || !body.entity || !body.soul || !body.visibleSkin || !finite3(body.palms?.left) || !finite3(body.palms?.right)) return invalid('missing carrier or live palms');
    for (const hand of ['left', 'right']) {
      const choices = sample.grips.map(g => ({ grip: g.name, errorM: distance(body.palms[hand], g.world) }));
      const nearest = choices.reduce((a, b) => a.errorM <= b.errorM ? a : b);
      contacts.push({ body: body.native, entity: body.entity, hand, palm: body.palms[hand], nearest, interpretation: 'any-grip lower bound; no assigned-contact certification' });
    }
  }
  if (new Set(sample.bodies.map(b => b.native)).size !== sample.bodies.length || new Set(sample.bodies.map(b => b.entity)).size !== sample.bodies.length) return invalid('ambiguous carrier identity');
  const assignments = sample.assignments;
  if (!Array.isArray(assignments) || !assignments.length) {
    const missed = sample.bodies.filter(b => contacts.filter(c => c.body === b.native).every(c => c.nearest.errorM > limitM));
    return { status: missed.length ? 'failed-lower-bound' : 'unproved', ok: false, reason: missed.length ? 'both palms of a carrier miss every declared grip' : 'native hand/grip assignment unavailable', limitM, missed: missed.map(b => b.native), contacts };
  }
  // A native assignment must name each required contact explicitly; tool callers cannot infer it from nearest grip.
  if (sample.assignmentSource !== 'native-authoritative' || sample.assignmentAt !== sample.worldSeconds) return invalid('assignment provenance/time unavailable');
  const assigned = [], seen = new Set();
  for (const a of assignments) {
    const c = contacts.find(c => c.body === a.body && c.hand === a.hand), grip = sample.grips.find(g => g.name === a.grip), key = `${a.body}:${a.hand}`;
    if (!c || !grip || seen.has(key)) return invalid('invalid native assignment');
    seen.add(key);assigned.push({ ...c, assignedGrip: grip.name, errorM: distance(c.palm, grip.world) });
  }
  if (sample.bodies.some(b => ['left', 'right'].some(hand => !seen.has(`${b.native}:${hand}`)))) return invalid('required hand assignment missing');
  const failed = assigned.some(c => c.errorM > limitM);
  return { status: failed ? 'failed-assigned' : 'passed-assigned', ok: !failed, limitM, contacts: assigned };
}


  function retainResult(observer, sample, result, cap = 100) {
    observer.total++;
    const stamp = { frame: sample.frame, worldSeconds: sample.worldSeconds, at: sample.at };
    observer.interval ??= { first: stamp, last: stamp };
    observer.interval.last = stamp;
    observer.counts[result.status] = (observer.counts[result.status] ?? 0) + 1;
    for (const c of result.contacts) {
      const key = `${c.body}:${c.hand}`, value = c.errorM ?? c.nearest.errorM;
      if (!observer.maxima[key] || value > observer.maxima[key].distanceM) observer.maxima[key] = { distanceM: value, frame: sample.frame, worldSeconds: sample.worldSeconds };
    }
    if (observer.samples.length < cap) observer.samples.push({ sample, result });
    else { observer.samples.splice(Math.floor(cap / 2), 1); observer.samples.push({ sample, result }); observer.dropped++; }
    if (result.status.startsWith('failed') && observer.failedWitnesses.length < 8) observer.failedWitnesses.push({ sample, result });
  }
  function bodyGeometry(root, scene) {
    if (!root || !attached(root, scene) || !visible(root) || !validMatrix(root.matrixWorld)) fail('carrier root is not visibly nondegenerate');
    let skins = 0;
    root.traverse(m => { if (m.isSkinnedMesh && m.userData.bodyDraw && visible(m) && validMatrix(m.matrixWorld) && m.geometry.index?.count > 0 && opaque(m.material)) skins++; });
    if (!skins) fail('actual visible indexed body skin unavailable');
    return skins;
  }
  const tools = { CONTACT_LIMIT_M, drawnLoad, drawnGrips, observeRender, gradeContact, retainResult, bodyGeometry };
  if (!config) return tools;
  return (async () => {
    const world = window.__soulsEntity;
    if (!world?.scene || !world?.camera || !world?.renderer || window.__carryContactObserver) fail('world unavailable or observer already installed');
    const kit = await import(config.kitURL), prototype = kit.TakePeople?.prototype;
    if (!prototype?.show || !prototype?.palmOf || !prototype?.bodyObject) fail('production people interface unavailable');
    let people;
    const originalShow = prototype.show;
    function show(...args) { const result = originalShow.apply(this, args); people = this; return result; }
    prototype.show = show;
    const observer = window.__carryContactObserver = { active: false, samples: [], failures: [], dropped: 0, source: config.source, previousFrame: -1, total: 0, counts: {}, maxima: {}, failedWitnesses: [] };
    const stopRender = observeRender(world.renderer, world, stamp => {
      const now = performance.now();
      if (!observer.active) return;
      if (!people) fail('production people instance not observed');
      const load = drawnLoad(world.layer, world.scene, config.binding.load.entity);
      const vector = (...p) => world.camera.position.clone().set(...p);
      const grips = drawnGrips(config.entry, load.matrix, vector);
      const frame = world.gameFrame();
      const bodies = config.binding.bodies.map(binding => {
        const matches = frame.souls.filter(s => s.id === binding.soul && s.entityId === binding.entity);
        if (matches.length !== 1) fail('carrier Soul/entity mapping changed');
        const root = people.bodyObject(binding.entity);
        const visibleSkin = bodyGeometry(root, world.scene);
        const palms = {};
        for (const hand of ['left', 'right']) {
          const out = vector(0, 0, 0);
          if (!people.palmOf(binding.entity, hand, out)) fail('live palm unavailable');
          palms[hand] = out.toArray();
        }
        return { ...binding, visibleSkin, palms, root: root.matrixWorld.toArray() };
      });
      const sample = { stage: 'after-world-render', units: 'm', currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected,
        renderTarget: world.renderer.getRenderTarget(), frame: stamp.frame, at: now, tick: frame.tick, worldSeconds: world.worldSeconds,
        load: { ...config.binding.load, parts: load.parts, matrix: load.matrix.toArray(), source: load.source, matrices: load.matrices ?? null }, bodies, grips,
        assignments: null, assignmentSource: 'unavailable' };
      const result = gradeContact(sample, { now: performance.now(), previousFrame: observer.previousFrame });
      observer.previousFrame = stamp.frame;
      retainResult(observer, sample, result);
    }, error => { observer.total++; observer.counts['failed-measurement'] = (observer.counts['failed-measurement'] ?? 0) + 1; if (observer.failures.length < 30) observer.failures.push({ at: performance.now(), message: String(error) }); });
    observer.stop = () => {
      stopRender();
      if (prototype.show === show) prototype.show = originalShow; else fail('people observer ownership changed');
      observer.active = false;
      return { stopped: true };
    };
    return { installed: true };
  })();

}
export const { CONTACT_LIMIT_M, drawnLoad, drawnGrips, observeRender, gradeContact, retainResult, bodyGeometry } = contactTools();
