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
export function sampledWitnessValid(witness,rows,start,end,{requireSubject=true}={}) {
 if(!witness||witness.phase!=='sample'||witness.status!=='complete'||!witness.equal||!witness.scene?.history)return false;
 const row=rows.find(r=>r[0]===witness.sequence);
 return!!row&&row[2]>=start&&row[2]<=end&&row[55]===1&&row[56]===witness.scene.seek&&row[3]===witness.scene.tick&&(!requireSubject||(witness.scene.subjects>0&&witness.scene.represented>0));
}
