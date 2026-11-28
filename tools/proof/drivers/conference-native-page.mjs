// Actual-page conference composition diagnostic. Receipts/canvas readiness do not qualify animation/contact.
// The unchanged runOwnedAttempt owns the sole native world, all registered clients/commands and the browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decode, idText } from '../../../v2/client/src/brief/copy.mjs';
import { nativeCameraMode } from './camera-native-page.mjs';
import { discoverConference, performConference } from '../../playtest/conference/rehearse.mjs';
import { conferenceWorldPage, downloadConferenceClient, pairConferenceSeat, pairConferenceCreator, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';

const states = new Map();
const names = ['Presenter', 'Cedar', 'Maple', 'Willow', 'Birch'];
const save = (paths, file, value) => writeFileSync(join(paths.dir, file), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });

// Read only the fixture's already published public view with the same validated player as the page.
export async function conferencePublicLecture({ paths, recipe, nativeLecture }) {
  const root = join(paths.data, 'world', 'world'), publicRoot = join(root, 'views'), inputs = [];
  const read = file => {
    const rel = relative(publicRoot, file);
    assert(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'conference public view path escapes');
    const bytes = readFileSync(file); inputs.push({ file: rel, sha256: createHash('sha256').update(bytes).digest('hex') }); return bytes;
  };
  const manifest = JSON.parse(read(join(publicRoot, 'world.json'))), stream = resolve(root, manifest.stream);
  const { initSync, readPointer, StreamPlayer } = await import(pathToFileURL(join(recipe.pkg, 'replica.js')).href);
  initSync({ module: readFileSync(join(recipe.pkg, 'replica_bg.wasm')) });
  const pointer = JSON.parse(readPointer(read(join(stream, 'pointer'))));
  assert(typeof pointer.header === 'string' && pointer.header, 'conference public header missing');
  const header = read(resolve(stream, '../../../headers', pointer.header));
  assert(!pointer.generation || /^[a-f0-9]{64}$/.test(pointer.generation) && pointer.baseline === pointer.generation, 'conference public generation differs');
  const file = name => join(stream, ...(pointer.generation ? ['g', pointer.generation] : []), name);
  let player;
  if (pointer.generation) {
    const baseline = read(file('baseline'));
    assert.equal(createHash('sha256').update(baseline).digest('hex'), pointer.baseline, 'conference public baseline hash differs');
    player = StreamPlayer.fromBaseline(header, baseline);
  } else player = new StreamPlayer(header);
  try {
    let parts = 0;
    while (Number(player.next()) <= pointer.newest) {
      assert(++parts <= 2048, 'conference identity public catch-up bound exceeded');
      player.play(read(file(String(player.next()))));
    }
    player.verify();
    const records = decode(player.snapshot()).filter(n => idText(n.get(1)) === nativeLecture);
    assert.equal(records.length, 1, 'conference native lectern public record missing or ambiguous');
    const record = records[0], fields = record.get(6), text = new TextDecoder();
    return { id: nativeLecture, kind: record.get(2),
      ...(fields.get(1) instanceof Uint8Array ? { origin: text.decode(fields.get(1)) } : {}),
      ...(fields.get(2) instanceof Uint8Array ? { def: text.decode(fields.get(2)) } : {}), inputs, parts };
  } finally { player.free(); }
}

