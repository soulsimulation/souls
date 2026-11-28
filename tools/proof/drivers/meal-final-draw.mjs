/** Meal-local measurement only. Never builds a picture, poses a rig, or changes native state. */
export function mealDrawTools({ vector, bodyGeometry, maxVertices = 100000, maxTriangles = 4096, maxHooks = 128 }) {
  const fail = why => { throw Error(`meal final draw: ${why}`); };
  for (const [value, cap] of [[maxVertices, 100000], [maxTriangles, 4096], [maxHooks, 128]]) if (!Number.isSafeInteger(value) || value <= 0 || value > cap) fail('invalid measurement budget');
  const finite = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  const attached = (object, scene) => { for (let o = object; o; o = o.parent) { if (!o.visible) return false; if (o === scene) return true; } return false; };
  const materialOn = m => m?.visible && m.opacity > 0 && m.colorWrite !== false && m.name !== 'shadow-proxy';
  const matrix = o => { if (!o.matrixWorld?.elements.every(Number.isFinite) || Math.abs(o.matrixWorld.determinant()) < 1e-12) fail('invalid drawn matrix'); return o.matrixWorld; };
  const bounds = points => {
    if (!points.length || points.some(p => !finite(p))) fail('missing or nonfinite points');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], low = [], high = [];
    for (const p of points) for (let i = 0; i < 3; i++) { if (p[i] < min[i]) { min[i] = p[i]; low[i] = p; } if (p[i] > max[i]) { max[i] = p[i]; high[i] = p; } }
    return { vertices: points.length, min, max, extrema: { low, high } };
  };
  const hooks = new Map(); let stopped = false, stopError;
  function track(root, world) {
    if (stopped) fail('mesh observer already stopped');
    root.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.shadowProxy || hooks.has(mesh)) return;
      if (hooks.size >= maxHooks) fail('mesh hook limit exceeded');
      const original = mesh.onAfterRender, record = { original, draws: [] };
      function after(...args) {
        const [renderer, scene, camera, geometry, material, group] = args;
        if (renderer === world.renderer && scene === world.scene && camera === world.camera && renderer.getRenderTarget() === null) {
          const frame = renderer.info.render.frame;
          if (record.frame !== frame) { record.frame = frame; record.draws = []; }
          if (record.draws.length >= 32) record.error = 'material submission limit exceeded';
          else record.draws.push({ geometry, material, group: group ? { ...group } : null,
            position: geometry.attributes.position, index: geometry.index,
            versions: [geometry.attributes.position?.version ?? geometry.attributes.position?.data?.version, geometry.index?.version],
            matrix: mesh.matrixWorld.elements.slice(), range: { ...geometry.drawRange } });
        }
        return original.apply(this, args);
      }
      record.after = after; hooks.set(mesh, record); mesh.onAfterRender = after;
    });
  }
  function stop() {
    if (stopped) { if (stopError) throw stopError; return; } stopped = true;
    const errors = [];
    for (const [mesh, record] of hooks) {
      if (mesh.onAfterRender === record.after) mesh.onAfterRender = record.original;
      else errors.push('mesh observer ownership changed');
    }
    if (errors.length) { stopError = Error(`meal final draw: ${errors.join('; ')}`); throw stopError; }
  }
  function submitted(mesh, world, stamp) {
    if (!attached(mesh, world.scene) || !mesh.isMesh || mesh.userData.shadowProxy || mesh.isInstancedMesh) fail('mesh is not a visible ordinary draw');
    matrix(mesh);
    const record = hooks.get(mesh), g = mesh.geometry, pos = g?.attributes.position, index = g?.index;
    if (!pos || record?.error || record?.frame !== stamp.frame || !record.draws.length) fail(record?.error ?? 'mesh has no actual current submission');
    const count = index?.count ?? pos.count, refs = new Set(), start = g.drawRange.start, end = Math.min(count, start + g.drawRange.count);
    if (!Number.isSafeInteger(start) || start < 0 || start % 3 || !Number.isSafeInteger(end) || end < start || end % 3) fail('invalid drawn range');
    const parts = [];
    for (const draw of record.draws) {
      if (draw.geometry !== g || !materialOn(draw.material)) fail('stale geometry or hidden submitted material');
      if (draw.position !== pos || draw.index !== index || JSON.stringify(draw.versions) !== JSON.stringify([pos.version ?? pos.data?.version, index?.version]) ||
        !draw.matrix.every((n, i) => n === mesh.matrixWorld.elements[i]) || draw.range.start !== g.drawRange.start || draw.range.count !== g.drawRange.count) fail('geometry or transform changed after submission');
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!mats.includes(draw.material)) fail('stale submitted material');
      if (Array.isArray(mesh.material) && (!draw.group || mesh.material[draw.group.materialIndex] !== draw.material ||
        !g.groups.some(group => group.start === draw.group.start && group.count === draw.group.count && group.materialIndex === draw.group.materialIndex))) fail('stale material group');
      const a = Math.max(start, draw.group?.start ?? start), b = Math.min(end, draw.group ? draw.group.start + draw.group.count : end);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a % 3 || b % 3 || b <= a) fail('empty or partial submitted triangles');
      if (b - a > (mesh.isSkinnedMesh ? maxVertices * 12 : maxTriangles * 3)) fail('triangle budget exceeded');
      for (let n = a; n < b; n++) { const i = index ? index.getX(n) : n; if (!Number.isSafeInteger(i) || i < 0 || i >= pos.count) fail('invalid submitted index'); refs.add(i); }
      parts.push({ start: a, count: b - a, material: draw.material.uuid, group: draw.group });
    }
    if (!refs.size || refs.size > maxVertices) fail('vertex budget exceeded');
    return { refs: [...refs], parts, geometry: g.uuid, indexed: !!index };
  }
  function rootOf(scene, id) {
    const roots = []; let visited = 0;
    scene.traverse(o => { if (++visited > 20000) fail('scene identity scan limit exceeded'); if (o.userData.entity === id && attached(o, scene)) roots.push(o); });
    // Descendants can carry the same id; count the maximal identity roots only.
    const maximal = roots.filter(o => !roots.some(other => other !== o && (() => { for (let p = o.parent; p; p = p.parent) if (p === other) return true; return false; })()));
    if (maximal.length !== 1) fail('held root missing or ambiguous');
    matrix(maximal[0]); return maximal[0];
  }
  function hand(entry, body) {
    const resources = body?.nativeResources;
    if (body?.nativeBody !== entry.parent || !/^[a-f0-9]{64}$/.test(body?.nativeKindHash ?? '') || !Array.isArray(resources)) fail('declared hand metadata missing');
    if (resources.length > 256 || resources.some(r => !Array.isArray(r) || r.length < 2 || r.length > 3 || typeof r[0] !== 'string' || !Number.isSafeInteger(r[1]) || r[2] !== undefined && (!Number.isSafeInteger(r[2]) || r[2] < 1))) fail('malformed hand resources');
    const hands = resources.filter(r => Array.isArray(r) && r[1] === 2 && r[2] !== undefined);
    if (new Set(hands.map(r => r[0])).size !== hands.length || new Set(hands.map(r => r[2])).size !== hands.length) fail('ambiguous hand metadata');
    const matches = hands.filter(r => r[2] === entry.slot);
    if (matches.length !== 1 || !['souls:hand-left', 'souls:hand-right'].includes(matches[0][0])) fail('held slot is not a declared hand');
    return matches[0][0] === 'souls:hand-left' ? 'left' : 'right';
  }
  function bowl(root, world, stamp, entry, soup) {
    const source = entry.looks?.shape, color = source?.palette?.soup, fills = source?.shapes?.filter(s => s.tint === 'soup') ?? [];
    if (!/^#[a-f0-9]{6}$/i.test(color ?? '') || fills.length !== 2 || ![0, 1, 2].includes(soup)) fail('canonical bowl contents contract unavailable');
    const selected = soup === 0 ? null : fills.find(s => s.when === (soup === 2 ? '@soup>=2' : '@soup=1'));
    if (soup && (!selected || selected.kind !== 'cyl' || !finite(selected.at) || !Number.isFinite(selected.h) || !Number.isFinite(selected.r))) fail('canonical soup shape unavailable');
    const linear = n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
    const tint = [1, 3, 5].map(i => linear(parseInt(color.slice(i, i + 2), 16) / 255));
    const inverse = matrix(root).clone().invert(), soupPoints = [], points = [], meshes = [];
    root.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.shadowProxy || !attached(mesh, world.scene)) return;
      const draw = submitted(mesh, world, stamp), colors = mesh.geometry.attributes.color;
      if (!colors || colors.itemSize !== 3 || !mesh.material || !(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(m => m.vertexColors)) fail('canonical baked colors unavailable');
      for (const i of draw.refs) {
        const p = mesh.getVertexPosition(i, vector()).applyMatrix4(mesh.matrixWorld); const xyz = p.toArray(); if (!finite(xyz)) fail('nonfinite bowl vertex'); points.push(xyz);
        const c = [colors.getX(i), colors.getY(i), colors.getZ(i)]; if (!finite(c)) fail('nonfinite bowl color');
        if (c.every((n, k) => Math.abs(n - tint[k]) < 1e-5)) soupPoints.push(p.applyMatrix4(inverse).toArray());
      }
      meshes.push({ mesh: mesh.uuid, matrix: mesh.matrixWorld.toArray(), ...draw, refs: undefined });
    });
    if (!meshes.length) fail('canonical bowl draw missing');
    if (soup === 0 && soupPoints.length) fail('empty bowl still draws soup');
    let fill = null;
    if (selected) {
      fill = bounds(soupPoints); const y = selected.at[1] / 1000, h = selected.h / 1000;
      const radius = Math.max(...soupPoints.map(p => Math.hypot(p[0] - selected.at[0] / 1000, p[2] - selected.at[2] / 1000)));
      if (Math.abs(fill.min[1] - (y - h / 2)) > 1e-5 || Math.abs(fill.max[1] - (y + h / 2)) > 1e-5 || Math.abs(radius - selected.r / 1000) > 1e-5) fail('drawn soup quantity geometry differs');
      fill.radiusM = radius;
    }
    return { identity: root.userData.entity, root: root.matrixWorld.toArray(), meshes, bounds: bounds(points), soup, fill };
  }
  function skin(root, world, stamp, anchors) {
    if (!attached(root, world.scene) || !Array.isArray(anchors) || anchors.length !== 2 || !anchors.every(finite)) fail('live body or both foot anchors missing');
    matrix(root); const skins = []; root.traverse(m => { if (m.isSkinnedMesh && attached(m, world.scene)) skins.push(m); });
    const classic = skins.some(m => m.userData.bodyDraw);
    if (classic) bodyGeometry(root, world.scene);
    else if (skins.length !== 1 || !skins[0].geometry.index || root.userData.entity !== root.name) fail('unproved imported single-skin body');
    const points = [], legs = [], feet = [[], []], ground = [[], []], meshes = [];
    for (const mesh of skins.filter(m => classic ? m.userData.bodyDraw : true)) {
      const draw = submitted(mesh, world, stamp), weights = mesh.geometry.attributes.skinWeight, indices = mesh.geometry.attributes.skinIndex;
      if (!weights || !indices) fail('skin attribution missing');
      for (const i of draw.refs) {
        const p = mesh.getVertexPosition(i, vector()).applyMatrix4(mesh.matrixWorld).toArray(); if (!finite(p)) fail('nonfinite drawn skin'); points.push(p);
        const screen = vector().fromArray(p).applyMatrix4(world.camera.matrixWorldInverse).applyMatrix4(world.camera.projectionMatrix).toArray();
        if (!finite(screen) || Math.abs(screen[0]) > .99 || Math.abs(screen[1]) > .99 || screen[2] < -1 || screen[2] > 1) fail('full body is outside the actual camera frame');
        let k = 0; for (let j = 1; j < 4; j++) if (weights.getComponent(i, j) > weights.getComponent(i, k)) k = j;
        const name = mesh.skeleton.bones[indices.getComponent(i, k)]?.name ?? '';
        if (/Leg/i.test(name)) legs.push(p);
        if (/Foot|Toe/i.test(name)) {
          const d = a => p.reduce((sum, n, axis) => sum + (n - a[axis]) ** 2, 0), side = d(anchors[0]) <= d(anchors[1]) ? 0 : 1;
          const y = world.layer?.groundAt?.(p[0], p[2]); if (!Number.isFinite(y)) fail('foot ground unavailable');
          feet[side].push(p); ground[side].push(p[1] - y);
        }
      }
      meshes.push({ mesh: mesh.uuid, ...draw, refs: undefined });
    }
    return { source: classic ? 'submitted bodyDraw' : 'submitted single imported skin', root: root.matrixWorld.toArray(), meshes,
      bounds: bounds(points), legs: bounds(legs), feet: feet.map((p, i) => ({ inferred: true, anchor: anchors[i], ...bounds(p), minGroundGapM: Math.min(...ground[i]), maxGroundGapM: Math.max(...ground[i]) })) };
  }
  function snapshot({ world, people, stamp, soul, expected, entry, bodyBinding }) {
    const frame = world.gameFrame(), matches = frame.souls?.filter(s => s.id === soul) ?? [];
    if (matches.length !== 1 || !Number.isFinite(frame.tick) || !Number.isFinite(frame.dt) || !people?.frame ||
      Math.abs(people.take?.startTick + people.frame.tick - frame.tick) > 1e-6 || !Number.isFinite(people.take?.startTick + people.frame.tick) ||
      !attached(people.group, world.scene)) fail('live people/frame identity missing or stale');
    const id = matches[0].entityId, actor = frame.entities[id], held = actor?.state?.heldEntries?.entries?.filter(e => e.id === expected.native.bowl.id) ?? [];
    if (held.length !== 1) fail('held entry missing or ambiguous');
    const e = held[0], native = expected.native.bowl;
    if (e.state?.soup !== expected.soup || e.parent !== native.parent || e.kind !== native.kind || e.slot !== native.slot || JSON.stringify(e.pos) !== JSON.stringify(native.pos) || JSON.stringify(e.rot) !== JSON.stringify(native.rot)) fail('draw and native checkpoint differ');
    const base = actor.state?.baseActivity ?? actor.activity;
    if (expected.phase === 'seated' && base !== 'sit' || expected.phase === 'risen' && base !== 'idle') fail('drawn posture differs');
    if (!bodyBinding || actor.state?.body?.nativeKindHash !== bodyBinding.hash || JSON.stringify(actor.state.body.nativeResources) !== JSON.stringify(bodyBinding.resources)) fail('declared body binding changed');
    if (typeof e.origin !== 'string' || !e.origin || world.layer?.drawn?.has(e.origin)) fail('original bowl world draw still present or identity unknown');
    let oldVisible = false; world.scene.traverse(o => { if (o.userData.entity === e.origin && attached(o, world.scene) && o.isMesh) oldVisible = true; });
    if (oldVisible) fail('original bowl still visibly drawn');
    const root = people.bodyObject(id), selected = hand(e, actor.state?.body), bowlRoot = rootOf(world.scene, e.id);
    if (!root || root.name !== id || !attached(root, world.scene)) fail('drawn body identity differs');
    const palm = vector(); if (!people.palmOf(id, selected, palm) || !finite(palm.toArray())) fail('actual selected palm unavailable');
    const grip = entry.points?.grip?.at_mm; if (!finite(grip) || entry.points.grip.role !== 'grip' || !finite(e.pos) || !Array.isArray(e.rot) || e.rot.length !== 4 || !e.rot.every(Number.isFinite)) fail('canonical grip/native pose unavailable');
    const q = root.quaternion.clone(); root.matrixWorld.decompose(vector(), q, vector());
    const desired = vector().fromArray(e.pos).multiplyScalar(1e-6).applyQuaternion(q).add(palm);
    const actual = vector().fromArray(grip).multiplyScalar(.001).applyMatrix4(matrix(bowlRoot));
    const errorM = actual.distanceTo(desired); if (!Number.isFinite(errorM) || errorM > .001) fail('canonical grip misses drawn palm/native offset');
    const local = root.quaternion.clone().set(e.rot[1], e.rot[2], e.rot[3], e.rot[0]);
    if (local.lengthSq() < 1e-12) fail('invalid native held rotation');
    const desiredRotation = q.clone().multiply(local.normalize()), actualRotation = q.clone();
    bowlRoot.matrixWorld.decompose(vector(), actualRotation, vector());
    const rotationErrorRad = actualRotation.angleTo(desiredRotation);
    if (!Number.isFinite(rotationErrorRad) || rotationErrorRad > .00001) fail('canonical bowl orientation differs from native local rotation');
    const contact = world.contactFrame?.();
    if (contact?.tick !== frame.tick || contact.dt !== frame.dt) fail('rendered foot diagnostics clock differs');
    const picture = bowl(bowlRoot, world, stamp, entry, expected.soup), body = skin(root, world, stamp, contact.bones?.[id]?.feet);
    return { stage: 'after-world-render', renderFrame: stamp.frame, tick: frame.tick, dt: frame.dt, phase: expected.phase, soup: expected.soup, soul, entity: id,
      currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected, renderTarget: null,
      hand: selected, palm: palm.toArray(), grip: actual.toArray(), nativeOffsetPalm: desired.toArray(), gripErrorM: errorM, rotationErrorRad, nativeLocalPose: { pos: e.pos, rot: e.rot }, enginePosition: actor.p ?? null, activity: actor.activity, baseActivity: base, picture, body,
      qualification: 'Actual submitted geometry sampled after world draw; inferred foot regions and ground gaps are observations, not native support/contact or complete penetration certification. Full-body uncut film remains required.' };
  }
  function currentNative(observer, expected) {
    if (!observer || observer.failures?.length) fail('current public payload observer missing or failed');
    const rows = observer.workers.filter(w => w.latest.has(expected.native.bowl.id));
    if (rows.length !== 1 || rows[0].number !== expected.native.worker) fail('current native Worker identity ambiguous');
    const actual = rows[0].latest.get(expected.native.bowl.id), prior = expected.native.bowl;
    for (const key of ['id', 'kind', 'parent', 'slot', 'pos', 'rot']) if (JSON.stringify(actual[key]) !== JSON.stringify(prior[key])) fail('current native bowl changed before draw');
    const q = actual.fields?.['28']; if (q !== expected.soup && q?.big !== String(expected.soup)) fail('current native soup differs from draw goal');
  }
  return { attached, bounds, track, stop, submitted, rootOf, hand, bowl, skin, snapshot, currentNative, limits: { maxVertices, maxTriangles, maxHooks, samples: 361, cadenceMs: 250 } };
}

