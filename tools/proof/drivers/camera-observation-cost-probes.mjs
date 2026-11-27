/** Serialized into the owned page only; never installed on the normal product path. */
export function installPageCostProbe() {
 const maximum=2048,resources=[],longTasks=[];let overflow=false,callbackMs=0,stopped=false;const observers=[];
 const observer=(type,output)=>{try{const collect=entries=>{if(stopped)return;const start=performance.now();for(const e of entries){if(output.length>=maximum){overflow=true;break;}output.push(type==='resource'?{at:e.startTime,duration:e.duration,initiator:e.initiatorType,transferBytes:e.transferSize,encodedBytes:e.encodedBodySize,decodedBytes:e.decodedBodySize}:{at:e.startTime,duration:e.duration});}callbackMs+=performance.now()-start;};const o=new PerformanceObserver(list=>collect(list.getEntries()));o.observe({type,buffered:true});observers.push({observer:o,flush:()=>collect(o.takeRecords())});return true;}catch{return false;}};
 const supported={resource:observer('resource',resources),longtask:observer('longtask',longTasks)};
 globalThis.__cameraCostPageProbe={read:()=>{for(const o of observers)o.flush();return{supported,resources:[...resources],longTasks:[...longTasks],overflow,callbackMs,scope:'Main-page ResourceTiming and LongTask entries only; zero transfer bytes cannot distinguish cache from unavailable cross-origin sizes. Worker/network process totals are not inferred.'};},stop:()=>{for(const o of observers)o.flush();stopped=true;for(const o of observers)o.observer.disconnect();}};
}
/** Empirical clock/no-op noise probe, bounded independently of timer precision. Run outside the sample window. */
export function clockCostProbe() {
 const start=performance.now(),steps=[],pairs=[];let previous=start,zero=0,reads=0;
 for(let i=0;i<8192&&performance.now()-start<8;i++){const before=performance.now(),after=performance.now(),delta=after-previous;reads++;if(delta>0)steps.push(delta);else if(delta===0)zero++;else throw Error('camera-cost-nonmonotone-clock');pairs.push(after-before);previous=after;}
 steps.sort((a,b)=>a-b);pairs.sort((a,b)=>a-b);return{reads,elapsedMs:performance.now()-start,minimumPositiveStepMs:steps[0]??null,maximumObservedStepMs:steps.at(-1)??null,zeroReads:zero,noopMedianMs:pairs.length?pairs[Math.ceil(pairs.length*.5)-1]:null,noopP95Ms:pairs.length?pairs[Math.ceil(pairs.length*.95)-1]:null,scope:'Empirical resolution and no-op noise outside the sampled phase, not a guaranteed clock-error bound or a quiet-machine certification'};
}
export function sampledWitnessValid(witness,rows,start,end,{expectation='represented'}={}) {
 if(!witness||witness.phase!=='sample'||witness.status!=='complete'||!witness.equal||!witness.scene?.history)return false;
 if(!['absent','represented'].includes(expectation))return false;
 const sceneMatches=expectation==='absent'?witness.scene.subjects===0&&witness.scene.represented===0:witness.scene.subjects>0&&witness.scene.represented>0;
 const row=rows.find(r=>r[0]===witness.sequence);
 return!!row&&row[2]>=start&&row[2]<=end&&row[55]===1&&row[56]===witness.scene.seek&&row[3]===witness.scene.tick&&sceneMatches;
}
/** Frozen strict screening rule, not pixel equivalence or a license to subtract noisy process totals. */
export const CAMERA_PAIR_TOLERANCES=Object.freeze({cadenceSeconds:1,nearestSeconds:.05,positionMetres:.25,orientationDegrees:1,projectionElement:.005});
export function compareCameraTraces(a,b,{fromTick,sampleSeconds,tickSeconds=.05}={}){
 if(!Number.isFinite(fromTick)||!Number.isInteger(sampleSeconds)||sampleSeconds<1||sampleSeconds>180||tickSeconds!==.05)throw Error('camera-cost-comparison-declaration');
 const tolerance=CAMERA_PAIR_TOLERANCES,failures=[];let compared=0;const nearest=(rows,tick)=>{let best;for(const r of rows)if(!best||Math.abs(r.tick-tick)<Math.abs(best.tick-tick))best=r;return best&&Math.abs(best.tick-tick)*tickSeconds<=tolerance.nearestSeconds?best:null;};
 for(let s=0;s<sampleSeconds;s++){const tick=fromTick+(s+.5)/tickSeconds,x=nearest(a,tick),y=nearest(b,tick);if(!x||!y){failures.push({second:s,reason:'missing-matched-source-frame'});continue;}compared++;if(x.shot!==y.shot){failures.push({second:s,reason:'director-choice-or-shot-drift'});continue;}const p=x.cameraWorld,q=y.cameraWorld;if(p.length!==16||q.length!==16||x.projection.length!==16||y.projection.length!==16)throw Error('camera-cost-comparison-layout');const distance=Math.hypot(p[12]-q[12],p[13]-q[13],p[14]-q[14]),dot=[0,1,2,4,5,6,8,9,10].reduce((sum,i)=>sum+p[i]*q[i],0),angle=Math.acos(Math.max(-1,Math.min(1,(dot-1)/2)))*180/Math.PI,projection=Math.max(...x.projection.map((v,i)=>Math.abs(v-y.projection[i])));if(!Number.isFinite(distance+angle+projection)||distance>tolerance.positionMetres||angle>tolerance.orientationDegrees||projection>tolerance.projectionElement)failures.push({second:s,reason:'trajectory-drift',distance,angle,projection});}
 return{comparable:failures.length===0,compared,expected:sampleSeconds,tolerance,failures,scope:'One matched actual frame per source second; all bins must pass. Sparse screening is not every-frame/pixel equivalence. Reject whole-browser cost comparison on any mismatch; direct observer spans remain separately scoped.'};
}