export async function conferenceNativeLectureBinding({ checkout, nativeLecture, node, name }) {
  assert(typeof checkout === 'string' && nativeLecture && node?.id === nativeLecture, 'conference native lectern binding missing');
  assert.equal(name, 'presentation-lectern', 'conference native lectern name differs');
  assert.equal(node.kind.split('@')[0], 'eden:hall_lecture', 'conference native lectern kind differs');
  const file = join(checkout, 'apps/web/src/v2-engine/layer-draws.ts');
  const { OLD_ENTITY, layerDraws } = await import(pathToFileURL(file).href);
  let entity, mapping;
  if (layerDraws(node)) {
    assert(OLD_ENTITY.test(node.origin) && node.def, 'conference imported lectern origin/def unavailable');
    entity = node.origin; mapping = 'layerDraws: imported NodeRec.origin';
  } else {
    const { entityId } = await import(pathToFileURL(join(checkout, 'apps/web/src/v2-engine/creator-kinds.ts')).href);
    entity = entityId(nativeLecture); mapping = 'CreatorKinds: entityId for non-imported node';
  }
  return { nativeLecture, nativeKind: node.kind, nativeName: name, ...(node.origin ? { origin: node.origin } : {}),
    ...(node.def ? { def: node.def } : {}), entity, mapping,
    mappingSha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
}

// Serialized unchanged into the browser. Diagnostic candidates never select the target.
export function conferenceLecternIdentity(world, binding, drawnLoad) {
  const witness = { ...binding, candidateLimit: 16, candidates: [], candidateCount: 0, matched: null };
  try {
    if (!binding?.nativeLecture || !binding.entity || !world?.layer?.model) throw Error('conference native lectern binding unavailable');
    const model = world.layer.model, entities = [...model.entities.values()];
    const candidates = entities.filter(e => e.name === 'presentation-lectern' || e.id === binding.entity);
    witness.candidateCount = candidates.length;
    witness.candidates = candidates.slice(0, witness.candidateLimit).map(e => ({ id: e.id, name: e.name, def: e.def,
      resolvedDef: model.resolvedDef(e.def)?.name ?? null, drawn: world.layer.drawn.has(e.id) }));
    const matches = entities.filter(e => e.id === binding.entity);
    if (matches.length !== 1) throw Error('conference mapped lectern identity missing or ambiguous');
    const entity = matches[0];
    if (entity.name !== undefined && entity.name !== binding.nativeName || binding.def && entity.def !== binding.def || model.resolvedDef(entity.def)?.name !== 'core-hall_lecture') throw Error('conference mapped lectern name or kind differs');
    const load = drawnLoad(world.layer, world.scene, entity.id);
    if (load.entity !== entity.id || !Number.isInteger(load.parts) || load.parts < 1) throw Error('conference mapped lectern geometry unavailable');
    witness.matched = { id: entity.id, name: entity.name, def: entity.def, resolvedDef: 'core-hall_lecture',
      source: load.source, parts: load.parts, root: load.matrix.toArray() };
    return { ok: true, witness };
  } catch (error) { return { ok: false, witness, error: String(error) }; }
}

// Self-contained, served only by this proof driver. Reads submitted geometry; never poses or moves it.
export function conferenceClearanceTools({ vector, drawnLoad, bodyGeometry, maxVertices = 100000, maxTriangles = 2048, maxTests = 250000, uncertaintyM = .001 }) {
  const fail = why => { throw Error(`conference clearance: ${why}`); };
  if(![maxVertices,maxTriangles,maxTests].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isFinite(uncertaintyM)||uncertaintyM<=0||uncertaintyM>.001)fail('invalid measurement bounds');
  const finite = p => p.length === 3 && p.every(Number.isFinite);
  const sub = (a, b) => a.map((n, i) => n - b[i]), dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const length = p => Math.hypot(...p), add = (p, v, k) => p.map((n, i) => n + v[i] * k);
  const bounds = points => ({ min: [0,1,2].map(i => Math.min(...points.map(p => p[i]))), max: [0,1,2].map(i => Math.max(...points.map(p => p[i]))) });
  const nearBox = (p, b) => p.every((n, i) => n >= b.min[i]-uncertaintyM && n <= b.max[i]+uncertaintyM);
  const attached = (o, scene) => { for (; o; o=o.parent) { if (!o.visible) return false; if (o===scene) return true; } return false; };
  const materialOn = m => m?.visible && m.opacity > 0 && m.colorWrite !== false && m.name !== 'shadow-proxy';
  const cache = new WeakMap();
  const submissions = new WeakMap();
  function submitted(mesh, scene) {
    if (!attached(mesh, scene) || !mesh.isMesh || mesh.userData.shadowProxy || !mesh.geometry?.attributes.position) fail('mesh hidden, detached or unavailable');
    const g=mesh.geometry, pos=g.attributes.position, index=g.index, count=index?.count ?? pos.count;
    if(count>(mesh.isSkinnedMesh?maxVertices*12:maxTriangles*3))fail('submitted geometry limit exceeded');
    const start=g.drawRange.start, end=Math.min(count, start+g.drawRange.count), ranges=[];
    if (!Number.isInteger(start) || start<0 || start%3 || !Number.isFinite(end) || end<start || end%3) fail('invalid submitted triangle range');
    if (Array.isArray(mesh.material)) {
      for (const group of g.groups) if (materialOn(mesh.material[group.materialIndex])) ranges.push([Math.max(start,group.start),Math.min(end,group.start+group.count)]);
    } else if (materialOn(mesh.material)) ranges.push([start,end]);
    const signature=JSON.stringify([g.drawRange,g.groups,ranges]), versions=[pos.version??pos.data?.version,index?.version??index?.data?.version];
    const known=submissions.get(g);
    if(known&&known.pos===pos&&known.index===index&&known.signature===signature&&String(known.versions)===String(versions))return known;
    const refs=[];
    for (const [a,b] of ranges) { if (a%3 || b%3) fail('partial material triangle'); for(let n=a;n<b;n++) refs.push(index?index.getX(n):n); }
    if (!refs.length || refs.length/3>maxTriangles && !mesh.isSkinnedMesh || refs.some(i=>!Number.isSafeInteger(i)||i<0||i>=pos.count)) fail('empty, excessive or malformed submitted geometry');
    const result={g,pos,index,refs,signature,versions};submissions.set(g,result);return result;
  }
  function shells(mesh, scene) {
    const s=submitted(mesh,scene), hit=cache.get(s.g);
    if(hit){if(hit.pos!==s.pos||hit.index!==s.index||hit.signature!==s.signature||String(hit.versions)!==String(s.versions))fail('immutable lectern topology changed');return hit.parts;}
    const vertices=new Map(), triangles=[], edges=new Map();
    for(let n=0;n<s.refs.length;n+=3){
      const p=s.refs.slice(n,n+3).map(i=>[s.pos.getX(i),s.pos.getY(i),s.pos.getZ(i)]);
      if(p.some(q=>!finite(q)))fail('nonfinite lectern vertex');
      if(length(cross(sub(p[1],p[0]),sub(p[2],p[0])))<1e-12)continue; // Zero-area bevel joins submit no surface.
      const ids=p.map(q=>{const key=q.map(v=>Math.round(v/1e-7)).join(',');if(!vertices.has(key))vertices.set(key,vertices.size);return vertices.get(key);});
      const id=triangles.length;triangles.push({p,triangle:n/3});
      for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3],key=[Math.min(a,b),Math.max(a,b)].join(':');const list=edges.get(key)??[];list.push({id,direction:a<b?1:-1});edges.set(key,list);}
    }
    if(!triangles.length)fail('lectern has no surface');
    const adjacent=triangles.map(()=>[]);
    for(const list of edges.values()){if(list.length!==2||list[0].direction===list[1].direction)fail('open or ambiguous lectern shell');adjacent[list[0].id].push(list[1].id);adjacent[list[1].id].push(list[0].id);}
    const seen=new Set(),parts=[];
    for(let i=0;i<triangles.length;i++)if(!seen.has(i)){
      const pending=[i],part=[];seen.add(i);
      while(pending.length){const k=pending.pop();part.push(triangles[k]);for(const j of adjacent[k])if(!seen.has(j)){seen.add(j);pending.push(j);}}
      const volume=part.reduce((sum,t)=>sum+dot(t.p[0],cross(t.p[1],t.p[2]))/6,0);
      if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)fail('degenerate lectern shell');parts.push(part);
    }
    if(parts.length>16)fail('excessive lectern shells');cache.set(s.g,{...s,parts});return parts;
  }
  function lectern(layer, scene, entity) {
    const load=drawnLoad(layer,scene,entity), draw=layer.drawn.get(entity), rows=[];
    if(draw.inst){const pool=layer.instancer.pools.get(draw.inst),slot=pool.slots.get(entity);
      pool.meshes.forEach(mesh=>{if(mesh.userData.shadowProxy||!(Array.isArray(mesh.material)?mesh.material.some(materialOn):materialOn(mesh.material)))return;
        const instance=mesh.matrixWorld.clone();mesh.getMatrixAt(slot,instance);rows.push({mesh,matrix:mesh.matrixWorld.clone().multiply(instance),slot});});
    }else draw.obj.traverse(mesh=>{if(mesh.isMesh&&!mesh.userData.shadowProxy&&attached(mesh,scene)&&
      (Array.isArray(mesh.material)?mesh.material.some(materialOn):materialOn(mesh.material)))rows.push({mesh,matrix:mesh.matrixWorld.clone(),slot:null});});
    if(!rows.length)fail('no submitted lectern parts');
    let total=0;
    const parts=rows.flatMap(({mesh,matrix,slot})=>{
      if(!matrix.elements.every(Number.isFinite)||Math.abs(matrix.determinant())<1e-12)fail('invalid actual part transform');
      return shells(mesh,scene).map((part,shell)=>{total+=part.length;if(total>maxTriangles)fail('lectern triangle limit exceeded');
        const triangles=part.map(t=>({...t,p:t.p.map(p=>vector().set(...p).applyMatrix4(matrix).toArray())}));
        return {mesh:mesh.uuid,slot,shell,matrix:matrix.toArray(),triangles,...bounds(triangles.flatMap(t=>t.p))};});
    });
    return {entity,source:load.source,root:load.matrix.toArray(),parts,triangles:total};
  }
  function body(root,scene) {
    bodyGeometry(root,scene);const points=[];
    root.traverse(mesh=>{if(!mesh.isSkinnedMesh||!mesh.userData.bodyDraw||!attached(mesh,scene))return;
      if(!mesh.geometry.index)fail('actual bodyDraw index unavailable');
      const {refs}=submitted(mesh,scene), weights=mesh.geometry.attributes.skinWeight, indices=mesh.geometry.attributes.skinIndex;
      if(!weights||!indices)fail('body skin attribution missing');
      const matrix=mesh.matrixWorld.toArray();
      for(const index of new Set(refs)){
        if(points.length>=maxVertices)fail('body vertex limit exceeded');
        const p=mesh.getVertexPosition(index,vector()).applyMatrix4(mesh.matrixWorld).toArray();if(!finite(p))fail('nonfinite actual body skin');
        let k=0;for(let j=1;j<4;j++)if(weights.getComponent(index,j)>weights.getComponent(index,k))k=j;
        const bone=mesh.skeleton.bones[indices.getComponent(index,k)]?.name??'';
        points.push({p,mesh:mesh.uuid,matrix,index,bone,inferredPart:true,part:/Foot|Toe/.test(bone)?'foot':/Leg/.test(bone)?'leg':'other'});
      }
    });
    if(!points.length)fail('actual submitted bodyDraw skin unavailable');return points;
  }
  // Closest point on the actual triangle, including its edges; no enclosing-box penetration inference.
  function closest(p,[a,b,c]) {
    const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
    if(d1<=0&&d2<=0)return a;
    const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);if(d3>=0&&d4<=d3)return b;
    const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0)return add(a,ab,d1/(d1-d3));
    const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);if(d6>=0&&d5<=d6)return c;
    const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0)return add(a,ac,d2/(d2-d6));
    const va=d3*d6-d5*d4;if(va<=0&&d4-d3>=0&&d5-d6>=0)return add(b,sub(c,b),(d4-d3)/((d4-d3)+(d5-d6)));
    const den=1/(va+vb+vc);return add(add(a,ab,vb*den),ac,vc*den);
  }
  function clearance(points,load) {
    let tests=0,inside=0,uncertain=0,projected=0,worst=null;
    for(const point of points){if(!finite(point.p))fail('nonfinite skin query');let definite=false,boundary=false;
      for(const part of load.parts){if(!nearBox(point.p,part))continue;projected++;
        let angle=0,nearest=null;
        for(const t of part.triangles){if(++tests>maxTests)fail('narrowphase work limit exceeded');
          const surface=closest(point.p,t.p),distance=length(sub(point.p,surface));if(!nearest||distance<nearest.distance)nearest={distance,surface,triangle:t.triangle};
          const [a,b,c]=t.p.map(p=>sub(p,point.p)),la=length(a),lb=length(b),lc=length(c);
          angle+=2*Math.atan2(dot(a,cross(b,c)),la*lb*lc+dot(a,b)*lc+dot(b,c)*la+dot(c,a)*lb);
        }
        if(nearest.distance<=uncertaintyM){boundary=true;continue;}
        const winding=Math.abs(angle/(4*Math.PI));if(Math.min(winding,Math.abs(winding-1))>1e-5)fail('ambiguous lectern containment');
        if(winding>.5){definite=true;const witness={vertex:point,surface:nearest.surface,distanceM:nearest.distance,triangle:nearest.triangle,
          part:{mesh:part.mesh,slot:part.slot,shell:part.shell,matrix:part.matrix}};
          if(!worst||witness.distanceM>worst.distanceM)worst=witness;}
      }
      inside+=Number(definite);uncertain+=Number(boundary&&!definite);
    }
    return {status:inside?'definite-vertex-penetration':uncertain?'surface-uncertain':'no-interior-vertex-detected',vertices:points.length,insideVertices:inside,
      surfaceUncertainVertices:uncertain,projectedPartOverlaps:projected,triangleTests:tests,worst,uncertaintyM,
      qualification:'actual visible skin vertices against closed drawn lectern shells; witness distance is to the nearest triangle of its containing shell, not an exact union penetration depth; projected overlap alone is not penetration; vertex-only, not complete triangle intersection or native contact certification'};
  }
  return {body,lectern,clearance,limits:{maxVerticesPerBody:maxVertices,maxLecternTriangles:maxTriangles,maxTriangleTestsPerBody:maxTests,
    maxLecternShells:16,weldToleranceM:1e-7,uncertaintyM}};
}

