import test from 'node:test';import assert from 'node:assert/strict';
import {fluteNotes,pianoNotes,FLUTE_FADE} from '../../../mars/viewer/app/engine-view/piano-score.ts';
import {activityFrame} from '../../../mars/viewer/app/engine-view/activity-poses.ts';
import {FluteAudio} from './gen-mesh/flute-audio.ts';

test('flute melody composes on the unchanged piano clock, with finite entry and partial release',()=>{
 for(const seed of ['flute_a','flute_b']){const a=fluteNotes(seed,100,108);assert.ok(a.length>10);assert.ok(a.every(n=>n.hand===1&&n.midi>=60&&n.midi<=90));assert.deepEqual(a,[...fluteNotes(seed,100,104),...fluteNotes(seed,104,108)]);assert.deepEqual(a.map(n=>[n.t,n.vel]),pianoNotes(seed,100,108).filter(n=>n.hand===1).map(n=>[n.t,n.vel]));}
 const frame=(since:number,released?:number,priorAge?:number)=>activityFrame('play-music','idle',100,'flute',{instrument:'flute',since,released,priorAge})!;
 assert.equal(frame(0).flute?.weight,0);assert.equal(frame(FLUTE_FADE).flute?.weight,1);assert.equal(frame(0,FLUTE_FADE,4).flute?.weight,0);assert.ok(frame(0,.1,.1).flute!.weight<frame(.1).flute!.weight);assert.equal(activityFrame('play-music','idle',100,'drum',{instrument:'drums'})?.flute,undefined);
});
class Param{value=0;setValueAtTime(v:number){this.value=v;}exponentialRampToValueAtTime(v:number){this.value=v;}}
class Node{frequency=new Param();gain=new Param();type='sine';disconnected=false;startAt:number|undefined;connect(_o:unknown){return _o;}start(t:number){this.startAt=t;}stop(_t:number){}disconnect(){this.disconnected=true;}}
const context=()=>{const oscillators:Node[]=[];return{oscillators,ctx:{createOscillator(){const n=new Node();oscillators.push(n);return n;},createGain(){return new Node();}} as unknown as AudioContext};};
const resident={id:'s',body:'flute_fixture',p:[0,0,0] as const,activity:'play-music',instrument:'flute',activityAge:4,activityLeft:10};
test('actual flute adapter schedules genuine future tones, deduplicates, cancels on stop/mute and skips distant/early/ended players',()=>{
 for(const why of ['distant','early','ended','other','muted']){const f=context(),a=new FluteAudio(),r={...resident,...(why==='distant'?{p:[100,0,0] as const}:why==='early'?{activityAge:0}:why==='ended'?{activityLeft:0}:why==='other'?{instrument:'drums'}:{})};a.update(f.ctx,new Node() as unknown as AudioNode,100.16,5,[r],[0,0,0],why==='muted');assert.equal(f.oscillators.length,0,why);}
 for(const mute of [false,true]){const f=context(),a=new FluteAudio(),out=new Node() as unknown as AudioNode;a.update(f.ctx,out,100.16,5,[resident],[0,0,0]);assert.ok(f.oscillators.length>0,'positive actual synth nodes');assert.ok(a.state().queued>0);const count=f.oscillators.length;a.update(f.ctx,out,100.16,5,[resident],[0,0,0]);assert.equal(f.oscillators.length,count,'no duplicate onset');a.update(f.ctx,out,100.20,5.04,mute?[resident]:[],[0,0,0],mute);assert.ok(f.oscillators.every(n=>n.disconnected),'queued unstarted nodes silenced');assert.equal(a.state().queued,0);}
 const f=context(),a=new FluteAudio(),out=new Node() as unknown as AudioNode,onset=fluteNotes(resident.body,100,101)[0].t;a.update(f.ctx,out,onset+.01,5,[resident],[0,0,0]);const begun=f.oscillators.filter(n=>(n.startAt??Infinity)<=5);assert.ok(begun.length>0);a.update(f.ctx,out,onset+.02,5.01,[],[0,0,0]);assert.ok(begun.every(n=>!n.disconnected),'begun tone keeps natural short decay');
});
