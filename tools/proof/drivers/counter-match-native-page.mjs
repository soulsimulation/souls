// Fixed three-Soul diagnostic on the unchanged owned native-page runner. No world/browser lifecycle here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehearseCounterMatch, counterTable } from '../../playtest/games/rehearse.mjs';
import { downloadConferenceClient, pairConferenceSeat, pairConferenceCreator, requireConferenceRecipe } from '../../playtest/conference/owned-seats.mjs';
import { conferenceClearanceTools } from './conference-native-page.mjs';
import { nativeCameraMode } from './camera-native-page.mjs';
const states = new Map(), names = ['Aster', 'Birch', 'Clover'];
const save = (paths, name, value) => writeFileSync(join(paths.dir, name), JSON.stringify(value, null, 2), {flag:'wx',mode:0o600});
export const counterCaptureMs = 90000; // Existing owned runner enforces the same ceiling including navigation.

/** The public export retains names and origins; stream-scene entities retain origins, not names. */
export function counterBootBoard(facts) {
  assert.equal(facts.format,'souls/import-eden/1','counter public export format missing');
  const rows=facts.things?.filter(t=>t.name==='counter-match')??[];
  assert.equal(rows.length,1,'counter boot board missing or ambiguous');
  const row=rows[0];assert.match(row.id,/^e_[a-z0-9]{4,12}$/,'counter boot origin missing');
  assert.equal(row.def,'core-counter_match@1');assert.equal(row.ref,row.def);
  const kinds=facts.kinds?.filter(k=>k.ref===row.def)??[];
  assert.equal(kinds.length,1,'counter boot definition missing or ambiguous');assert.equal(kinds[0].name,'core:counter_match');
  assert.equal(row.parent,null);assert.deepEqual(row.pose,[3000,0,0,0]);assert.deepEqual(row.world,[3000,0,0,0]);assert.equal(row.scale_ppm,1000000);
  return {origin:row.id,def:row.def,p:[3,0,0],r:0,definitionName:'core-counter_match',definitionVersion:1};
}

/** Self-contained for the served observer: never select by absent names or fall back to a creator's board. */
export function counterSceneBoard(model,boot) {
  const fail=why=>{throw Error(`counter drawn board: ${why}`);},entity=model.entities.get(boot.origin);
  if(!entity||entity.id!==boot.origin)fail('boot origin missing');
  const def=model.resolvedDef(entity.def);
  if(entity.def!==boot.def||def?.ref!==boot.def||def?.name!==boot.definitionName||def?.version!==boot.definitionVersion)fail('boot definition differs');
  if(entity.by!=='v2'||entity.in?.parent!=='world'||JSON.stringify(entity.p)!==JSON.stringify(boot.p)||entity.r!==boot.r)fail('boot pose differs');
  return entity.id;
}

export function counterWorldPage(catalog, base) {
  const rows=catalog.worlds?.filter(w=>w.name==='Counter match rehearsal'&&w.template==='counter-match-rehearsal')??[];
  assert.equal(rows.length,1,'counter public world discovery missing or ambiguous');
  const page=new URL(rows[0].url,base);
  assert(page.origin===new URL(base).origin&&/^\/w\/[a-z][a-z0-9-]*\/$/.test(page.pathname),'counter page outside owned origin');
  page.search='';page.hash='';return page.href;
}