export function conferenceFixtures({ lecterns, questions, benches }) {
  assert.equal(lecterns.length, 1, 'conference-proof requires one authored presentation lectern');
  assert.equal(questions.length, 1, 'conference-proof requires one authored question stand');
  assert.equal(benches.length, 2, 'conference-proof requires two authored audience benches');
  return { lecture: lecterns[0].id, question: questions[0].id,
    benches: [...benches].sort((a, b) => a.name.localeCompare(b.name)).map(n => n.id) };
}

// Same FNV phase mapping as production activity-poses.ts; this is timing metadata, never a pose input.
export function conferenceObservation(frame, soul) {
  assert(Number.isFinite(frame?.tick) && Number.isFinite(frame.dt) && frame.dt > 0 && Number.isFinite(frame.renderFrame), 'conference depicted clock missing');
  const matches = frame.souls?.filter(s => s.id === soul) ?? [];
  assert.equal(matches.length, 1, 'conference presenter mapping missing or ambiguous');
  const entity = matches[0].entityId, resident = frame.residents?.find(r => r.id === soul && r.body === entity);
  assert(resident && frame.entities?.[entity], 'conference presenter not depicted');
  const partner = frame.entities[entity].state?.partner;
  const phaseID = typeof partner === 'string' && partner < entity ? partner : entity;
  let h = 2166136261;
  for (let i = 0; i < phaseID.length; i++) h = Math.imul(h ^ phaseID.charCodeAt(i), 16777619);
  const phase = (((frame.tick * frame.dt + ((h >>> 0) % 10007) / 10007 * 7) * .23) % 3 + 3) % 3;
  return { at: frame.at, tick: frame.tick, renderFrame: frame.renderFrame, entity, activity: resident.activity,
    renderActivityAge: resident.activityAge, phase: Math.floor(phase),
    seated: frame.entities[entity].state?.baseActivity === 'sit' && frame.entities[entity].state?.seatHeight > 0 };
}
export function conferenceJourney(frames, soul) {
  assert(frames.length >= 2, 'conference depicted samples missing');
  const observed = frames.map(f => conferenceObservation(f, soul));
  assert(observed.at(-1).tick > observed[0].tick && observed.at(-1).renderFrame > observed[0].renderFrame, 'conference depicted clock stale');
  const phases = new Set(observed.filter(f => f.activity === 'tell-story').map(f => f.phase));
  assert(phases.size === 3, 'conference one-hand/two-hand/rest story phases not all depicted');
  for (const action of ['point', 'clap']) assert(observed.some(f => f.activity === action), `conference ${action} never depicted`);
  const lastGesture = observed.findLastIndex(f => ['tell-story', 'point', 'clap'].includes(f.activity));
  const settled = observed.slice(lastGesture + 1);
  assert(settled.length >= 2 && settled.at(-1).tick > settled[0].tick, 'conference settled endpoint not depicted');
  return { phases: [...phases].sort(), firstTick: observed[0].tick, lastTick: observed.at(-1).tick, entity: observed[0].entity };
}

