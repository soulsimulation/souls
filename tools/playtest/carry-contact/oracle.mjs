// Production observations only; this self-contained factory also installs through Playwright.evaluate.
export function contactTools(config) {
// Final-draw observations only. The native local contact pair is required to certify contact.
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

/** Certify only the native two-point contract. Entry-centre distances are a separate legacy diagnostic. */
function gradeContact(sample, { now, previousFrame = -1, maxAgeMs = 250, limitM = CONTACT_LIMIT_M } = {}) {
  const invalid = reason => ({ status: 'failed-measurement', basis: 'unavailable', ok: false, reason, contacts: [] });
  const id = v => typeof v === 'string' && v.length > 0;
  const distinct = xs => new Set(xs).size === xs.length;
  if (!sample || sample.stage !== 'after-world-render' || sample.units !== 'm' || !sample.currentCanvas || sample.renderTarget !== null) return invalid('not an actual final world draw in metres');
  if (![sample.frame, sample.at, sample.worldSeconds, now].every(Number.isFinite) || sample.frame <= previousFrame || now < sample.at || now - sample.at > maxAgeMs) return invalid('stale or missing draw');
  if (!id(sample.load?.native) || !id(sample.load?.entity) || !sample.load?.entrySha256 || !sample.load?.kind || !sample.load?.parts || !sample.bodies?.length || !Number.isFinite(limitM) || limitM <= 0 || limitM > CONTACT_LIMIT_M) return invalid('missing identity, geometry or threshold');
  for (const body of sample.bodies) {
    if (!id(body.native) || !id(body.entity) || !id(body.soul) || !body.visibleSkin || !finite3(body.palms?.left) || !finite3(body.palms?.right)) return invalid('missing carrier or live palms');
  }
  if (['native', 'entity', 'soul'].some(k => !distinct(sample.bodies.map(b => b[k])))) return invalid('ambiguous carrier identity');
  // A grip centre is not either offset hand contact. Never use this distance to pass or fail the new contract.
  const legacy = { basis: 'entry-grip-centres-only', certifiesNativeContact: false, contacts: [] };
  if (Array.isArray(sample.grips) && sample.grips.length && distinct(sample.grips.map(g => g.name)) && sample.grips.every(g => id(g.name) && finite3(g.world))) {
    for (const body of sample.bodies) for (const hand of ['left', 'right']) {
      const nearest = sample.grips.map(g => ({ grip: g.name, distanceM: distance(body.palms[hand], g.world) })).reduce((a, b) => a.distanceM <= b.distanceM ? a : b);
      legacy.contacts.push({ body: body.native, hand, palm: body.palms[hand], nearest, interpretation: 'legacy centre distance; not native contact error or lower bound' });
    }
  }
  const native = sample.nativeContacts;
  if (native == null) return { status: 'unproved', basis: 'unavailable', ok: false, reason: 'native local contact pair unavailable', contacts: [], legacy };
  const crew = sample.crew, atUs = Math.round(sample.worldSeconds * 1e6);
  if (native.source !== 'souls:carry-grips' || native.units !== 'um' || native.space !== 'load-local') return invalid('native contact provenance, units or frame unavailable');
  if (!Number.isSafeInteger(atUs) || native.observedWorldUs !== atUs || !Number.isSafeInteger(native.sinceUs) || native.sinceUs > atUs) return invalid('stale or future native phase observation');
  if (!['souls:carry', 'souls:set-in', 'souls:return', 'souls:held'].includes(native.phase)) return invalid('native contacts are not in an active holding phase');
  const timed = native.phase === 'souls:set-in' || native.phase === 'souls:return';
  if ((timed && native.untilUs == null) || (native.untilUs != null && (!Number.isSafeInteger(native.untilUs) || native.untilUs <= native.sinceUs || atUs >= native.untilUs))) return invalid('native phase interval expired or missing');
  if (!id(crew?.native) || crew.source !== 'native-membership' || crew.observedWorldUs !== atUs || !Array.isArray(crew.members) || !crew.members.length || !crew.members.every(id) || !distinct(crew.members)) return invalid('whole native crew membership unavailable');
  if (native.crew !== crew.native || native.load !== sample.load.native) return invalid('native crew or load identity mismatch');
  const members = new Set(crew.members);
  if (sample.bodies.length !== members.size || sample.bodies.some(b => !members.has(b.native))) return invalid('drawn carriers do not cover the whole native crew');
  if (!Array.isArray(native.holds) || native.holds.length !== members.size || !distinct(native.holds.map(h => h?.body)) || native.holds.some(h => !members.has(h?.body))) return invalid('native contact pairs do not cover the whole crew');
  const m = sample.load.matrix;
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) return invalid('actual drawn load matrix unavailable');
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (Math.abs(det) <= 1e-12) return invalid('actual drawn load matrix is degenerate');
  const worldPoint = p => [0, 1, 2].map(i => m[i] * p[0] / 1e6 + m[i + 4] * p[1] / 1e6 + m[i + 8] * p[2] / 1e6 + m[i + 12]);
  const contacts = [];
  for (const hold of native.holds) {
    if (typeof hold.grip !== 'string' || !/^point:[a-zA-Z0-9_-]+$/.test(hold.grip) || !finite3(hold.gripUm) || !hold.gripUm.every(Number.isSafeInteger) || !Array.isArray(hold.handsUm) || hold.handsUm.length !== 2 || hold.handsUm.some(p => !finite3(p) || !p.every(Number.isSafeInteger)) || hold.handsUm[0].every((n, i) => n === hold.handsUm[1][i])) return invalid('native ordered contact pair missing or malformed');
    const body = sample.bodies.find(b => b.native === hold.body), targets = hold.handsUm.map(worldPoint);
    if (targets.some(p => !finite3(p))) return invalid('native world contact unavailable');
    // Native indices run along the carry, not anatomical left/right. Compare the only two bijections.
    const candidates = [[0, 1], [1, 0]].map(order => {
      const pair = ['left', 'right'].map((hand, i) => ({ body: body.native, entity: body.entity, hand, grip: hold.grip, targetIndex: order[i], targetLocalUm: hold.handsUm[order[i]], targetWorld: targets[order[i]], palm: body.palms[hand], errorM: distance(body.palms[hand], targets[order[i]]) }));
      return { pair, max: Math.max(...pair.map(c => c.errorM)), sum: pair.reduce((n, c) => n + c.errorM, 0) };
    });
    candidates.sort((a, b) => a.max - b.max || a.sum - b.sum);
    contacts.push(...candidates[0].pair);
  }
  const failed = contacts.some(c => c.errorM > limitM);
  return { status: failed ? 'failed-native-pair' : 'passed-native-pair', basis: 'native-local-pair', ok: !failed, limitM, crew: native.crew, load: native.load, phase: native.phase, observedWorldUs: atUs, contacts, legacy };
}


  function retainResult(observer, sample, result, cap = 100) {
    observer.total++;
    const stamp = { frame: sample.frame, worldSeconds: sample.worldSeconds, at: sample.at };
    observer.interval ??= { first: stamp, last: stamp };
    observer.interval.last = stamp;
    observer.counts[result.status] = (observer.counts[result.status] ?? 0) + 1;
    for (const c of result.contacts) {
      const key = `${c.body}:${c.hand}`, value = c.errorM;
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
        nativeContacts: null, crew: null };
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