/** Reads actual attached role meshes. Current EntityInstancer excludes role subtrees; never read its hidden prototype. */
export function counterDrawTools({vector,drawnLoad,maxVertices=10000}) {
  const fail=why=>{throw Error(`counter drawn state: ${why}`);};
  const attached=(o,scene)=>{for(;o;o=o.parent){if(!o.visible)return false;if(o===scene)return true;}return false;};
  return (layer,scene,entity) => {
    const load=drawnLoad(layer,scene,entity),draw=layer.drawn.get(entity);
    if(draw.inst)fail('unexpected instanced role identity unavailable; actual slot validated, hidden prototype is not evidence');
    const roles={};draw.obj.traverse(o=>{if(['fill','light'].includes(o.userData.role)){if(roles[o.userData.role])fail('ambiguous role');roles[o.userData.role]=o;}});
    if(!roles.fill||!roles.light)fail('fill/light role missing');
    const inverse=load.matrix.clone().invert();
    const read=(root,role)=>{
      if(!attached(root,scene))fail('role hidden or detached');
      const rest=root.userData.looksRest?.scale;
      if(!rest||rest.length!==3||rest.some(n=>!Number.isFinite(n)||n===0))fail('role rest scale unavailable');
      const points=[],materials=[],matrices=[];
      root.traverse(mesh=>{
        if(mesh.isInstancedMesh)fail('nested instanced role geometry unsupported; base geometry is not submitted-instance evidence');
        if(!mesh.isMesh||mesh.userData.shadowProxy||!attached(mesh,scene))return;
        const g=mesh.geometry,pos=g?.attributes.position,index=g?.index,count=index?.count??pos?.count;
        if(!pos||!Number.isInteger(count)||count>maxVertices*12)fail('submitted role geometry unavailable or excessive');
        const start=g.drawRange.start,end=Math.min(count,start+g.drawRange.count),ranges=[];
        if(!Number.isInteger(start)||start<0||start%3||!Number.isFinite(end)||end%3)fail('invalid submitted role range');
        const on=m=>m?.visible&&m.opacity>0&&m.colorWrite!==false;
        const add=(material,a,b)=>{if(!on(material))return;ranges.push([a,b]);if(!material.color)fail('actual role color unavailable');materials.push(material.color.getHexString());};
        if(Array.isArray(mesh.material))for(const group of g.groups)add(mesh.material[group.materialIndex],Math.max(start,group.start),Math.min(end,group.start+group.count));
        else add(mesh.material,start,end);
        const indices=new Set();for(const[a,b]of ranges){if(a%3||b%3)fail('partial submitted triangle');for(let n=a;n<b;n++)indices.add(index?index.getX(n):n);}
        if(!mesh.matrixWorld.elements.every(Number.isFinite))fail('nonfinite actual role matrix');
        matrices.push({mesh:mesh.uuid,matrix:mesh.matrixWorld.toArray(),drawRange:{start,end},vertices:indices.size});
        for(const i of indices){if(points.length>=maxVertices||!Number.isInteger(i)||i<0||i>=pos.count)fail('role vertex bound exceeded');
          const p=mesh.getVertexPosition(i,vector()).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse).toArray();
          if(!p.every(Number.isFinite))fail('nonfinite submitted role point');points.push(p);}
      });
      if(!points.length||!materials.length)fail('role has no submitted geometry/material');
      return {role,vertices:points.length,spanX:Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0])),
        scale:root.scale.toArray(),restScale:rest,relativeScale:root.scale.toArray().map((n,i)=>n/rest[i]),materials:[...new Set(materials)],matrices};
    };
    return {entity,source:load.source,root:load.matrix.toArray(),fill:read(roles.fill,'fill'),light:read(roles.light,'light'),
      qualification:'actual attached submitted role vertices/transforms/materials; current role-bearing subtrees cannot instance; unexpected instanced role identity fails closed'};
  };
}

