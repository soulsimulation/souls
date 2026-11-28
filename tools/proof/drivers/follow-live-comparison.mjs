// Frozen LIVE Follow case: legal commands and normal UI, no source/camera writes.
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeNavigation as observeNavigation,depictedBodyIds} from './camera-observation.mjs';
import {chooseFollow,resetFollow,readFollow,compositionConsistent} from './camera-follow-source.mjs';

let declaration;
export function liveFollowDeclaration(p){
 if(!p||!['legacy','candidate'].includes(p.variant)||p.seconds!==60||p.quietSeconds!==2||p.wallLimitSeconds!==75)throw Error('follow-live-declaration');
 return structuredClone(p);
}
export function landmark(answer,name){
 const all=(answer?.found??[]).filter(x=>x.name===name&&!x.kind?.startsWith('souls:body'));
 const points=all.filter(x=>x.kind===`eden:${name}`||x.kind?.startsWith(`eden:${name}@`));
 const matches=points.length?points:all;
 if(matches.length!==1)throw Error('follow-live-target-ambiguous:'+name);
 return matches[0];
}
export function commandDue(elapsed,issued){
 if(elapsed>=60)return 'complete';
 if(!issued.includes('walk'))return 'walk';
 if(elapsed>=25&&!issued.includes('stop'))return 'stop';
 if(elapsed>=29&&!issued.includes('restart'))return 'restart';
 return null;
}
export function observedAction(elapsed,issued,wallMs){if(!Number.isFinite(wallMs)||wallMs>=75000)throw Error('follow-live-native-stalled');return commandDue(elapsed,issued);}
export function liveRowsValid(rows,ids){
 let epoch=null,tick=-Infinity;
 return rows.length>10&&rows.every(r=>{
  try{const [version,id]=JSON.parse(r.key),identity=JSON.parse(version.epoch);epoch??=version.epoch;
   const valid=identity[2]===false&&version.epoch===epoch&&ids.includes(id)&&r.subject?.id===id&&r.mode==='follow'&&r.tick>=tick;
   tick=r.tick;return valid;
  }catch{return false;}
 });
}
export function phaseEvidence(samples,startTick){
 const phases={walk:[],stop:[],restart:[]};
 for(const s of samples){const seconds=(s.tick-startTick)*.05;if(seconds<0||seconds>60)continue;phases[seconds<25?'walk':seconds<29?'stop':'restart'].push(s);}
 const summary={};
 for(const [name,rows]of Object.entries(phases)){
  let distance=0,walkSeconds=0,idleSeconds=0,maxStep=0,maxGap=0,idleRun=0,longestIdleSeconds=0;
  for(let i=1;i<rows.length;i++){
   const a=rows[i-1],b=rows[i],dt=(b.tick-a.tick)*.05,step=Math.hypot(...b.subject.transform.positionM.map((v,j)=>v-a.subject.transform.positionM[j]));
   maxGap=Math.max(maxGap,b.at-a.at);distance+=step;maxStep=Math.max(maxStep,step);
   const gap=b.at-a.at,ordered=Number.isFinite(dt)&&dt>=0&&dt<=.5&&Number.isFinite(gap)&&gap>0&&gap<=400;
   const activity=s=>s.subject?.activity?.kind;
   if(ordered&&activity(a)==='walk'&&activity(b)==='walk')walkSeconds+=dt;
   if(ordered&&activity(a)==='idle'&&activity(b)==='idle'){idleSeconds+=dt;idleRun+=dt;longestIdleSeconds=Math.max(longestIdleSeconds,idleRun);}else idleRun=0;
  }
  summary[name]={samples:rows.length,nativeSeconds:rows.length?(rows.at(-1).tick-rows[0].tick)*.05:0,distanceM:distance,walkSeconds,idleSeconds,longestIdleSeconds,maxStepM:maxStep,maxObservationGapMs:maxGap};
 }
 return summary;
}
export function observedStop(samples,commands){
 const stop=commands.find(c=>c.kind==='stop')?.before,restart=commands.find(c=>c.kind==='restart')?.before;
 const refused=reason=>({valid:false,reason});if(!stop||!restart||!Number.isFinite(stop.tick)||!Number.isFinite(restart.tick)||restart.tick<=stop.tick)return refused('commands');
 const first=samples.findIndex(s=>s.tick>stop.tick&&s.tick<restart.tick&&s.subject?.activity?.kind==='idle');if(first<0)return refused('no-command-bound-idle');
 const initial=samples[first],id=initial.subject?.id;let previous=initial,distanceM=0,n=1;
 const finite=s=>Number.isFinite(s.tick)&&Number.isFinite(s.at)&&s.subject?.id===id&&s.subject?.transform?.positionM?.length===3&&s.subject.transform.positionM.every(Number.isFinite);
 if(!id||!finite(initial))return refused('invalid-first');
 for(const s of samples.slice(first+1)){
  const dt=(s.tick-previous.tick)*.05,gap=s.at-previous.at;
  if(!finite(s)||dt<0||dt>.5||gap<=0||gap>400)return refused('unsupported-gap-or-identity');
  const activity=s.subject?.activity?.kind;
  if(activity!=='idle'){
   if(activity!=='walk'||s.tick<=restart.tick||previous.tick<restart.tick)return refused('not-depicted-restart');
   const nativeSeconds=(previous.tick-initial.tick)*.05;
   return {valid:true,firstTick:initial.tick,lastTick:previous.tick,restartWalkTick:s.tick,nativeSeconds,longestIdleSeconds:nativeSeconds,distanceM,samples:n,stopCommandTick:stop.tick,restartCommandTick:restart.tick};
  }
  distanceM+=Math.hypot(...s.subject.transform.positionM.map((v,i)=>v-previous.subject.transform.positionM[i]));previous=s;n++;
 }
 return refused('no-supported-restart-walk');
}
export function applicable(summary,stop){return stop?.valid===true&&summary.walk.walkSeconds>=15&&summary.walk.distanceM>10&&stop.nativeSeconds>=3.5&&stop.longestIdleSeconds>=2.5&&stop.distanceM<.5&&summary.restart.walkSeconds>=10&&summary.restart.distanceM>8;}

