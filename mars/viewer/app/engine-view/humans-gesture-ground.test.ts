import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createRig, libAction, templateFromGltf} from './people.ts';
import {CHARACTER_WIRE} from './character-wire.ts';
import {clipTime, libraryPick, pickClip} from './clip-library.ts';
import {ankleLocal, legsOf} from './rig.ts';
import {HumanViews, setHumanGround, type SampledHuman} from './humans.ts';
import {activityFrame, idPhase} from './activity-poses.ts';
import {blendFrames} from './posture-transition.ts';

// Production meshes and each rig's actual CHARACTER_WIRE clip pack, not ankle-only diagnostics.
const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
async function template(name: string) {
  const loader = new GLTFLoader();
  loader.register(() => ({name:'gesture-test-material', loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const read = async (file:string) => {const b=await readFile(rigDir+'/'+file);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
  const wire=CHARACTER_WIRE[name as keyof typeof CHARACTER_WIRE];assert(wire);
  const mesh=await read(wire.mesh), clips=await read(wire.clips);
  mesh.animations=clips.animations;
  return templateFromGltf(name,mesh);
}

type Skin = Record<string,{count:number;min:number}>;
function skin(views:HumanViews,id:string):Skin {
  const result:Skin={};
  views.bodyObject(id)!.traverse(object=>{
    const mesh=object as THREE.SkinnedMesh;
    if(!mesh.isSkinnedMesh||mesh.userData.bodyDraw)return;
    const positions=mesh.geometry.getAttribute('position'),indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
    if(!positions||!indices||!weights)return;
    const p=new THREE.Vector3();
    for(let i=0;i<positions.count;i++) {
      let k=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,k))k=j;
      const bone=mesh.skeleton.bones[indices.getComponent(i,k)]?.name??'';
      const part=/^(Foot|Toe)/.test(bone)?'foot':/^(UpperLeg|LowerLeg)/.test(bone)?'leg':null;
      const side=/L$/.test(bone)?'L':/R$/.test(bone)?'R':null;
      if(!part||!side)continue;
      mesh.getVertexPosition(i,p).applyMatrix4(mesh.matrixWorld);
      const row=result[part+side]??={count:0,min:Infinity};row.count++;row.min=Math.min(row.min,p.y);
    }
  });
  for(const part of ['footL','footR','legL','legR'])assert((result[part]?.count??0)>100,part+' must sample actual nonempty production skin');
  return result;
}

const distance=(a:ReturnType<HumanViews['meshPoints']>,b:ReturnType<HumanViews['meshPoints']>)=>Math.max(...a.map((v,i)=>Math.hypot(...v.p.map((x,j)=>x-b[i].p[j]))));

test('storytelling phrase changes stay continuous on standing and seated production rigs',async t=>{
  setHumanGround(()=>0);
  try {
    for(const name of ['casual','woman'])for(const base of ['idle','sit'])await t.test(name+' '+base,async()=>{
      const views=new HumanViews();views.setTemplates([await template(name)]);
      const id='storytelling-'+name,root:[number,number,number]=[1,0,-1];
      const draw=(seconds:number,extra:Partial<SampledHuman>={})=>{
        views.setFrame([{id,p:root,yaw:.35,walk:0,walkDist:0,activity:'tell-story',baseActivity:base,
          activityAge:30,...(base==='sit'?{seatHeight:.45}:{}),...extra}],seconds);
        views.render(1);assert.deepEqual(root,[1,0,-1]);
        assert.deepEqual(views.bodyObject(id)!.position.toArray(),root,'the gesture cannot relocate the native root');
        return views.meshPoints(id,1);
      };
      try {
        let maxBoundary=0,maxStep=0;
        for(let phrase=1;phrase<=3;phrase++){
          const seconds=phrase/.23-idPhase(id)*7;
          maxBoundary=Math.max(maxBoundary,distance(draw(seconds-1e-5),draw(seconds+1e-5)));
          const minima=skin(views,id);
          for(const side of ['L','R'])assert(minima['foot'+side].min>=.001,'both feet stay above ground at a phrase boundary');
        }
        assert(maxBoundary<.002,'an internal phrase boundary moves body skin '+maxBoundary+' m');
        let before=draw(0);
        for(let i=1;i<=Math.ceil(3/.23*60);i++){
          const after=draw(i/60);maxStep=Math.max(maxStep,distance(before,after));before=after;
        }
        assert(maxStep<.04,'one storytelling frame moves body skin '+maxStep+' m at 60 Hz');
        const first=draw(1);draw(9);assert(distance(first,draw(1))<1e-5,'a backwards seek preserves the same production pose');
        draw(1,{hands:{left:[1.1,1.15,-.8]}});
        const arm=views.bones()[id].arms.find(a=>a.side==='left')!;
        assert.equal(arm.source,'hands');assert.equal(arm.err,0);assert.deepEqual(arm.palm,[1.1,1.15,-.8],'native hand targets retain authority');
        t.diagnostic(JSON.stringify({maxBoundary,maxStep}));
      } finally {views.clear();}
    });
  } finally {setHumanGround(null);}
});

test('free standing gesture skin uses ground support without moving the authoritative root',async t=>{
  setHumanGround(()=>0);
  try {
    for(const name of ['casual','woman']) {
      const source=await template(name);
      for(const activity of ['nod','wave','shrug','tell-story','clap'])await t.test(name+' '+activity,()=>{
        const views=new HumanViews();views.setTemplates([source]);
        const id='grounded-gesture-'+name, minima:Record<string,number>={};
        try {
          for(let step=0;step<=40;step++) {
            const age=step*.05,p:[number,number,number]=[1,0,-1];
            const person:SampledHuman={id,p,yaw:.785,walk:0,walkDist:0,activity,baseActivity:'idle',activityAge:age,
              // Aimed nods have a target too; a target alone does not own a two-body contact.
              ...(activity==='nod'?{partner:'aimed-target'}:{})};
            views.setFrame([person,{id:'aimed-target',p:[2,0,-1],yaw:Math.PI,walk:0,walkDist:0,activity:'idle'}],50+age);views.render(1);
            assert.deepEqual(person.p,[1,0,-1]);
            const hop=activityFrame(activity,'idle',50+age,id,{since:age})?.hop??0;
            assert(views.bodyObject(id)!.position.distanceTo(new THREE.Vector3(p[0],p[1]+hop,p[2]))<1e-8,'only the existing authored cosmetic hop may offset the unchanged authoritative root');
            const rows=skin(views,id);for(const [part,row]of Object.entries(rows))minima[part]=Math.min(minima[part]??Infinity,row.min);
          }
          t.diagnostic(name+' '+activity+' minimum skin metres '+JSON.stringify(minima));
          // Existing ordinary support fits to +3 mm. Keep a positive lower bound, not the floor-palm allowance.
          for(const side of ['L','R']) {
            assert(minima['foot'+side]>=.001,activity+' '+side+' foot skin '+minima['foot'+side]+' must retain the near-ground fit target');
            assert(minima['leg'+side]>=-.001,activity+' '+side+' leg skin '+minima['leg'+side]+' penetrates terrain');
          }
        } finally {views.clear();}
      });
    }
  } finally {setHumanGround(null);}
});

test('dedicated support controls remain random-access and preserve recorded inputs',async()=>{
  const source=await template('casual'),views=new HumanViews();views.setTemplates([source]);setHumanGround(()=>0);
  const id='gesture-support-control';
  const controls:Partial<SampledHuman>[]=[
    {activity:'nod',baseActivity:'sit',seatHeight:.45},
    {activity:'pushups',activityAge:1.2},
    {activity:'stargaze',activityAge:2},
    {activity:'walk',walk:1,walkDist:1.3,speed:1},
    {activity:'jump',activityAge:.4},
    {activity:'pick-up',activityAge:.7},
    {activity:'handshake',activityAge:.7,partner:'contact-partner'},
    {activity:'nod',activityAge:.7,prop:'cup'},
    {activity:'nod',activityAge:.7,hands:{left:[1.1,1.15,-.8]}},
    {activity:'reach',activityAge:.7,hands:{left:[1.8,0,-.8]}},
  ];
  const draw=(control:Partial<SampledHuman>,time=70)=>{
    const p:[number,number,number]=[1,0,-1],person:SampledHuman={id,p,yaw:.25,walk:0,walkDist:0,...control};
    views.setFrame([person,{id:'contact-partner',p:[1.85,0,-1],yaw:Math.PI,walk:0,walkDist:0,activity:'handshake',activityAge:.7,partner:id}],time);views.render(1);
    assert.deepEqual(p,[1,0,-1]);skin(views,id);
    return views.meshPoints(id,1);
  };
  try {
    let jumpTime=70;for(let t=70;t<71;t+=.02)if((activityFrame('jump','jump',t,id)?.hop??0)>.30){jumpTime=t;break;}
    draw({activity:'jump',activityAge:.4},jumpTime);
    const airborne=skin(views,id);assert(airborne.footL.min>.2&&airborne.footR.min>.2,'an authored airborne cycle must keep both feet airborne');
    for(const owner of [{prop:'cup'}, {handHold:{with:'contact-partner',hand:'left',since:0} as SampledHuman['handHold'],handGameTick:1400,handGameDt:.05}]) {
      draw({activity:'idle',...owner});const feet=skin(views,id);
      assert(feet.footL.min>=.001&&feet.footR.min>=.001,'ordinary idle support remains eligible while a cup or hand-hold owns the hands');
    }
    // Compact clean-source support witnesses: these owners must not be rerouted through standing support.
    draw(controls[0]);
    const seated=views.bones()[id];
    assert.equal(seated.hipY,.54,'the existing .45 m seat owns the pelvis offset');
    assert.deepEqual(seated.feet,[[1.4612,.1137,-1.0675],[1.3624,.1141,-.681]],'seat foot placement stays byte-for-byte at the clean-source readout');
    draw(controls[8]);
    const native=views.bones()[id].arms.find(a=>a.side==='left')!;
    assert.equal(native.source,'hands');assert.equal(native.contact,1);assert.equal(native.err,0);
    assert.deepEqual(native.palm,[1.1,1.15,-.8]);assert.deepEqual(native.target,native.palm);
    assert.equal(blendFrames(activityFrame('handshake','idle',70,id,{since:.7}),null,.75)?.pairedContact,true,'a physical contact keeps support ownership until its last blend contribution is gone');
    draw(controls[6]);
    const paired=views.bones()[id].arms.find(a=>a.side==='right')!;
    assert.equal(paired.source,'expression');assert.equal(paired.contact,1);assert.equal(paired.err,0);
    assert.deepEqual(paired.palm,[1.4737,1.0036,-.9292],'the paired contact retains its clean-source target');
    assert.deepEqual(paired.target,paired.palm);
    draw(controls[9]);
    const kneeling=views.bones()[id];
    assert.equal(kneeling.pose.kneel,1,'a real low native hand target selects the dedicated kneeling support');
    assert.deepEqual(kneeling.feet,[[.5395,.11,-1.2316],[1.042,.0231,-.6796]],'the knee/foot support pair retains its clean-source placement');
    for(const control of controls) {
      const before=draw(control);draw({activity:'wave',activityAge:.6},72);
      assert(distance(before,draw(control))<1e-5,control.activity+' must not inherit support from a previously sampled free gesture');
    }
  } finally {views.clear();setHumanGround(null);}
});


test('free support remains continuous through the authored gesture cycle and airborne release',async t=>{
  const views=new HumanViews();views.setTemplates([await template('woman')]);setHumanGround(()=>0);
  const id='gesture-support-continuity';
  const draw=(age:number,activity='nod')=>{
    const p:[number,number,number]=[0,0,0];
    views.setFrame([{id,p,yaw:0,walk:0,walkDist:0,activity,baseActivity:'idle',activityAge:age}],20+age);views.render(1);
    assert.deepEqual(p,[0,0,0]);
    return views.meshPoints(id,1).filter(p=>p.part==='leg'||p.part==='foot');
  };
  try {
    let max=0,before=draw(0);
    for(let i=1;i<=240;i++){
      const after=draw(i/120);max=Math.max(max,distance(before,after));before=after;
    }
    t.diagnostic('maximum supported lower-body displacement per 1/120 second '+max);
    assert(max<.01,'support must not switch knee planes or snap when a sole enters/leaves its correction');
    // Probe actual anatomical support handoffs separately from the authored clip's keyframe steps.
    const ratio=(time:number,name:string)=>{draw(time,'pick-up');const bone=views.bodyObject(id)!.getObjectByName(name)!;
      const dims=views.bones()[id].dims!;return bone.getWorldPosition(new THREE.Vector3()).y/(name.startsWith('Upper')?dims.hipH:dims.shin);};
    let boundaries=0;
    for(const [bone,levels]of [['UpperLegL',[.6,.8]],['UpperLegR',[.6,.8]],['LowerLegL',[.25,.75]],['LowerLegR',[.25,.75]]] as const) {
      for(const level of levels)for(let i=1;i<=90;i++) {
        let lo=(i-1)/60,hi=i/60,sign=ratio(lo,bone)-level;
        if(sign*(ratio(hi,bone)-level)>=0)continue;
        for(let k=0;k<18;k++){const mid=(lo+hi)/2;if(sign*(ratio(mid,bone)-level)>0)lo=mid;else hi=mid;}
        const time=(lo+hi)/2,delta=distance(draw(time-1e-5,'pick-up'),draw(time+1e-5,'pick-up'));
        assert(delta<.004,bone+' support boundary at '+time+' moves skin '+delta+' m');boundaries++;
      }
    }
    assert(boundaries>0,'the authored kneeling clip must actually enter/leave the support classifier');
    const first=draw(.7);draw(1.3,'jump');assert(distance(first,draw(.7))<1e-5,'airborne release does not leave support state behind');
  } finally {views.clear();setHumanGround(null);}
});


test('fractional support adds no attachment error to the authored foot-to-shin offset',async t=>{
  const source=await template('woman'),rest=createRig(source),authored=createRig(source);
  rest.idle.setEffectiveWeight(1);rest.idle.time=0;rest.mixer.update(0);rest.holder.updateMatrixWorld(true);
  const ankles=legsOf(rest).map(leg=>ankleLocal(leg).clone());
  const pick=libraryPick({activity:'pick-up',base:'idle',seated:false,ground:false,speaking:false,speed:0})!;
  const action=libAction(authored,pickClip(pick,'gesture-support-continuity'))!;
  authored.mixer.stopAllAction();action.play();action.setEffectiveWeight(1);
  const views=new HumanViews();views.setTemplates([source]);setHumanGround(()=>0);
  const id='gesture-support-continuity';let partial=0,corrected=0,maxAuthored=0,maxError=0;
  const boundary=.22631553014119465,ages=[boundary-1e-5,boundary+1e-5,...Array.from({length:91},(_,step)=>step/60)];
  try {
    for(const [sample,age]of ages.entries()) {
      action.time=Math.min(action.getClip().duration-1e-7,clipTime(pick,action.getClip().duration,20+age,id,age));
      authored.mixer.update(0);authored.holder.updateMatrixWorld(true);
      const baseline=legsOf(authored),dims=views.bones()[id]?.dims;
      views.setFrame([{id,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'pick-up',baseActivity:'idle',activityAge:age}],20+age);views.render(1);
      const holder=views.bodyObject(id)!,measured=dims??views.bones()[id].dims!;
      const smooth=(x:number)=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
      const weight=Math.min(...baseline.flatMap(leg=>[smooth((leg.upper.getWorldPosition(new THREE.Vector3()).y/measured.hipH-.6)/.2),smooth((leg.lower.getWorldPosition(new THREE.Vector3()).y/measured.shin-.25)/.5)]));
      if(sample>=2&&(weight<=0||weight>=1))continue;
      if(weight>0&&weight<1)partial++;
      for(const [index,leg]of baseline.entries()) {
        const offset=leg.foot.getWorldPosition(new THREE.Vector3()).sub(leg.lower.localToWorld(ankles[index].clone()));
        const side=index===0?'L':'R',lower=holder.getObjectByName('LowerLeg'+side)!,foot=holder.getObjectByName('Foot'+side)!;
        const upper=holder.getObjectByName('UpperLeg'+side)!;
        const moved=upper.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(leg.upper.getWorldQuaternion(new THREE.Quaternion()).normalize())>1e-5
          ||lower.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(leg.lower.getWorldQuaternion(new THREE.Quaternion()).normalize())>1e-5;
        maxAuthored=Math.max(maxAuthored,offset.length());
        if(sample<2||!moved) {
          for(const [drawn,raw]of [[upper,leg.upper],[lower,leg.lower],[foot,leg.foot]]) {
            assert(drawn.getWorldPosition(new THREE.Vector3()).distanceTo(raw.getWorldPosition(new THREE.Vector3()))<1e-5,'a no-op fit preserves the authored endpoint at '+age+' '+side);
            assert(drawn.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(raw.getWorldQuaternion(new THREE.Quaternion()).normalize())<1e-5,'a no-op fit preserves authored orientation');
          }
        } else {
          corrected++;
          const expected=lower.localToWorld(ankles[index].clone()).addScaledVector(offset,1-weight);
          const error=expected.distanceTo(foot.getWorldPosition(new THREE.Vector3()));
          maxError=Math.max(maxError,error);
          assert(error<1e-5,'corrected support preserves authored attachment offset: age '+age+' '+side+' error '+error);
        }
      }
      assert.deepEqual(holder.position.toArray(),[0,0,0],'support never relocates the authoritative root');
    }
    assert(partial>0,'the actual authored trajectory must cross fractional support');
    assert(corrected>0,'the trajectory must include an actual corrected fractional leg');
    t.diagnostic(JSON.stringify({partial,corrected,maxAuthored,maxError}));
  } finally {views.clear();rest.mixer.stopAllAction();authored.mixer.stopAllAction();setHumanGround(null);}
});