export function counterDrawCheckpoint(samples,{remaining,turn,afterIndex=0,settled=false}) {
  const rows=samples.slice(afterIndex);
  assert(rows.length>=2&&rows.at(-1).tick>rows[0].tick&&rows.at(-1).frame>rows[0].frame,'counter final-draw clock missing or stale');
  const tail=rows.slice(-2),scale=Math.trunc(remaining*1000/7)/1000,color=turn==='first'?'bb493e':'3d6baf';
  for(const sample of tail){
    assert(sample.currentCanvas&&sample.bodies.length===3,'counter full group draw missing');
    assert.equal(sample.state?.remaining,remaining,'counter drawn remaining differs from inspect');assert.equal(sample.state?.turn,turn,'counter drawn turn differs from inspect');
    assert(Math.abs(sample.board.fill.relativeScale[0]-scale)<1e-6,'counter actual fill scale differs from state');
    assert(Math.abs(sample.board.fill.spanX-.665*scale)<.0001,'counter submitted fill width differs from state');
    assert.deepEqual(sample.board.light.materials,[color],'counter submitted turn light differs from state');
    if(settled)assert(sample.bodies.every(b=>b.activity==='idle'),'counter final rest not depicted');
  }
  return {firstTick:rows[0].tick,lastTick:rows.at(-1).tick,samples:rows.length,remaining,turn};
}

export async function proveCounterCreator({creator,record=()=>{},signal}) {
  const cli=async(...words)=>{signal?.throwIfAborted();const answer=await creator.cli(...words);record({person:creator.label,words,answer});assert.equal(answer.ok,true,`counter creator ${words[0]} refused`);return answer;};
  let described,kinds,grounds;
  for(const until=Date.now()+10000;;){
    described=await cli('describe');kinds=Object.keys(described.kinds??{}).filter(k=>k.split('@')[0]==='eden:counter_match');
    grounds=(described.nodes??[]).filter(n=>/^(?:[a-z][a-z0-9_-]*:)?ground$/.test(n.kind.split('@')[0]));
    if(kinds.length&&grounds.length)break;assert(Date.now()<until,'counter creator boot kind/ground unavailable');await new Promise(ok=>setTimeout(ok,100));
  }
  assert.equal(kinds.length,1,'counter creator kind ambiguous');assert.equal(grounds.length,1,'counter creator ground ambiguous');
  const kind=kinds[0];assert.match(kind,/^eden:counter_match@1220[a-f0-9]{64}$/,'counter creator revision-qualified kind missing');
  const parent=grounds[0].id,place=await cli('place',kind,'--in',String(parent),'--at','12,0,12');
  assert(Number.isSafeInteger(place.sequence)&&place.sequence>0,'counter creator edit sequence missing');
  assert.deepEqual(Object.keys(place.names??{}),['1'],'counter creator place identity ambiguous');
  const id=place.names['1'];assert(typeof id==='string'&&id,'counter creator place identity missing');
  const readback=await cli('describe',id);assert.equal(readback.id,id);assert.equal(readback.kind,'eden:counter_match');
  assert.equal(String(readback.in?.[0]?.id),String(parent));assert.deepEqual(readback.at,[12,0,12]);
  return {kind,readbackKind:readback.kind,id,parent,at:readback.at,sequence:place.sequence,qualification:'ordinary registry discovery and place use the exact revision-qualified key; returned-ID describe proves plain kind, parent and position, not revision; boot board supplies the clip, post-boot drawing not claimed'};
}

export async function prepare({base,paths,recipe,signal}) {
  requireConferenceRecipe(recipe);const state={rows:[],stages:[]};states.set(paths.dir,state);
  state.record=row=>state.rows.push({at:Date.now(),...row});
  const bootBytes=readFileSync(join(paths.data,'world','genesis.facts.json'));
  const bootFacts=JSON.parse(bootBytes);state.bootBoard=counterBootBoard(bootFacts);
  save(paths,'command-counter-boot-origin.json',{...state.bootBoard,publicExportSHA256:createHash('sha256').update(bootBytes).digest('hex'),
    exported:{format:bootFacts.format,kinds:bootFacts.kinds.filter(k=>k.ref===state.bootBoard.def),things:bootFacts.things.filter(t=>t.id===state.bootBoard.origin)}});
  const response=await fetch(new URL('/__sim/worlds.json',base),{signal});assert.equal(response.status,200);
  const worldPage=counterWorldPage(await response.json(),base),bundle=await downloadConferenceClient({base:worldPage,paths,signal});
  state.seats=await Promise.all(names.map((name,i)=>pairConferenceSeat({recipe,paths,bundle,label:`counter-${i}`,name,signal})));
  const found=await state.seats[0].cli('find','counter-match');state.record({person:state.seats[0].label,words:['find','counter-match'],answer:found});
  state.nativeBoard=counterTable(found).id;
  state.creator=await pairConferenceCreator({recipe,paths,bundle,signal});
  state.creatorProof=await proveCounterCreator({creator:state.creator,record:state.record,signal});save(paths,'command-counter-creator.json',state.creatorProof);
  return {people:3,nativeBoard:state.nativeBoard};
}

