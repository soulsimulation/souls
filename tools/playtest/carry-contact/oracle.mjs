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
function gradeContact(sample, { now, previousFrame = -1, maxAgeMs = 250, limitM = CONTACT_LIMIT_M, previousAssignments = {} } = {}) {
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
    // The page fixes this bijection at the native assignment boundary. Never bless a per-frame palm swap.
    const history=sample.nativeHistory;
    if(!Array.isArray(history)||!history.length)return invalid('native assignment history unavailable');
    const same=h=>h.body===hold.body&&h.grip===hold.grip&&JSON.stringify(h.handsUm)===JSON.stringify(hold.handsUm);
    let episode=native.sinceUs,found=false;
    for(let i=history.length-1;i>=0;i--){const g=history[i];if(g.crew!==native.crew||g.sinceUs>atUs)return invalid('native assignment history identity/time');if(g.load!==native.load)break;if(g.phase==='souls:released'||!g.holds?.some(same))break;episode=g.sinceUs;found=true;}
    if(!found)return invalid('native assignment episode unavailable');
    const order=body.order,key=[native.crew,native.load,body.native,hold.grip,episode].join('|');
    if(!Array.isArray(order)||order.length!==2||order.some(n=>n!==0&&n!==1)||order[0]===order[1])return invalid('anatomical assignment missing');
    if(previousAssignments[key]&&previousAssignments[key].some((n,i)=>n!==order[i]))return invalid('anatomical assignment changed during a turn');
    contacts.push(...['left','right'].map((hand,i)=>({body:body.native,entity:body.entity,hand,grip:hold.grip,targetIndex:order[i],targetLocalUm:hold.handsUm[order[i]],targetWorld:targets[order[i]],palm:body.palms[hand],errorM:distance(body.palms[hand],targets[order[i]])})));
  }
  const clock=gradeLoadClock(sample);if(clock.reason)return invalid(clock.reason);
  const failed=contacts.some(c=>c.errorM>limitM)||!clock.ok;
  return {status:failed?'failed-native-pair':'passed-native-pair',basis:'native-local-pair',ok:!failed,limitM,crew:native.crew,load:native.load,phase:native.phase,observedWorldUs:atUs,contacts,legacy,clock};
}