export async function prepare({recipe,paths}){
 declaration=liveFollowDeclaration(recipe.sourceRecording?.followLive);
 const actor=await recipe.joinActor(),targets={};
 for(const name of ['orchard','plaza']){const answer=await actor.cli('find',name,'--limit','50');targets[name]=landmark(answer,name).id;writeFileSync(join(paths.dir,`follow-live-find-${name}.json`),JSON.stringify(answer,null,2));}
 return {...declaration,actor,targets,ids:depictedBodyIds(actor.body)};
}
export function beforeNavigation(args){
 const stop=observeNavigation(args),goto=args.page.goto.bind(args.page);
 args.page.goto=(url,...rest)=>{const u=new URL(url);u.searchParams.set('camera-follow-test','1');if(declaration.variant==='candidate')u.searchParams.set('camera-follow','experimental');return goto(u.href,...rest);};return stop;
}
export default async function({page,paths,fixture:plan,signal,check,arm}){
 if(arm!==(plan.variant==='candidate'?'candidate':'baseline'))throw Error('follow-live-arm');
 let ui=0,begin=null,end=null,quiet=null,error=null;const samples=[],commands=[],issued=[];
 const save=(name,value)=>writeFileSync(join(paths.dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 const snapshot=async label=>save(`follow-live-ui-${++ui}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 const read=async()=>{const s=await readFollow(page,plan.ids);const source=await page.evaluate(id=>{const f=window.__soulsEntity?.transportFrame();return {transportTick:f?.tick,activity:f?.entities[id]?.activity};},s.subject?.id);return {...s,...source};};
 const command=async(kind,words,before)=>{const reply=await plan.actor.cli(...words),after=await read();commands.push({kind,words,before,after,reply});issued.push(kind);save(`follow-live-command-${commands.length}.json`,commands.at(-1));check('follow-live-command-'+kind,reply.ok===true);if(Number.isSafeInteger(reply.sequence))commands.push({kind:'receipt-'+kind,sequence:reply.sequence,reply:await plan.actor.cli('receipt',String(reply.sequence))});};
 try{
  await chooseFollow(page,snapshot);await page.waitForFunction(()=>typeof window.__followExperiment==='function',null,{timeout:10000});await resetFollow(page,snapshot);
  const initial=await read(),probe=await page.evaluate(()=>{const d=window.__followExperiment();return {enabled:d.enabled,last:d.rows.at(-1),total:d.total,dropped:d.dropped};});
  save('follow-live-start.json',{initial,probe,actor:plan.actor.body,ids:plan.ids,targets:plan.targets,plan:{variant:plan.variant,seconds:60,quietSeconds:2,wallLimitSeconds:75}});
  check('follow-live-start',initial.presentation==='live'&&initial.mode==='follow'&&!!initial.subject&&compositionConsistent(initial)&&probe.last?.subject?.id===initial.subject.id&&probe.enabled===(plan.variant==='candidate'));
  quiet=initial;const quietDeadline=performance.now()+6000;
  while(true){signal.throwIfAborted();const s=await read();samples.push(s);if((s.tick-quiet.tick)*.05>=2)break;if(performance.now()>quietDeadline)throw Error('follow-live-quiet-stalled');await delay(100,null,{signal});}
  begin=await read();save('follow-live-sample-start.json',begin);const wallStart=performance.now();
  while(true){signal.throwIfAborted();const s=await read();samples.push(s);
   if(s.presentation!=='live'||s.mode!=='follow'||s.subject?.id!==initial.subject.id)throw Error('follow-live-input-changed');
   const due=observedAction((s.tick-begin.tick)*.05,issued,performance.now()-wallStart);if(due==='complete'){end=s;break;}
   if(due==='walk')await command(due,['act',plan.targets.orchard],s);
   if(due==='stop')await command(due,['stop'],s);
   if(due==='restart')await command(due,['act',plan.targets.plaza],s);
   await delay(100,null,{signal});
  }
  for(const c of commands.filter(c=>Number.isSafeInteger(c.reply?.sequence)))commands.push({kind:'final-receipt',sequence:c.reply.sequence,reply:await plan.actor.cli('receipt',String(c.reply.sequence))});
 }catch(e){error=String(e);throw e;
 }finally{
  save('follow-live-inputs.json',{quiet,begin,end,samples,commands,error});
  try{const exported=await page.evaluate(()=>{const start=performance.now(),data=window.__followExperiment();return{data,exportMs:performance.now()-start};});save('phase-follow-diagnostics.json',exported);}catch(e){save('follow-live-export-error.json',{error:String(e)});}
 }
 save('follow-live-sample-end.json',end);
 const exported=await page.evaluate(()=>({enabled:window.__followExperiment().enabled,dropped:window.__followExperiment().dropped}));
 const all=JSON.parse(readFileSync(join(paths.dir,'phase-follow-diagnostics.json'),'utf8')).data;
 const rows=all.rows.filter(r=>r.at>=begin.at&&r.at<=end.at),summary=phaseEvidence(samples,begin.tick),stop=observedStop(samples,commands);save('follow-live-phases.json',summary);save('follow-live-observed-stop.json',stop);
 check('follow-live-diagnostics',exported.dropped===0&&liveRowsValid(rows,plan.ids)&&rows.every(r=>r.enabled===(plan.variant==='candidate')));
 check('follow-live-phases',applicable(summary,stop));
 check('follow-live-wall-span',end.at-begin.at<75000);
 check('follow-live-following-ui',await page.getByRole('button',{name:'Following',exact:true}).isVisible());
 await page.screenshot({path:join(paths.dir,'follow-live-final.png')});
}