// These are observations of the page's public depicted state, not inputs to its animation.
export function conferenceMeetingStage(frames, stages, event) {
  const starts = {
    'attend-done': 'attend-start', 'story-complete': 'story-start',
    'seated-wave-done': 'seated-wave-start', 'rise-done': 'rise-start',
    point: 'tell-story', settled: 'tell-story', 'question-posted': 'question-start',
    'introduction-done': 'introduction-start', 'conference-clean': 'applause-start',
  };
  const before = stages.slice(0, stages.indexOf(event));
  const start = starts[event.stage] && before.findLast(s => s.stage === starts[event.stage] && s.soul === event.soul);
  if (starts[event.stage]) assert(start, `conference ${event.stage} has no command-start marker`);
  const window = frames.slice(start?.frameIndex ?? event.frameIndex, event.endFrameIndex === undefined ? undefined : event.endFrameIndex + 1);
  assert(window.length >= 2, `conference ${event.stage} depicted samples missing`);
  assert(window.at(-1).tick > window[0].tick && window.at(-1).renderFrame > window[0].renderFrame,
    `conference ${event.stage} depicted clock stale`);
  const person = soul => window.map(frame => conferenceObservation(frame, soul));
  const seen = event.soul ? person(event.soul) : [];
  const after = predicate => {
    const index = seen.findLastIndex(predicate), tail = seen.slice(index + 1);
    assert(index >= 0 && tail.length >= 2 && tail.at(-1).tick > tail[0].tick, `conference ${event.stage} return not depicted`);
    return tail;
  };
  switch (event.stage) {
    case 'lectern-ready':
      assert(seen.at(-1).activity === 'idle' && !seen.at(-1).seated, 'standing lectern not depicted'); break;
    case 'attend-done': {
      const sat = seen.findIndex(s => s.seated && s.activity === 'sit');
      assert(sat > 0 && seen.slice(0, sat).some(s => !s.seated), 'conference sit entry not depicted');
      assert(seen.at(-1).seated && seen.at(-1).activity === 'sit', 'conference seated endpoint missing'); break;
    }
    case 'lecture-ready':
      for (const soul of event.listeners) assert(person(soul).at(-1).seated, 'conference listener not seated'); break;
    case 'story-complete':
      assert(after(s => s.activity === 'tell-story').every(s => s.activity === 'idle'), 'conference normal story return missing'); break;
    case 'tell-story': {
      const current = seen.at(-1);
      assert(current.activity === 'tell-story' && Number.isFinite(current.renderActivityAge) && current.renderActivityAge < 1.5,
        'conference started story not currently depicted'); break;
    }
    case 'point': assert(seen.some(s => s.activity === 'point'), 'conference replacement point not depicted'); break;
    case 'settled':
      for (const action of ['point', 'clap']) assert(seen.some(s => s.activity === action), `conference next ${action} not depicted`);
      assert(after(s => s.activity === 'clap').every(s => s.activity === 'idle'), 'conference next-action rest missing'); break;
    case 'seated-wave-done': {
      const tail = after(s => s.activity === 'wave');
      assert(seen.filter(s => s.activity === 'wave').every(s => s.seated), 'wave lost underlying seat');
      assert(tail.every(s => s.seated && s.activity === 'sit'), 'seated gesture did not return seated'); break;
    }
    case 'rise-done': {
      const tail = seen.slice(-2);
      assert(seen.some(s => s.seated) && tail.length === 2 && tail[1].tick > tail[0].tick &&
        tail.every(s => s.activity === 'idle' && !s.seated), 'conference rise from seat not depicted'); break;
    }
    case 'question-posted':
      assert(seen.some(s => s.activity === 'operate' && !s.seated), 'standing question action not depicted'); break;
    case 'introduction-done':
      assert(seen.some(s => s.activity === 'point') && person(event.guest).some(s => s.activity === 'bow'),
        'conference introduction gestures not depicted'); break;
    case 'conference-clean':
      for (const soul of event.seats) {
        const participant = person(soul);
        assert(participant.some(s => s.activity === 'clap'), 'conference group applause not depicted');
        const tail = participant.slice(-2);
        assert(tail.length === 2 && tail.every(s => s.activity === 'idle' && !s.seated) && tail[1].tick > tail[0].tick,
          'conference final standing rest not depicted');
      }
      break;
    default: throw Error(`unknown conference observation stage ${event.stage}`);
  }
  return { stage: event.stage, firstTick: window[0].tick, lastTick: window.at(-1).tick };
}