/** The independent native load clock remains required even when no hand contact is currently owned. */
function gradeLoadClock(sample){
 const expected=sample.expectedLoad,m=sample.load?.matrix,atUs=Math.round(sample.worldSeconds*1e6);
 if(!Array.isArray(m)||m.length!==16||!m.every(Number.isFinite)||expected?.source!=='native-records'||expected.atUs!==atUs||!Array.isArray(expected.matrix)||expected.matrix.length!==16||!expected.matrix.every(Number.isFinite)||!Array.isArray(expected.previousMatrix)||expected.previousMatrix.length!==16||!expected.previousMatrix.every(Number.isFinite)||!Number.isSafeInteger(expected.previousAtUs)||expected.previousAtUs>atUs||atUs-expected.previousAtUs>250000||!Array.isArray(expected.pointsUm)||expected.pointsUm.length<2||expected.pointsUm.some(p=>!finite3(p))||!expected.pointsUm.some(p=>Math.hypot(...p)>.1e6))return{ok:false,reason:'independent full native pose/endpoint clock witness unavailable'};
 const transform=(matrix,p)=>[0,1,2].map(i=>matrix[i]*p[0]/1e6+matrix[i+4]*p[1]/1e6+matrix[i+8]*p[2]/1e6+matrix[i+12]);
 const clockErrorM=Math.max(...expected.pointsUm.map(p=>distance(transform(m,p),transform(expected.matrix,p)))),oneFrameTravelM=Math.max(...expected.pointsUm.map(p=>distance(transform(expected.matrix,p),transform(expected.previousMatrix,p))));
 return{ok:clockErrorM<=oneFrameTravelM+1e-6,clockErrorM,oneFrameTravelM};
}
function gradeInactive(sample,{now,previousFrame=-1,maxAgeMs=250}={}){
 const invalid=reason=>({status:'failed-measurement',basis:'unavailable',ok:false,reason,contacts:[]});
 if(sample?.stage!=='after-world-render'||sample.units!=='m'||!sample.currentCanvas||sample.renderTarget!==null||![sample.frame,sample.at,sample.worldSeconds,now].every(Number.isFinite)||sample.frame<=previousFrame||now<sample.at||now-sample.at>maxAgeMs)return invalid('stale or missing inactive draw');
 if(!sample.load?.parts||!sample.bodies?.length||sample.bodies.some(b=>!b.visibleSkin||!finite3(b.palms?.left)||!finite3(b.palms?.right)))return invalid('inactive load/body visibility unavailable');
 const state=sample.contactState,atUs=Math.round(sample.worldSeconds*1e6);
 if(state?.at!==atUs||!state.crew||state.field==='invalid')return invalid('native inactive state unavailable');
 const released=state.field==='valid'&&state.grips?.phase==='souls:released'&&state.grips.load===sample.load.native&&state.grips.sinceUs<=atUs;
 const absent=state.field==='absent'&&Array.isArray(state.members)&&state.members.length>0&&state.members.every(m=>sample.bodies.some(b=>b.native===m.body));
 if(!released&&!absent)return invalid('missing/unknown contacts are not a native inactive interval');
 const clock=gradeLoadClock(sample);if(clock.reason)return invalid(clock.reason);
 const complete=released&&atUs-state.grips.sinceUs>=300000;
 if(complete&&sample.bodies.some(b=>b.nativeCarryOwned))return invalid('native release did not clear body contact ownership');
 return{status:clock.ok?(released?'native-release-observation':'native-inactive-observation'):'failed-load-clock',basis:'inactive-interval',ok:clock.ok,certifiesActiveContact:false,contacts:[],clock,releaseComplete:complete,sinceUs:released?state.grips.sinceUs:null};
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
  const tools = { CONTACT_LIMIT_M, drawnLoad, drawnGrips, observeRender, gradeContact, gradeInactive, gradeLoadClock, retainResult, bodyGeometry };
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
    const nativeMatrix=(evidence,time)=>{
      if(evidence?.source!=='native-records'||!evidence.frames?.length)fail('native pose evidence unavailable');
      const result=world.camera.matrix.clone().identity();
      for(const f of [...evidence.frames].reverse()){
        let p=f.record.pos,q=f.record.rot;const a=f.bracket?.[0],b=f.bracket?.[1];
        if(a&&a[3]>=f.recordAt&&time>=a[3]){p=a.slice(4,7);q=a[7];if(!q)fail('native quaternion unavailable');
          if(b&&a[1]===b[1]&&a[2]===b[2]){if(!b[7])fail('native quaternion unavailable');const u=Math.max(0,Math.min(1,(time-a[3])/(b[3]-a[3])));p=p.map((n,i)=>n+(b[i+4]-n)*u);const qa=world.camera.quaternion.clone().set(q[1],q[2],q[3],q[0]).normalize(),qb=qa.clone().set(b[7][1],b[7][2],b[7][3],b[7][0]).normalize();qa.slerp(qb,u);q=[qa.w,qa.x,qa.y,qa.z];}
        }
        const rotation=world.camera.quaternion.clone().set(q[1],q[2],q[3],q[0]).normalize(),position=world.camera.position.clone().set(...p.map(n=>n/1e6));
        if(f.slotPoint)position.add(world.camera.position.clone().set(...f.slotPoint.slice(1,4).map(n=>n/1000)));
        result.multiply(world.camera.matrix.clone().compose(position,rotation,world.camera.position.clone().set(1,1,1)));
      }return result.toArray();
    };
    let previousExpected=null;
    const observer = window.__carryContactObserver = { active: false, samples: [], failures: [], dropped: 0, source: config.source, previousFrame: -1, total: 0, counts: {}, maxima: {}, failedWitnesses: [] };
    const stopRender = observeRender(world.renderer, world, stamp => {
      const now = performance.now();
      if (!observer.active) return;
      if (!people) fail('production people instance not observed');
      const load = drawnLoad(world.layer, world.scene, config.binding.load.entity);
      const vector = (...p) => world.camera.position.clone().set(...p);
      const grips = drawnGrips(config.entry, load.matrix, vector);
      const frame = world.gameFrame(),nativeFrame=window.__soulsCarry,atUs=Math.round(world.worldSeconds*1e6);
      if(nativeFrame?.at!==atUs)fail('native/body depiction clocks disagree');
      if(nativeFrame.errors?.length)fail('native carry recording: '+nativeFrame.errors.join(';'));
      const contactState=nativeFrame?.contactStates?.find(o=>o.grips?.load===config.binding.load.native&&o.grips.phase!=='souls:released')??nativeFrame?.contactStates?.find(o=>o.crew===config.binding.crew)??nativeFrame?.contactStates?.find(o=>o.grips?.load===config.binding.load.native);
      if(contactState?.field==='invalid')fail('invalid native contact field');
      const observation=nativeFrame?.observations?.find(o=>o.grips.load===config.binding.load.native);
      const activeMembers=observation?.members;
      const observedBodies=contactState?.grips?.phase==='souls:released'?contactState.grips.holds.map(h=>({body:h.body})):activeMembers??contactState?.members;
      const selectedBindings=observedBodies?observedBodies.map(m=>{const b=config.binding.bodies.find(b=>b.native===m.body);if(!b)fail('whole native crew binding unavailable');return b;}):config.binding.bodies;
      const bodies = selectedBindings.map(binding => {
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
        return { ...binding, visibleSkin, palms, root: root.matrixWorld.toArray(),nativeCarryOwned:!!nativeFrame?.bodies?.[binding.entity],order:nativeFrame?.bodies?.[binding.entity]?.order };
      });
      const sample = { stage: 'after-world-render', units: 'm', currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected,
        renderTarget: world.renderer.getRenderTarget(), frame: stamp.frame, at: now, tick: frame.tick, worldSeconds: world.worldSeconds,
        load: { ...config.binding.load, parts: load.parts, matrix: load.matrix.toArray(), source: load.source, matrices: load.matrices ?? null }, bodies, grips,
        nativeContacts: observation?{...observation.grips,source:'souls:carry-grips',units:'um',space:'load-local',observedWorldUs:atUs}:null,
        crew:observation&&activeMembers?{native:observation.grips.crew,source:'native-membership',observedWorldUs:atUs,members:activeMembers.map(m=>m.body)}:null,
        expectedLoad:null,contactState,nativeHistory:observation?nativeFrame.phaseHistory?.[observation.grips.crew]:null };
      {const evidence=nativeFrame.evidence?.[config.binding.load.native],matrix=nativeMatrix(evidence,atUs);
        const bounds=config.entry?.geometry?.bounds_mm;if(!finite3(bounds))fail('load bounds unavailable');
        const pointsUm=[-1,1].flatMap(x=>[0,1].flatMap(y=>[-1,1].map(z=>[x*bounds[0]*500,y*bounds[1]*1000,z*bounds[2]*500])));
        const before=previousExpected??{matrix,atUs};
        sample.expectedLoad={source:'native-records',atUs,matrix,previousMatrix:before.matrix,previousAtUs:before.atUs,pointsUm};previousExpected={matrix,atUs};
      }
      let result;
      const active=observation&&['souls:carry','souls:set-in','souls:return','souls:held'].includes(observation.grips.phase);
      if(active){
        result=gradeContact(sample,{now:performance.now(),previousFrame:observer.previousFrame,previousAssignments:observer.assignments??{}});
        observer.assignments??={};if(result.basis==='native-local-pair')for(const c of result.contacts){
          const h=sample.nativeContacts.holds.find(h=>h.body===c.body);let episode=sample.nativeContacts.sinceUs;
          for(let i=sample.nativeHistory.length-1;i>=0;i--){const g=sample.nativeHistory[i];if(g.load!==sample.nativeContacts.load)break;if(g.phase==='souls:released'||!g.holds.some(p=>p.body===h.body&&p.grip===h.grip&&JSON.stringify(p.handsUm)===JSON.stringify(h.handsUm)))break;episode=g.sinceUs;}
          const body=sample.bodies.find(b=>b.native===c.body);observer.assignments[[sample.nativeContacts.crew,sample.nativeContacts.load,c.body,c.grip,episode].join('|')]=body.order;
        }
      }else{
        // These are recorded, native-timed noncontact observations, never active-contact passes or a grace period.
        result=gradeInactive(sample,{now,previousFrame:observer.previousFrame});
      }
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
export const { CONTACT_LIMIT_M, drawnLoad, drawnGrips, observeRender, gradeContact, gradeInactive, gradeLoadClock, retainResult, bodyGeometry } = contactTools();