/** Serialized entry points use only actual loaded production modules and page diagnostics. */
export async function mealDrawInstall({ helperURL, oracleURL, kitURL, soul, entry, entrySHA, bodyBinding }) {
  const { mealDrawTools } = await import(helperURL), { observeRender, bodyGeometry } = await import(oracleURL), { TakePeople } = await import(kitURL);
  const world = window.__soulsEntity, prototype = TakePeople.prototype, original = prototype.show;
  if (!world?.gameFrame || !original || window.__mealDrawObserver) throw Error('meal final-draw install unavailable');
  const tools = mealDrawTools({ vector: () => world.camera.position.clone(), bodyGeometry });
  const observer = { samples: [], failures: [], checkpoints: [], people: null, pending: null, lastAt: -Infinity, lastRender: -1, stopped: false,
    limits: tools.limits, source: { entrySHA, kind: entry.kind }, defaultControl: 'Unsupported default-body Server; no inferred hand or canonical picture claim.' };
  const failure = error => { if (observer.failures.length < 10) observer.failures.push(String(error)); };
  function show(...args) {
    const result = original.apply(this, args);
    try {
      if (!tools.attached(this.group, world.scene)) return result;
      const frame = world.gameFrame(), matches = frame.souls?.filter(s => s.id === soul) ?? [];
      if (matches.length !== 1) return result;
      const root = this.bodyObject(matches[0].entityId);
      if (!root || !tools.attached(root, world.scene)) return result;
      if (observer.people && observer.people !== this && tools.attached(observer.people.group, world.scene)) throw Error('meal actual people instance ambiguous');
      observer.people = this; tools.track(root, world);
      const held = frame.entities[matches[0].entityId]?.state?.heldEntries?.entries ?? [];
      for (const e of held) {
        let picture;
        try { picture = tools.rootOf(world.scene, e.id); } catch (error) { if (!String(error).includes('held root missing or ambiguous')) throw error; }
        if (picture) tools.track(picture, world); // Missing handoff picture is never accepted at a positive checkpoint.
      }
    } catch (error) { failure(error); }
    return result;
  }
  prototype.show = show;
  const stopRender = observeRender(world.renderer, world, stamp => {
    observer.lastRender = stamp.frame;
    if (!observer.pending || performance.now() - observer.lastAt < tools.limits.cadenceMs) return;
    const at = observer.lastAt = performance.now();
    if (observer.samples.length >= tools.limits.samples) throw Error('meal final-draw sample limit exceeded');
    const goal = observer.pending;
    if (stamp.frame <= goal.afterFrame || world.gameFrame().tick < goal.expected.depicted.tick) return;
    tools.currentNative(window.__mealPayloadObserver, goal.expected);
    const sample = tools.snapshot({ world, people: observer.people, stamp, soul, expected: goal.expected, entry, bodyBinding });
    sample.measurementMs = performance.now() - at;
    if (!sample.currentCanvas || sample.renderFrame <= (observer.samples.at(-1)?.renderFrame ?? -Infinity) || sample.tick <= (observer.samples.at(-1)?.tick ?? -Infinity)) throw Error('meal final-draw clock/canvas stale');
    observer.samples.push(sample);
    if (!goal.observed) { goal.observed = sample; observer.checkpoints.push(sample); }
  }, failure);
  observer.stop = () => {
    if (observer.stopped) { if (observer.error) throw observer.error; return observer.result; }
    observer.stopped = true; const errors = [];
    for (const restore of [stopRender, () => { if (prototype.show !== show) throw Error('meal people observer ownership changed'); prototype.show = original; }, tools.stop]) try { restore(); } catch (error) { errors.push(String(error)); }
    observer.result = { samples: observer.samples, checkpoints: observer.checkpoints, failures: observer.failures, limits: observer.limits, source: observer.source, defaultControl: observer.defaultControl };
    if (errors.length) { observer.error = Error(errors.join('; ')); throw observer.error; }
    return observer.result;
  };
  window.__mealDrawObserver = observer;
  return { source: observer.source, limits: observer.limits };
}

export function mealDrawGoal(expected) {
  const observer = window.__mealDrawObserver;
  if (!observer || observer.stopped) throw Error('meal final-draw observer missing');
  if (observer.failures.length) throw Error(observer.failures.join('; '));
  observer.pending = expected ? { expected, afterFrame: observer.lastRender, observed: null } : null;
}
export function mealDrawCheckpoint() {
  const observer = window.__mealDrawObserver;
  if (!observer || observer.stopped) throw Error('meal final-draw observer missing');
  if (observer.failures.length) throw Error(observer.failures.join('; '));
  return observer.pending?.observed ?? null;
}
export function mealDrawStop() {
  const observer = window.__mealDrawObserver; if (!observer) return undefined;
  try { return observer.stop(); }
  catch (error) { return { ...observer.result, cleanupError: String(error) }; }
}