export function conferenceMeetingJourney(frames, stages, seats) {
  assert.equal(seats.length, 5, 'conference meeting requires five participants');
  const counts = { 'attend-done': 8, 'lectern-ready': 2, 'lecture-ready': 2, 'story-complete': 2,
    'seated-wave-done': 1, 'rise-done': 8, point: 1, settled: 1,
    'question-posted': 1, 'question-refused': 1, 'question-recovered': 1, 'introduction-done': 1, 'conference-clean': 1 };
  for (const [stage, count] of Object.entries(counts)) assert.equal(stages.filter(s => s.stage === stage).length, count,
    `conference ${stage} stage coverage incomplete`);
  const assemblies = stages.filter(s => s.stage === 'assembly-start');
  assert.equal(assemblies.length, 2, 'conference both assemblies must be captured');
  assert.notEqual(assemblies[0].soul, assemblies[1].soul, 'conference handover must change speaker');
  for (let i = 0; i < assemblies.length; i++) {
    const from = stages.indexOf(assemblies[i]), to = i + 1 < assemblies.length ? stages.indexOf(assemblies[i + 1]) : stages.length;
    assert.deepEqual(stages.slice(from, to).filter(s => s.stage === 'attend-done').map(s => s.soul).sort(),
      [...assemblies[i].listeners].sort(), 'conference entry coverage must name every listener in that assembly');
  }
  for (const event of stages) if (event.observed) conferenceMeetingStage(frames, stages, event);
  assert(stages.filter(e => counts[e.stage] && !['question-refused', 'question-recovered'].includes(e.stage)).every(e => e.observed),
    'conference depicted stage unfinished');
  const refused = stages.find(s => s.stage === 'question-refused');
  assert(refused.answer?.can === 'no' && refused.answer.reason === 'already_linked' && refused.answer.says === 'question_pending',
    'conference unrelated refusal cannot qualify question recovery');
  assert(stages.indexOf(stages.find(s => s.stage === 'question-recovered')) > stages.indexOf(refused), 'conference recovery precedes refusal');
  return { people: seats.length, entryTransitions: 8, rises: 8, question: 'posted-refused-recovered', presentations: 2,
    firstTick: frames[0].tick, lastTick: frames.at(-1).tick };
}

/** Ordinary creator proof: the edit's returned name is the only identity used for readback. */
export async function proveConferenceCreator({ creator, record = () => {}, signal }) {
  const cli = async (...words) => {
    signal?.throwIfAborted(); const answer = await creator.cli(...words);
    record({ person: creator.label, words, answer });
    assert.equal(answer.ok, true, `conference creator ${words[0]}: ${answer.code ?? 'refused'}`);
    return answer;
  };
  let described, kinds, grounds;
  for (const until = Date.now() + 10000;;) {
    described = await cli('describe');
    kinds = Object.keys(described.kinds ?? {}).filter(kind => kind.split('@')[0] === 'eden:conference_question');
    grounds = (described.nodes ?? []).filter(node => /^(?:[a-z][a-z0-9_-]*:)?ground$/.test(node.kind.split('@')[0]));
    if (kinds.length && grounds.length) break;
    assert(Date.now() < until, 'conference creator copy never lists the boot family kind and ground');
    await new Promise(ok => setTimeout(ok, 100));
  }
  assert.equal(kinds.length, 1, 'conference creator family revision must be unambiguous');
  assert.equal(grounds.length, 1, 'conference creator ground must be unambiguous');
  const kind = kinds[0], ground = grounds[0].id;
  const kindName = /^(eden:conference_question)@[^@]+$/.exec(kind)?.[1];
  assert(kindName, 'conference creator catalogue must expose a qualified kind revision');
  // Declared once: flat, unused ground outside the demonstration area. Never retry a refused placement elsewhere.
  const place = await cli('place', kind, '--in', String(ground), '--at', '12,0,12');
  assert(Number.isSafeInteger(place.sequence) && place.sequence > 0, 'conference creator terminal edit sequence missing');
  assert.deepEqual(Object.keys(place.names ?? {}), ['1'], 'conference creator place must return exactly its named thing');
  const id = place.names['1']; assert(typeof id === 'string' && id, 'conference creator returned no placed identity');
  const readback = await cli('describe', id);
  assert.equal(readback.id, id, 'conference creator readback changed the returned identity');
  // Ordinary describe <id> exposes the plain name; the qualified catalogue and
  // accepted place request retain the selected revision separately.
  assert.equal(readback.kind, kindName, 'conference creator readback changed the selected kind name');
  assert.equal(String(readback.in?.[0]?.id), String(ground), 'conference creator readback is in another parent');
  assert.deepEqual(readback.at, [12, 0, 12], 'conference creator readback differs from the declared placement');
  return { kind, readbackKind: readback.kind, readbackRevision: 'unproved: public describe exposes no revision', id, parent: ground, at: readback.at, sequence: place.sequence,
    qualification: 'ordinary describe/place/readback receipt; selected revision evidenced by catalogue and accepted place, not independently exposed by node readback; boot furniture supplies the clip, post-boot drawing is not claimed' };
}