export function counterBrowserStop(){
  const observer=window.__counterDrawObserver;if(!observer)return undefined;
  if(observer.stopped){if(observer.stopError)throw observer.stopError;return observer.stopResult;}observer.stopped=true;
  try{observer.stopRender();if(observer.prototype.show!==observer.show)throw Error('counter people observer ownership changed');observer.prototype.show=observer.original;
    const measurementSummary=observer.samples.reduce((s,row)=>{if(!Number.isFinite(row.measurementMs)||row.measurementMs<0)throw Error('counter measurement timing missing');s.count++;s.totalMs+=row.measurementMs;s.maxMs=Math.max(s.maxMs,row.measurementMs);return s;},{count:0,totalMs:0,maxMs:0,basis:'retained successful samples; failed callbacks are not timed'});
    return observer.stopResult={samples:observer.samples,failures:observer.failures,measurementSummary,cadenceMs:250,sampleLimit:observer.sampleLimit,qualification:observer.qualification};
  }catch(error){observer.stopError=error;throw error;}
}
export function counterFinalization(page,paths,state){
  state.persist=()=>{if(state.saved)return;save(paths,'command-counter-sequence.json',{rows:state.rows,stages:state.stages,result:state.result??null,failure:state.failure??null,qualification:'fixed ordinary diagnostic, not independent agents or physical contact acceptance'});state.saved=true;};
  state.finalize=()=>state.finalization??=(async()=>{state.persist();try{
    const draw=await page.evaluate(counterBrowserStop);assert(draw||!state.observerInstalled,'counter installed draw collector missing');
    if(draw){save(paths,'command-counter-final-draw.json',draw);assert(draw.samples.length>=2&&draw.failures.length===0,'counter final-draw collection failed');}
    state.outcome={ok:!!draw,samples:draw?.samples.length??0,journeyFailure:state.failure??null,finalizationFailure:null};
  }catch(error){state.outcome={ok:false,error:String(error),journeyFailure:state.failure??null,finalizationFailure:String(error.stack??error)};throw error;}finally{save(paths,'command-counter-finalization.json',state.outcome);}})();
}

export async function counterJourney(state,perform) {
  let primary;
  try{return await perform();}
  catch(error){primary=error;state.failure=String(error.stack??error);throw error;}
  finally{try{await state.finalize();}catch(secondary){
    if(primary)throw new AggregateError([primary,secondary],'counter journey and finalization both failed',{cause:primary});
    throw secondary;
  }}
}

export async function beforeNavigation({paths,page,base}) {
  const state=states.get(paths.dir);assert(state,'counter preparation missing');
  const oracleURL=new URL('/__proof/counter-oracle.mjs',base).href,geometryURL=new URL('/__proof/counter-geometry.mjs',base).href;
  await page.route(oracleURL,route=>route.fulfill({status:200,contentType:'text/javascript',body:readFileSync(new URL('../../playtest/carry-contact/oracle.mjs',import.meta.url),'utf8')}));
  await page.route(geometryURL,route=>route.fulfill({status:200,contentType:'text/javascript',body:`export ${conferenceClearanceTools.toString()}\nexport ${counterDrawTools.toString()}\nexport ${counterSceneBoard.toString()}`}));
  Object.assign(state,{oracleURL,geometryURL});const response=r=>{if(new URL(r.url()).origin===new URL(base).origin&&/\/people-kit-[^/]+\.js$/.test(new URL(r.url()).pathname))state.kitURL=r.url();};
  page.on('response',response);counterFinalization(page,paths,state);
  return async()=>{page.off('response',response);try{if(!page.isClosed())await state.finalize();}finally{try{state.persist();}finally{try{await page.unroute(oracleURL);}finally{try{await page.unroute(geometryURL);}finally{states.delete(paths.dir);}}}}};
}