export async function prepare({ base, paths, recipe, signal }) {
  requireConferenceRecipe(recipe);
  const state = { paths, signal, rows: [], seats: [] };
  states.set(paths.dir, state);
  state.record = row => state.rows.push({ at: Date.now(), ...row });
  const worldPage = await conferenceWorldPage({ base, signal });
  state.worldPage = worldPage;
  const bundle = await downloadConferenceClient({ base: worldPage, paths, signal });
  state.seats = await Promise.all(names.map((name, index) => pairConferenceSeat({
    recipe, paths, bundle, label: `conference-${index}`, name, signal,
  })));
  const find = async (words, kind) => {
    const answer = await state.seats[0].cli('find', words);
    state.record({ person: state.seats[0].label, words: ['find', words], answer });
    assert.equal(answer.ok, true, 'conference-proof ordinary fixture discovery');
    return (answer.found ?? []).filter(n => n.kind.split('@')[0] === kind);
  };
  const [lecterns, questions, benches] = await Promise.all([
    find('presentation-lectern', 'eden:hall_lecture'), find('question-stand', 'eden:conference_question'), find('audience', 'eden:bench'),
  ]);
  state.fixtures = conferenceFixtures({ lecterns, questions, benches });
  const nativeLecture = await conferencePublicLecture({ paths, recipe, nativeLecture: state.fixtures.lecture });
  save(paths, 'command-conference-native-lectern.json', nativeLecture);
  state.lecternBinding = await conferenceNativeLectureBinding({ checkout: recipe.checkout, nativeLecture: state.fixtures.lecture, node: nativeLecture, name: lecterns[0].name });
  state.discovery = await discoverConference({ seat: state.seats[0], ...state.fixtures, record: state.record });
  state.creator = await pairConferenceCreator({ recipe, paths, bundle, signal });
  state.creatorProof = await proveConferenceCreator({ creator: state.creator, record: state.record, signal });
  save(paths, 'command-conference-creator.json', state.creatorProof);
  save(paths, 'command-conference-discovery.json', { fixtures: state.fixtures, discovery: state.discovery, rows: state.rows,
    servedClient: JSON.parse(readFileSync(join(paths.dir, 'conference-served-client.json'), 'utf8')) });
  return { people: state.seats.length, fixtures: state.fixtures };
}

// This exact self-contained function is serialized into the page; focused tests exercise the same stop body.
export function conferenceBrowserStop() {
  const observer = window.__conferenceDrawObserver;
  if (!observer) return undefined;
  if (observer.stopped) {
    if (observer.stopError) throw observer.stopError;
    return observer.stopResult;
  }
  observer.stopped = true;
  try {
    observer.stopRender();
    if (observer.prototype.show !== observer.show) throw Error('conference people observer ownership changed');
    observer.prototype.show = observer.original;
    const measurementSummary = observer.samples.reduce((summary, sample) => {
      const ms = sample.measurementMs;
      if (!Number.isFinite(ms) || ms < 0) { summary.missing++; return summary; }
      summary.count++; summary.totalMs += ms; summary.maxMs = Math.max(summary.maxMs ?? 0, ms); return summary;
    }, { count: 0, totalMs: 0, maxMs: null, missing: 0, basis: 'retained successful samples; failed callbacks are not timed' });
    return observer.stopResult = { cadenceMs: 250, sampleLimit: observer.sampleLimit, meshStride: 1,
      samples: observer.samples, failures: observer.failures, measurementSummary,
      lecternEntry: observer.lecternEntry, measurementLimits: observer.measurementLimits, qualification: observer.qualification };
  } catch (error) { observer.stopError = error; throw error; }
}

export function conferenceFinalization(page, paths, state) {
  state.persistSequence = () => {
    if (state.sequenceSaved) return;
    save(paths, 'command-conference-sequence.json', {
      qualification: 'ordinary fixed-sequence conference diagnostic; independent-agent, creator and actual visual/contact acceptance remain separate',
      stage: 'before-observer-collection',
      result: state.result ?? null, failure: state.failure ?? null, rows: state.rows,
      depictedJourney: state.depictedJourney ?? null, stages: state.stages ?? [],
      frameReads: state.frameReads ?? [], frameReadErrors: state.frameReadErrors ?? [], finalizationError: state.finalizationError ?? null,
    });
    state.sequenceSaved = true;
  };
  state.finalizeDraw = () => state.drawFinalization ??= (async () => {
    // Preserve command receipts first. Returning a rejected cached promise never calls browser stop twice.
    state.persistSequence();
    try {
      const draw = await page.evaluate(conferenceBrowserStop);
      assert(draw || !state.observerInstalled, 'conference installed observer collection missing');
      if (draw) {
        save(paths, 'command-conference-final-draw.json', draw);
        assert(draw.samples?.length >= 2 && draw.failures?.length === 0, 'conference final collection missing or failed');
      }
      state.finalizationOutcome = { ok: Boolean(draw), samples: draw?.samples?.length ?? 0, failures: draw?.failures ?? [], reason: draw ? null : 'observer not installed' };
    } catch (error) {
      state.finalizationOutcome = { ok: false, error: String(error) }; throw error;
    } finally {
      save(paths, 'command-conference-finalization.json', state.finalizationOutcome);
    }
  })();
}

export async function beforeNavigation({ paths, page, base }) {
  const state = states.get(paths.dir);
  const oracleURL = new URL('/__proof/conference-oracle.mjs', base).href;
  const oracle = readFileSync(new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url), 'utf8');
  await page.route(oracleURL, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: oracle }));
  state.oracleURL = oracleURL;
  const geometryURL = new URL('/__proof/conference-clearance.mjs', base).href;
  await page.route(geometryURL, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `export ${conferenceClearanceTools.toString()}\nexport ${conferenceLecternIdentity.toString()}` }));
  state.geometryURL = geometryURL;
  const entryBytes = readFileSync(new URL('../../../content/kinds/hall/lecture.json', import.meta.url));
  state.lecternEntry = { kind: JSON.parse(entryBytes).kind, sha256: createHash('sha256').update(entryBytes).digest('hex') };
  const response = r => { if (new URL(r.url()).origin === new URL(base).origin && /\/people-kit-[^/]+\.js$/.test(new URL(r.url()).pathname)) state.kitURL = r.url(); };
  page.on('response', response);
  conferenceFinalization(page, paths, state);
  return async () => {
    page.off('response', response);
    try { if (!page.isClosed()) await state.finalizeDraw(); }
    finally {
      try { state.persistSequence(); }
      finally { try { await page.unroute(oracleURL); } finally { try { await page.unroute(geometryURL); } finally { states.delete(paths.dir); } } }
    }
  };
}