export default async function({page,paths,check,expectHttp,signal}){
  const state=states.get(paths.dir);assert(state,'counter preparation missing');
  expectHttp('/safety.md',404,'The old-page fixture does not route this optional standalone client document.');
  const url=new URL(page.url());url.search='post=0&hour=12:00&eye=-6,4.5,2.2&at=1.5,.8,0';
  await page.goto(url.href,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.viewer-history[data-viewer-ready="true"]')&&!document.querySelector('.viewer-arrival'),null,{timeout:30000});
  const snapshot=async label=>writeFileSync(join(paths.dir,`counter-accessibility-${label}.yml`),await page.locator('body').ariaSnapshot(),{flag:'wx'});
  await nativeCameraMode(page,'manual',snapshot);await snapshot('escape');await page.keyboard.press('Escape');
  await page.screenshot({path:join(paths.dir,'counter-setup.png')}); // Actual full-body/both-feet framing requires root's visual inspection.
  assert(state.kitURL,'counter production people kit missing');
  await page.evaluate(async({oracleURL,geometryURL,kitURL,souls,bootBoard})=>{
    const {observeRender,bodyGeometry,drawnLoad}=await import(oracleURL),{conferenceClearanceTools,counterDrawTools,counterSceneBoard}=await import(geometryURL),{TakePeople}=await import(kitURL);
    const world=window.__soulsEntity,prototype=TakePeople.prototype,original=prototype.show;
    if(!world||!original||window.__counterDrawObserver)throw Error('counter final-draw interface unavailable');
    const board=counterSceneBoard(world.layer.model,bootBoard),vector=()=>world.camera.position.clone(),geometry=conferenceClearanceTools({vector,drawnLoad,bodyGeometry}),readBoard=counterDrawTools({vector,drawnLoad});
    const samples=[],failures=[],sampleLimit=Math.ceil(90000/250)+1;let people,previous=-Infinity;
    function show(...args){const result=original.apply(this,args);people=this;return result;}prototype.show=show;
    const bounds=points=>{if(!points.length)throw Error('counter empty actual skin group');const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],low=[],high=[];
      for(const{p}of points)for(let i=0;i<3;i++){if(p[i]<min[i]){min[i]=p[i];low[i]=p;}if(p[i]>max[i]){max[i]=p[i];high[i]=p;}}return{vertices:points.length,min,max,extrema:{low,high}};};
    const stopRender=observeRender(world.renderer,world,stamp=>{
      const at=performance.now();if(at-previous<250)return;previous=at;if(samples.length>=sampleLimit)throw Error('counter90s sample limit exceeded');
      if(!people?.bodyObject||!world.residents)throw Error('counter actual body interface missing');
      const frame=world.gameFrame(),residents=world.residents(),bodies=souls.map(soul=>{
        const matches=frame.souls.filter(s=>s.id===soul);if(matches.length!==1)throw Error('counter depicted identity missing or ambiguous');
        const entity=matches[0].entityId,resident=residents.find(r=>r.id===soul&&r.body===entity);if(!resident)throw Error('counter resident missing');
        const root=people.bodyObject(entity),points=geometry.body(root,world.scene),feet=points.filter(p=>p.part==='foot');
        return{soul,entity,activity:resident.activity,root:root.matrixWorld.toArray(),bounds:bounds(points),legs:bounds(points.filter(p=>p.part==='leg')),feet:bounds(feet),
          footGroups:['L','R'].map(side=>({inferred:true,dominantBoneSuffix:side,...bounds(feet.filter(p=>p.bone.endsWith(side)))}))};
      });
      samples.push({at,tick:frame.tick,dt:frame.dt,frame:stamp.frame,currentCanvas:stamp.canvas===world.renderer.domElement&&stamp.canvas.isConnected,
        stage:'after-world-render',units:'m',renderTarget:null,bodies,state:{...world.layer.model.entities.get(board)?.state},board:readBoard(world.layer,world.scene,board),measurementMs:performance.now()-at});
    },error=>{if(failures.length<30)failures.push(String(error));});
    window.__counterDrawObserver={samples,failures,sampleLimit,stopRender,prototype,show,original,qualification:'actual submitted bodyDraw and board-role measurements every250ms; inferred foot groups; no every-frame, skin/table/hand contact, unrestricted stand admission or independent-agent certification'};
  },{oracleURL:state.oracleURL,geometryURL:state.geometryURL,kitURL:state.kitURL,souls:state.seats.map(s=>s.soul),bootBoard:state.bootBoard});
  state.observerInstalled=true;let expected,stateReads=0;
  await counterJourney(state,async()=>{
    const observe=async(stage,details)=>{
      if(stage==='departure'){state.stages.push({stage,person:details.seat.label,midRound:details.midRound,at:Date.now()});return;}
      if(stage==='state'){
        expected=details.state;
        if(++stateReads===2){ // After ordinary approaches; continuous real input, never a camera/actor state mutation.
          const box=await page.locator('canvas').first().boundingBox();assert(box&&box.width>400&&box.height>400,'counter camera canvas missing');
          await snapshot('formation-orbit-move');await page.mouse.move(box.x+box.width*.4,box.y+box.height*.4);
          await snapshot('formation-orbit-down');await page.mouse.down();
          await snapshot('formation-orbit-drag');await page.mouse.move(box.x+box.width*.4+200,box.y+box.height*.4,{steps:24});
          await snapshot('formation-orbit-up');await page.mouse.up();
          state.stages.push({stage:'camera-orbit',at:Date.now(),qualification:'ordinary pointer orbit in continuous capture; visibility and clearance require visual review'});
        }
      }
      const status=await page.evaluate(()=>window.__counterDrawObserver.samples.length),event={stage,expected,sampleIndex:Math.max(0,status-1),at:Date.now()};state.stages.push(event);
      for(const until=Date.now()+2500;;){signal.throwIfAborted();const draw=await page.evaluate(()=>({samples:window.__counterDrawObserver.samples,failures:window.__counterDrawObserver.failures,now:performance.now()}));
        assert.equal(draw.failures.length,0,'counter actual draw observation failed');assert(draw.samples.at(-1)&&draw.now-draw.samples.at(-1).at<500,'counter final draw stale');
        try{event.observed=counterDrawCheckpoint(draw.samples,{...expected,afterIndex:event.sampleIndex,settled:stage==='clean'});return;}
        catch(error){assert(Date.now()<until,`counter state not depicted: ${error.message}`);}await new Promise(ok=>setTimeout(ok,50));
      }
    };
    state.result=await rehearseCounterMatch({seats:state.seats,name:'counter-match',record:state.record,observe,midRoundDeparture:true});
    check('counter-native-turns-and-drawing',state.result.complete&&state.result.midRoundDeparture&&state.stages.filter(s=>s.observed).length>=10,
      'Ordinary terminal refusals/recovery, authoritative counts, actual submitted fill/light and independent mid-round leave; physical contact remains unproved.');
    await page.screenshot({path:join(paths.dir,'counter-completion.png')});
  });
}