export default async function ({ page, paths, check, expectHttp, signal }) {
  const state = states.get(paths.dir); assert(state, 'conference-proof preparation missing');
  expectHttp('/safety.md', 404, 'The old-page fixture does not route this optional standalone client document.');
  const url = new URL(page.url()); url.search = 'post=0&hour=12:00&eye=6,3.5,6&at=0,1,2';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.viewer-history[data-viewer-ready="true"]') && !document.querySelector('.viewer-arrival'), null, { timeout: 30000 });
  const snapshot = async label => writeFileSync(join(paths.dir, `conference-accessibility-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  await nativeCameraMode(page, 'manual', snapshot);
  await snapshot('escape'); await page.keyboard.press('Escape');
  const bounds = await page.locator('canvas').first().boundingBox();
  check('conference-canvas-drawn', !!bounds && bounds.width > 100 && bounds.height > 100);
  await page.screenshot({ path: join(paths.dir, 'conference-setup.png') });
  signal.throwIfAborted();
  assert(state.kitURL, 'conference production people kit not observed');
  const identity = await page.evaluate(async ({ oracleURL, geometryURL, binding }) => {
    const { drawnLoad } = await import(oracleURL);
    const { conferenceLecternIdentity } = await import(geometryURL);
    return conferenceLecternIdentity(window.__soulsEntity, binding, drawnLoad);
  }, { oracleURL: state.oracleURL, geometryURL: state.geometryURL, binding: state.lecternBinding });
  save(paths, 'command-conference-lectern-identity.json', identity);
  assert(identity.ok, identity.error);
  await page.evaluate(async ({ oracleURL, geometryURL, kitURL, souls, entry, binding }) => {
    const { observeRender, bodyGeometry, drawnLoad } = await import(oracleURL);
    const { conferenceClearanceTools } = await import(geometryURL);
    const { TakePeople } = await import(kitURL), prototype = TakePeople.prototype;
    const world = window.__soulsEntity, original = prototype.show;
    if (!world || !original || window.__conferenceDrawObserver) throw Error('conference final-draw observer unavailable');
    const { conferenceLecternIdentity } = await import(geometryURL);
    const identity = conferenceLecternIdentity(world, binding, drawnLoad);
    if (!identity.ok) throw Error(identity.error);
    const lecternEntity = identity.witness.matched.id;
    const geometry = conferenceClearanceTools({ vector: () => world.camera.position.clone(), drawnLoad, bodyGeometry });
    let people, previous = -Infinity;
    function show(...args) { const result = original.apply(this, args); people = this; return result; }
    prototype.show = show;
    const samples = [], failures = [], sampleLimit = Math.ceil(90000 / 250) + 1;
    const stopRender = observeRender(world.renderer, world, stamp => {
      const at = performance.now(); if (at - previous < 250) return; previous = at;
      if (samples.length >= sampleLimit) throw Error('conference final-draw90s sample limit exceeded');
      if (!people?.bodyObject) throw Error('conference visible body mesh interface missing');
      const frame = world.gameFrame(), diagnostics = world.contactFrame().bones;
      const lectern = geometry.lectern(world.layer, world.scene, lecternEntity);
      const bodies = souls.map(soul => {
        const matches = frame.souls.filter(s => s.id === soul);
        if (matches.length !== 1) throw Error('conference final-draw identity missing or ambiguous');
        const entity = matches[0].entityId, root = people.bodyObject(entity);
        const points = geometry.body(root, world.scene);
        if (!points.length || points.some(q => q.p.length !== 3 || !q.p.every(Number.isFinite))) throw Error('conference final-draw skin missing');
        const bounds = group => {
          if (!group.length) throw Error('conference empty skin group');
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], low = [], high = [];
          for (const q of group) for (let i = 0; i < 3; i++) {
            if (q.p[i] < min[i]) { min[i] = q.p[i]; low[i] = q.p; }
            if (q.p[i] > max[i]) { max[i] = q.p[i]; high[i] = q.p; }
          }
          return { vertices: group.length, min, max, extrema: { low, high } };
        };
        const legs = points.filter(q => q.part === 'leg'), feet = points.filter(q => q.part === 'foot');
        if (!legs.length || !feet.length) throw Error('conference feet or legs missing');
        const anchors = diagnostics?.[entity]?.feet;
        if (!Array.isArray(anchors) || anchors.length !== 2 || anchors.some(p => p.length !== 3 || !p.every(Number.isFinite))) throw Error('conference both foot identities missing');
        const sides = [[], []];
        for (const q of feet) {
          const distance = anchor => q.p.reduce((sum, n, i) => sum + (n - anchor[i]) ** 2, 0);
          sides[distance(anchors[0]) <= distance(anchors[1]) ? 0 : 1].push(q);
        }
        return { soul, entity, root: root.matrixWorld.toArray(), bounds: bounds(points), legs: bounds(legs), feet: bounds(feet),
          lecternClearance: geometry.clearance(points, lectern),
          // Inferred nearest-rendered-ankle clusters; these are not native contact/rig vertex-side identities.
          footClusters: sides.map((group, index) => ({ inferred: true, nearestRenderedAnkleIndex: index, anchor: anchors[index], ...bounds(group) })),
          activity: frame.entities[entity]?.activity };
      });
      samples.push({ stage: 'after-world-render', units: 'm', at, frame: stamp.frame, tick: frame.tick, dt: frame.dt,
        currentCanvas: stamp.canvas === world.renderer.domElement && stamp.canvas.isConnected, renderTarget: null,
        lectern: { entity: lectern.entity, source: lectern.source, root: lectern.root, triangles: lectern.triangles,
          parts: lectern.parts.map(({mesh,slot,shell,matrix})=>({mesh,slot,shell,matrix})) }, bodies, measurementMs: performance.now() - at });
    }, error => { if (failures.length < 30) failures.push(String(error)); });
    window.__conferenceDrawObserver = { samples, failures, sampleLimit, stopRender, prototype, show, original,
      measurementLimits: geometry.limits,
      lecternEntry: { ...entry, ...binding, entity: lecternEntity, identity: identity.witness, association: 'validated public native node, actual product layerDraws/NodeRec.origin or CreatorKinds entityId; exact scene id/def and visibly attached drawn geometry; native name is checked separately, streamSnapshot Entity.name is optional; canonical entry bytes are provenance, drawn triangles own the measurement' },
      qualification: 'actual visible indexed bodyDraw vertices measured; bounded extrema/lectern vertex-inside witnesses every250ms, not every-frame or complete triangle-intersection proof; inferred skin/foot groups are not native identities; no native contact certification; original full-body video remains required. Historical story clips used hidden-source primitive extrema and did not measure actual lectern clearance.' };
  }, { oracleURL: state.oracleURL, geometryURL: state.geometryURL, kitURL: state.kitURL, souls: state.seats.map(s => s.soul),
    entry: state.lecternEntry, binding: state.lecternBinding });
  state.observerInstalled = true;
  state.frameReads = []; state.frameReadErrors = []; state.stages = [];
  let reading = true;
  const readFrames = (async () => {
    while (reading && !signal.aborted) {
      try {
        const frame = await page.evaluate(() => {
          const world = window.__soulsEntity;
          if (!world?.gameFrame || !world?.residents) throw Error('conference read-only page diagnostics unavailable');
          const frame = world.gameFrame();
          return { observation: 'read between draws; not a final-draw contact measurement', at: performance.now(),
            renderFrame: world.renderer.info.render.frame, tick: frame.tick, dt: frame.dt, worldSeconds: world.worldSeconds,
            souls: frame.souls, residents: world.residents(), entities: frame.entities, bones: frame.bones };
        });
        frame.receivedAt = Date.now(); state.frameReads.push(frame);
      } catch (error) { state.frameReadErrors.push(String(error)); break; }
      await new Promise(ok => setTimeout(ok, 150));
    }
  })();
  try {
    const immediate = new Set(['assembly-start', 'attend-start', 'story-start', 'seated-wave-start', 'rise-start',
      'question-start', 'question-refused', 'question-recovered', 'departure-start', 'introduction-start', 'applause-start']);
    const observe = async (stage, details = {}) => {
      const event = { stage, at: Date.now(), frameIndex: Math.max(0, state.frameReads.length - 1),
        soul: details.seat?.soul, body: details.seat?.body, person: details.seat?.label,
        listeners: details.listeners?.map(s => s.soul), guest: details.guest?.soul,
        seats: details.seats?.map(s => s.soul), sequence: details.sequence, answer: details.answer };
      state.stages.push(event);
      if (immediate.has(stage)) return;
      // Existing bounded observer: admission, short takes or a stalled page remain failures.
      for (const until = Date.now() + 2500;;) {
        assert.equal(state.frameReadErrors.length, 0, 'conference page observation failed');
        const last = state.frameReads.at(-1);
        try {
          assert(last && Date.now() - last.receivedAt < 500, 'conference page observation stale');
          conferenceMeetingStage(state.frameReads, state.stages, event);
          event.observed = true; event.endFrameIndex = state.frameReads.length - 1; return;
        } catch (error) {
          assert(Date.now() < until, `conference ${stage} not observed on advancing page: ${error.message}`);
        }
        signal.throwIfAborted(); await new Promise(ok => setTimeout(ok, 50));
      }
    };
    state.result = await performConference({ seats: state.seats, ...state.fixtures, record: state.record,
      storyRepeats: 1, interruptStory: true, interruptFirstOnly: true, observe });
    state.depictedJourney = conferenceMeetingJourney(state.frameReads, state.stages, state.seats);
    const draw = await page.evaluate(() => ({ samples: window.__conferenceDrawObserver?.samples.length, failures: window.__conferenceDrawObserver?.failures }));
    assert(draw.samples >= 2 && draw.failures?.length === 0, 'conference final-draw measurement missing or failed');
    signal.throwIfAborted();
    check('conference-meeting-depicted', state.result.presentations === 2 && state.result.interruptedStories === 1 && state.result.handover,
      'Ordinary receipts and advancing depicted entry, seated gesture/return, rise, questions/recovery, handover and cleanup; natural limbs/contact remain visual acceptance.');
    await page.screenshot({ path: join(paths.dir, 'conference-completion.png') });
  } catch (error) { state.failure = String(error.stack ?? error); throw error; }
  finally {
    reading = false; await readFrames;
    try { await state.finalizeDraw(); }
    catch (error) { state.finalizationError = String(error); throw error; }
    finally { state.persistSequence(); }
  }
}
