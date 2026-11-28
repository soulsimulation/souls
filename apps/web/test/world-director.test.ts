import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorldDirector,candidates,landmarkPose,MIN_HOLD,MIN_CUT,LANDMARK_SCORE,type DirectorInput,type Landmark} from '../src/WorldDirector.ts';
import {WorldBroadcast,subjectFraction} from '../src/WorldBroadcast.ts';

const L:Landmark[]=[{id:'commons',label:'Commons',p:[35,20,35],target:[8,1,0]},{id:'market',label:'Market',p:[83,12,42],target:[70,1,29]}];
const body=(id:string,x:number,z:number,activity='idle',y=0)=>({id,p:[x,y,z],activity});
const run=(d:WorldDirector,input:(t:number)=>DirectorInput,from:number,to:number)=>{const seen:string[]=[];for(let t=from;t<to;t+=.25){const c=d.choose(input(t));if(seen.at(-1)!==c?.key)seen.push(c?.key??'none');}return seen;};

test('VF1 director: opening establishing view, then the town when only walkers are about', () => {
  const d=new WorldDirector(),walkers=(t:number):DirectorInput=>({bodies:[body('a',10+t,0,'walk'),body('b',-20,5,'walk')],speaking:new Map(),now:t,landmarks:L});
  assert.equal(d.choose(walkers(0))?.key,'landmark:commons');
  const keys=run(d,walkers,0,60);
  assert.ok(keys.every(k=>k.startsWith('landmark:')||k.startsWith('soul:')),keys.join());
  assert.ok(keys.filter(k=>k.startsWith('landmark:')).length>=2,'tours the town: '+keys.join());
});

test('VF1 director: the opening waits for the town views (scenery after people)', () => {
  const d=new WorldDirector(),input=(t:number,l:Landmark[]):DirectorInput=>({bodies:[body('a',0,0,'walk')],speaking:new Map(),now:t,landmarks:l});
  d.choose(input(0,[]));d.choose(input(1,[]));
  assert.equal(d.choose(input(3,L))?.key,'landmark:commons');
  assert.equal(d.choose(input(8,L))?.key,'landmark:commons');
});

test('phone arrival: the opening view was shown under the lifted card, so the first choice is a busy Soul, once', () => {
  const input=(t:number):DirectorInput=>({bodies:[body('reader',70,-5,'read'),body('w',0,30+t,'walk')],speaking:new Map(),now:t,landmarks:L});
  const plain=new WorldDirector(1);
  assert.equal(plain.choose(input(0))?.key,'landmark:commons','desktop: the establishing opening as before');
  const d=new WorldDirector(1);d.openingShown=true;
  assert.equal(d.choose(input(0))?.key,'soul:reader');
  assert.deepEqual(run(d,input,0,6),['soul:reader'],'no cut back to the opening view');
  d.reset();
  assert.equal(d.choose(input(100))?.key,'landmark:commons','one opening only: a later reset opens as before');
  const idle=new WorldDirector(1);idle.openingShown=true;
  assert.ok(idle.choose({bodies:[body('w',0,0,'walk')],speaking:new Map(),now:0,landmarks:L})?.key.startsWith('landmark:'),'only walkers: the town, as before');
});

test('VF1 director: a conversation wins over walkers, gets a two-shot and is held', () => {
  const d=new WorldDirector();
  const input=(t:number):DirectorInput=>({bodies:[body('a',0,0,'sit'),body('b',1.5,0,'sit'),body('w',30+t*2,0,'walk'),body('v',-30,t,'walk')],
    speaking:new Map(t>10?[['a',{thread:'c1',at:10}],['b',{thread:'c1',at:Math.floor(t/4)*4}]]:[]),now:t,landmarks:L});
  run(d,input,0,10.25);
  const c=d.choose(input(14));
  assert.equal(c?.key,'conversation:c1');assert.ok(c?.kind==='subjects'&&c.twoShot&&c.members.length===2);
  const keys=run(d,input,14,14+MIN_HOLD+4);
  assert.deepEqual(keys,['conversation:c1'],'no cutting away to whoever starts walking');
});

test('VF1 director: busy Souls beat walkers; holds, then tours; a speck is rejected', () => {
  const d=new WorldDirector();
  const input=(t:number):DirectorInput=>({bodies:[body('reader',70,-5,'read'),body('dancer',10,5,'dance'),body('w1',0,30+t,'walk'),body('w2',5,-30,'walk')],speaking:new Map(),now:t,landmarks:[]});
  const keys=run(d,input,0,80);
  assert.ok(keys.length>=2&&keys.every(k=>k==='soul:reader'||k==='soul:dancer'),keys.join());
  const first=d.choose(input(100))!;d.reject(first.key,100);
  assert.notEqual(d.choose(input(100.25))?.key,first.key);
  const swim=candidates({bodies:[body('s',-90,0,'swim'),body('w',0,0,'walk')],speaking:new Map(),now:0,landmarks:[]});
  assert.ok(swim[0].score<LANDMARK_SCORE,'a lone swimmer is not worth leaving the town for');
  const wet=candidates({bodies:[body('s',-50,0,'stretch',-3.2),body('w',0,0,'walk')],speaking:new Map(),now:0,landmarks:[]});
  assert.equal(wet[0].key,'soul:w','a busy Soul standing in the pond (body below the ground line) ranks below a walker');
  const d2=new WorldDirector();const only=(t:number):DirectorInput=>({bodies:[body('s',-50,0,'dance',-3.2)],speaking:new Map(),now:t,landmarks:L});
  assert.ok(run(d2,only,0,90).every(k=>k.startsWith('landmark:')),'with only a swimmer about, Broadcast stays on the town');
});

test('VF1 director: balloon riders and groups are candidates; landmark drift is gentle', () => {
  const c=candidates({bodies:[body('r',0,0,'idle',30),body('g1',50,0,'eat'),body('g2',51,1,'sit'),body('g3',52,0,'idle'),body('g4',50.5,2,'paint')],speaking:new Map(),now:0,landmarks:[]});
  assert.equal(c[0].label,'riding');assert.ok(c.some(x=>x.label==='group'&&x.members.length===4));
  const a=landmarkPose(L[0],0),b=landmarkPose(L[0],14);
  assert.ok(Math.hypot(a.position[0]-b.position[0],a.position[1]-b.position[1],a.position[2]-b.position[2])<6);
  assert.deepEqual(a.target,[8,1,0]);
});

test('VF1: subject size in frame', () => {
  const pose={position:[0,1.6,8],target:[0,1,0],fov:45} as const;
  assert.ok(subjectFraction(pose as never,16/9,[0,0,0],1.75)>.15);
  assert.ok(subjectFraction(pose as never,16/9,[0,0,-300],1.75)<.045);
  assert.equal(subjectFraction(pose as never,16/9,[0,0,30],1.75),0);
});

test('VF1 director: one long-running scene alternates with a wide town view', () => {
  const d=new WorldDirector(),g=(t:number):DirectorInput=>({bodies:[body('a',0,0,'dance'),body('b',1,0,'sit'),body('c',2,1,'sit'),body('d',0,2,'idle')],speaking:new Map(),now:t,landmarks:L});
  const keys=run(d,g,0,120);
  const subjects=keys.filter(k=>!k.startsWith('landmark:')).length,towns=keys.filter(k=>k.startsWith('landmark:')).length;
  assert.ok(subjects>=2&&towns>=3,keys.join());
});

test('VF5 director: sleepers and idle crowds are not a show; the tour runs', () => {
  const d=new WorldDirector(),night=(t:number):DirectorInput=>({bodies:[body('a',0,0,'sleep'),body('b',1,0,'lie'),body('c',2,0,'sleep'),body('d',1,1,'idle'),body('e',0,1,'sit')],speaking:new Map(),now:t,landmarks:L});
  assert.ok(run(d,night,0,60).every(k=>k.startsWith('landmark:')),'only the town');
});

test('DIRECTOR2: games, paired gestures, rides and arrivals are events; a fresh one is framed within 10 s', () => {
  const c=candidates({bodies:[body('a',0,0,'play-frisbee'),body('b',10,0,'play-frisbee'),body('c',30,0,'hug'),body('d',30.5,0,'hug'),body('e',60,0,'sit',12),{id:'f',p:[80,0,0],activity:'idle',riding:true}],speaking:new Map(),now:0,landmarks:L});
  const key=(k:string)=>c.find(x=>x.key.startsWith(k));
  assert.deepEqual(key('game:play-frisbee')?.members,['a','b']);
  assert.ok(key('pair:hug')?.twoShot&&key('pair:hug')!.score>key('game:')!.score);
  assert.ok(key('ride:f'));
  // a long conversation is on; a hug starts at 60 s, a stranger arrives at 90 s: each is framed within 10 s
  const d=new WorldDirector(),sp=(t:number)=>new Map([['a',{thread:'t',at:t-1}],['b',{thread:'t',at:t-3}]]);
  const scene=(t:number):DirectorInput=>({bodies:[body('a',0,0),body('b',1,0),...(t>=60&&t<65?[body('c',20,0,'hug'),body('d',20.5,0,'hug')]:[body('c',20,0),body('d',25,0)]),...(t>=90?[body('z',40,0,'walk')]:[])],speaking:sp(t),now:t,landmarks:L});
  const at:Record<number,string>={};for(let t=0;t<120;t+=.25)at[t]=d.choose(scene(t))?.key??'';
  const within=(t0:number,p:string)=>Object.entries(at).some(([t,k])=>+t>=t0&&+t<=t0+10&&k.startsWith(p));
  assert.ok(within(60,'pair:hug:c:d'),'hug');assert.ok(within(90,'arrival:z'),'arrival');
});

test('DIRECTOR2: at most one cut per MIN_CUT seconds, and no town view while a conversation is the only thing on', () => {
  const d=new WorldDirector();let last=-Infinity,prev='';const towns:number[]=[];
  for(let t=0;t<300;t+=.25){
    const k=Math.floor(t/4)%4,acts=['hug','play-petanque','read','dance'];
    const bodies=[body('a',0,0,acts[k]),body('b',.5,0,acts[k]),body('c',30,0,acts[(k+1)%4]),body('d',30.5,0,acts[(k+1)%4]),...(Math.floor(t/7)%2?[body('n'+Math.floor(t/14),50,0,'walk')]:[])];
    const key=d.choose({bodies,speaking:new Map(),now:t,landmarks:L})?.key??'';
    if(key!==prev){if(prev)assert.ok(t-last>=MIN_CUT,`cut at ${t} after ${last}`);last=t;prev=key;}
  }
  const c=new WorldDirector(),conv=(t:number):DirectorInput=>({bodies:[body('a',0,0),body('b',1,0)],speaking:new Map([['a',{thread:'t',at:t}],['b',{thread:'t',at:t-2}]]),now:t,landmarks:L});
  for(let t=0;t<200;t+=.25){const key=c.choose(conv(t))?.key??'';if(t>20)towns.push(key.startsWith('landmark:')?1:0);}
  assert.equal(towns.reduce((a,b)=>a+b,0),0);
});

test('DIRECTOR2: two Souls who are talking high-five (2.5 s): the gesture gets its own shot at its start, held MIN_CUT', () => {
  const d=new WorldDirector(),sp=(t:number)=>new Map([['a',{thread:'t',at:t-1}],['b',{thread:'t',at:t-3}]]);
  const g=(t:number)=>t>=40&&t<42.5?'high-five':'idle';
  const scene=(t:number):DirectorInput=>({bodies:[body('a',0,0,g(t)),body('b',1,0,g(t))],speaking:sp(t),now:t,landmarks:L});
  const at:[number,string][]=[];for(let t=0;t<70;t+=.25)at.push([t,d.choose(scene(t))?.key??'']);
  const first=at.find(([t,k])=>t>=40&&k==='pair:high-five:a:b');
  assert.ok(first&&first[0]<=40.5,'framed on its start event');
  const cuts=at.filter(([,k],i)=>i&&k!==at[i-1][1]).map(([t])=>t);
  assert.ok(cuts.every((t,i)=>!i||t-cuts[i-1]>=MIN_CUT),'no cut pair under MIN_CUT: '+cuts.join(','));
});

test('DIRECTOR2: a paired gesture that starts just after a cut still gets its pair shot once the cut window opens, held MIN_CUT', () => {
  for (const [ga, gb, key, len] of [['high-five','high-five','pair:high-five:a:b',2.5],['hug','hug','pair:hug:a:b',5],['handshake','handshake','pair:handshake:a:b',3.5],['give','take','pair:give:a:b',2.5]] as const) {
    const d=new WorldDirector();let gs=Infinity,prev='';
    const act=(t:number,g:string)=>t>=gs&&t<gs+len?g:'idle';
    const scene=(t:number):DirectorInput=>({bodies:[body('a',0,0,act(t,ga)),body('b',.8,0,act(t,gb)),body('c',30,0,'paint'),body('e',-30,10,'read')],speaking:new Map(),now:t,landmarks:L});
    const at:[number,string][]=[];
    for(let t=0;t<120;t+=.25){const k=d.choose(scene(t))?.key??'';if(t>=30&&gs===Infinity&&prev&&k!==prev)gs=t+1;prev=k;at.push([t,k]);}
    assert.ok(Number.isFinite(gs),'a cut after 30 s');
    const first=at.find(([t,k])=>t>=gs&&k===key);
    assert.ok(first&&first[0]-gs<=MIN_CUT,`${key} framed ${first?first[0]-gs:'never'} s after its start`);
    const cuts=at.filter(([,k],i)=>i&&k!==at[i-1][1]).map(([t])=>t);
    assert.ok(cuts.every((t,i)=>!i||t-cuts[i-1]>=MIN_CUT),'no cut pair under MIN_CUT: '+cuts.join(','));
  }
});

// #2202: the cut order is a seeded weighted shuffle by eventfulness and novelty.
const busy=(t:number):DirectorInput=>({bodies:[body('a',0,0,'read'),body('b',40,0,'paint'),body('c',80,0,'dance'),body('d',0,40,'eat'),body('e',40,40,'garden')],speaking:new Map(),now:t,landmarks:L});
const order=(seed:number,input:(t:number)=>DirectorInput,to=300)=>{const d=new WorldDirector(seed);const seen:[number,string][]=[];for(let t=0;t<to;t+=.25){const k=d.choose(input(t))?.key??'none';if(seen.at(-1)?.[1]!==k)seen.push([t,k]);}return seen;};

test('#2202 shuffle: the same world state gives different cut orders across page loads (seeds), the same order for one seed', () => {
  const subjects=(s:number)=>order(s,busy).map(([,k])=>k).filter(k=>!k.startsWith('landmark:')).join();
  assert.equal(subjects(7),subjects(7),'one seed is reproducible');
  const orders=new Set([1,2,3,4,5,6,7,8].map(subjects));
  assert.ok(orders.size>=5,`${orders.size} distinct orders of 8: ${[...orders].join(' | ')}`);
  const firsts=new Set([1,2,3,4,5,6,7,8].map(s=>subjects(s).split(',')[0]));
  assert.ok(firsts.size>=3,'the first subject varies too: '+[...firsts].join());
});

test('#2202 weights: a conversation and a fresh event still come first, whatever the seed', () => {
  const scene=(t:number):DirectorInput=>({...busy(t),bodies:[...busy(t).bodies,body('p',-40,0),body('q',-39,0)],speaking:new Map([['p',{thread:'t',at:t-1}],['q',{thread:'t',at:t-3}]])});
  for(let s=1;s<=20;s++){const first=order(s,scene,30).map(([,k])=>k).find(k=>!k.startsWith('landmark:'));assert.equal(first,'conversation:t',`seed ${s}`);}
  const d=new WorldDirector(3),c=candidates(busy(0)).find(x=>x.key==='soul:a')!;
  const speaking={...busy(0),speaking:new Map([['a',{thread:'x',at:-2}]])};
  assert.equal(d.eventfulness(c,speaking,6)-d.eventfulness(c,busy(0),6),2,'speech in the last 10 s adds 2');
  const crowd=(n:number):DirectorInput=>({bodies:Array.from({length:n},(_,i)=>body('g'+i,i,0,'sit')),speaking:new Map(),now:0,landmarks:[]});
  const g=(n:number)=>{const x=crowd(n),c=candidates(x).find(k=>k.label==='group')!;return d.eventfulness(c,x,c.score)-c.score;};
  assert.equal(g(5)-g(4),.5,'each active member beyond two adds 0.5');
});

test('#2202 recency: a subject, place and type just shown weigh less; no subject twice within 90 s while others are on', () => {
  const d=new WorldDirector(1),x=busy(0),c=candidates(x).find(k=>k.key==='soul:a')!;
  const fresh=d.priority(c,x,6);
  for(let t=0;t<30;t+=.25)d.choose(busy(t));
  const shown=d.current?.kind==='subjects'?d.current:null;assert.ok(shown,'a subject is on');
  const again=candidates(busy(30)).find(k=>k.key===shown!.key)!;
  assert.ok(d.priority(again,busy(30),6)<.45*fresh,'just shown: subject, place and type penalties');
  for(let s=1;s<=10;s++){
    const last=new Map<string,number>();
    for(const [t,k] of order(s,busy,400)){if(k.startsWith('landmark:'))continue;const p=last.get(k);assert.ok(p===undefined||t-p>=90,`seed ${s}: ${k} again after ${p===undefined?0:t-p} s`);last.set(k,t);}
  }
});

test('#2202 fallback: with nothing eventful on, the town views are a plain shuffle, never one of the last half again', () => {
  const many:Landmark[]=['a','b','c','d','e','f','g','h'].map((id,i)=>({id,label:id,p:[i*50,20,30],target:[i*50,1,0]}));
  const walkers=(t:number):DirectorInput=>({bodies:[body('w',500+t,500,'walk')],speaking:new Map(),now:t,landmarks:many});
  const views=(s:number)=>order(s,walkers,400).map(([,k])=>k);
  const all=[1,2,3,4,5,6].map(views);
  for(const v of all){assert.ok(v.every(k=>k.startsWith('landmark:')),v.join());for(let i=1;i<v.length;i++)assert.ok(!v.slice(Math.max(0,i-4),i).includes(v[i]),'none of the last half again: '+v.join());}
  assert.ok(new Set(all.map(v=>v.join())).size>=5,'different orders per page load');
});

// Inferred circles have continuity only between adjacent decisions, never semantic thread authority.
const listeners=(ids:string[],x=0)=>ids.map((id,i)=>body(id,x+i%2,i>>1,'listen'));
const listenInput=(now:number,bodies:ReturnType<typeof body>[]):DirectorInput=>({now,bodies,speaking:new Map(),landmarks:[],arrivals:new Map()});
const talkState=(d:WorldDirector)=>d as unknown as {
  talkScenes:{id:string;rawKey:string;members:string[]}[]; talkRaw:Map<string,string>; nextTalkScene:number;
  talkBanned:Map<string,number>; talkCooling:Map<string,number>; banned:Map<string,number>; cooling:Map<string,number>;
  noise:Map<string,number>; heldTalk:{id:string;rawKey:string}|null; lastCut:number;
};

test('inferred circles: anchor departure, join, focus and membership update without a fresh shot age',()=>{
  const d=new WorldDirector(1),base=listeners(['a','b','c']);
  const first=d.choose(listenInput(0,base))!;
  d.choose(listenInput(8,listeners(['a','b','c','d'])));
  const c=d.choose(listenInput(12,listeners(['b','c','d'])))!;
  assert.equal(c.key,first.key);assert.equal(d.since,0);assert.equal(talkState(d).lastCut,0);
  assert.ok(c.kind==='subjects');assert.deepEqual(c.members,['b','c','d']);assert.equal(c.focus,'b');
  d.choose(listenInput(13,[...listeners(['b','c','d']),body('passer',.5,.5,'walk')]));
  assert.equal(d.current?.key,first.key);
  const explicit=new WorldDirector(1),thread=(t:number,ids:string[]):DirectorInput=>({...listenInput(t,listeners(ids)),speaking:new Map(ids.map(id=>[id,{thread:'real-thread',at:t}]))});
  explicit.choose(thread(0,['a','b','c','d']));assert.equal(explicit.choose(thread(12,['b','c','d']))?.key,'conversation:real-thread');assert.equal(explicit.since,0);
});

test('inferred circles: split, merge, one-member overlap and reused anchor cannot inherit ambiguous identity',()=>{
  const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b','c','d'])));const old=talkState(d).talkScenes[0].id;
  d.choose(listenInput(12,[...listeners(['a','b'],-10),...listeners(['c','d'],10)]));
  const children=talkState(d).talkScenes.map(s=>s.id);assert.equal(children.length,2);assert.ok(children.every(id=>id!==old));
  d.choose(listenInput(20,listeners(['a','b','c','d'])));assert.ok(!children.includes(talkState(d).talkScenes[0].id));
  const before=talkState(d).talkScenes[0].id;d.choose(listenInput(28,listeners(['d','e'])));assert.notEqual(talkState(d).talkScenes[0].id,before);
  const collision=new WorldDirector(1);collision.choose(listenInput(0,listeners(['a','b','c'])));const continued=collision.current!.key;
  collision.choose(listenInput(12,[...listeners(['a','x'],30),...listeners(['b','c'])]));
  const scenes=talkState(collision).talkScenes;
  assert.equal(scenes.find(s=>s.members.includes('b'))?.id,continued);
  assert.notEqual(scenes.find(s=>s.members.includes('a'))?.id,continued);
});

test('inferred circles: unselected identities and refusal/cooling survive reselect and retirement on unchanged deadlines',()=>{
  const d=new WorldDirector(1),bs=[...listeners(['a','b']),...listeners(['c','d'],30)];
  d.choose(listenInput(0,bs));const original=talkState(d).talkScenes.map(s=>s.id),selected=d.current!.key;
  d.reject(selected,1);d.choose(listenInput(1.25,bs));assert.notEqual(d.current?.key,selected);
  assert.deepEqual(talkState(d).talkScenes.map(s=>s.id),original);
  assert.equal(talkState(d).banned.get(selected),41);
  // Cooling follows the same policy clock, including an unselected present scene.
  talkState(d).cooling.set(selected,31);
  d.choose(listenInput(2,[]));assert.equal(talkState(d).talkBanned.get('talk:a'),selected===original[0]?41:undefined);
  const raw=selected===original[0]?'talk:a':'talk:c';assert.equal(talkState(d).talkBanned.get(raw),41);assert.equal(talkState(d).talkCooling.get(raw),31);
  d.choose(listenInput(3,bs));const reborn=talkState(d).talkScenes.find(s=>s.rawKey===raw)!;assert.notEqual(reborn.id,selected);assert.notEqual(d.current?.key,reborn.id);
  assert.equal(talkState(d).talkBanned.get(raw),41,'no deadline renewal');
  d.choose(listenInput(31,bs));assert.equal(talkState(d).talkCooling.size,0);assert.equal(talkState(d).talkBanned.get(raw),41);
  d.choose(listenInput(41,bs));assert.equal(talkState(d).talkBanned.size,0);
});

test('inferred circles: missing held choice can be rejected late; raw aliases never collide with opaque identities',()=>{
  const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b'])));const key=d.current!.key;
  d.choose(listenInput(.25,[]));assert.equal(d.current?.key,key);assert.equal(talkState(d).talkScenes.length,0);
  d.reject(key,.5);assert.equal(talkState(d).talkBanned.get('talk:a'),40.5);
  d.choose(listenInput(.75,listeners(['a','b'])));assert.notEqual(d.current?.key,talkState(d).talkScenes[0].id);
  assert.equal(talkState(d).talkBanned.get('talk:a'),40.5);
  d.choose(listenInput(40.5,listeners(['a','b'])));assert.equal(d.current?.key,talkState(d).talkScenes[0].id);
  const n=new WorldDirector(1);n.choose(listenInput(0,listeners(['a','b'])));const opaque=n.current!.key;
  n.reject(opaque,1);n.choose(listenInput(2,[]));
  // Raw talk:scene:1 is a different circle, not a refusal of opaque talk:scene:1.
  const c=n.choose(listenInput(8,listeners(['scene:1','z'])))!;assert.ok(c.key.startsWith('talk:'));assert.notEqual(c.key,opaque);
  assert.equal(talkState(n).talkBanned.has('talk:scene:1'),false);
  n.reset();assert.equal(talkState(n).talkScenes.length,0);assert.equal(talkState(n).talkBanned.size,0);assert.equal(talkState(n).talkCooling.size,0);assert.equal(talkState(n).heldTalk,null);assert.equal(talkState(n).nextTalkScene,0);
});

test('inferred circles: activity loss expires identity and retired noise; current state stays proportional to present circles',()=>{
  const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b'])));const first=d.current!.key;
  d.choose(listenInput(8,[body('a',0,0),body('b',1,0)]));assert.equal(talkState(d).talkScenes.length,0);assert.equal(talkState(d).noise.has(first),false);
  d.choose(listenInput(16,listeners(['a','b'])));assert.notEqual(d.current?.key,first);
  for(let i=0;i<200;i++){
    d.choose(listenInput(20+i*.25,[...listeners(['a','b']),...listeners(['x'+i,'y'+i],30)]));
    const s=talkState(d);assert.equal(s.talkScenes.length,2);assert.equal(s.talkRaw.size,2);
    assert.ok([...s.noise.keys()].filter(k=>k.startsWith('talk:')).every(k=>s.talkRaw.has(k)));
  }
});

test('inferred-circle continuity reaches the unchanged live Broadcast consumer without resetting Tracker',()=>{
  const w=new WorldBroadcast(1),scene={bounds:[-100,-100,100,100],levels:[{id:0,y:0,label:'ground'}],surfaces:[],obstacles:[],links:[]};
  const state=w as unknown as {choice:{key:string;members:string[]};cutAt:number;picker:WorldDirector;tracker:{move:unknown;last:unknown;key:string}};
  let key='',move:unknown=null;
  for(let i=0;i<=495;i++){
    const t=i/60,bs=listeners(t<8?['a','b','c']:['b','c']);
    const frame=Object.fromEntries(bs.map(b=>[b.id,{...b,yaw:0,state:{}}])),records=Object.fromEntries(bs.map(b=>[b.id,{id:b.id,kind:'human'}]));
    w.sample(frame as never,records as never,scene as never,i,1/60,390/844,t,1/60,[]);
    if(i===479){key=state.choice.key;move=state.tracker.move;assert.ok(move);assert.ok(state.tracker.last);}
    if(i>=480){assert.equal(state.choice.key,key);assert.equal(state.cutAt,0);assert.equal(state.picker.since,0);assert.equal(state.tracker.move,move);assert.ok(state.tracker.last);assert.deepEqual(state.choice.members,['b','c']);}
  }
  w.reset();assert.equal(talkState(state.picker).talkScenes.length,0,'existing seek/epoch reset also clears continuity');
});

test('inferred circles: reappeared raw refusal becomes identity policy before another anchor leaves',()=>{
  for(const policy of ['banned','cooling'] as const){
    const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b','c'])));const old=d.current!.key;
    if(policy==='banned')d.reject(old,1);else talkState(d).cooling.set(old,31);
    const deadline=policy==='banned'?41:31;
    d.choose(listenInput(2,[]));d.choose(listenInput(8,listeners(['a','b','c'])));
    const reborn=talkState(d).talkScenes[0].id;assert.notEqual(reborn,old);assert.equal(talkState(d)[policy].get(reborn),deadline);
    d.choose(listenInput(9,listeners(['b','c'])));assert.equal(talkState(d).talkScenes[0].id,reborn);assert.equal(talkState(d)[policy].get(reborn),deadline);
    if(policy==='banned')assert.notEqual(d.current?.key,reborn);
    d.choose(listenInput(deadline,listeners(['b','c'])));assert.equal(talkState(d)[policy].has(reborn),false);
  }
});


test('inferred circles: a raw name matching the NEXT opaque ID does not ban a different circle',()=>{
  const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['scene:2','z'])));d.reject(d.current!.key,1);
  d.choose(listenInput(2,[]));assert.equal(talkState(d).talkBanned.get('talk:scene:2'),41);
  const c=d.choose(listenInput(8,listeners(['a','b'])))!;assert.equal(c.key,'talk:scene:2');
  assert.equal(talkState(d).banned.has(c.key),false,'raw alias is not an opaque key refusal');
});

test('inferred circles: same-decision replacement inherits retiring refusal before anchor churn',()=>{
  for(const policy of ['banned','cooling'] as const){
    const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b'])));const old=d.current!.key;
    if(policy==='banned')d.reject(old,1);else talkState(d).cooling.set(old,31);
    d.choose(listenInput(8,listeners(['a','c','d'])));const replacement=talkState(d).talkScenes[0].id;
    assert.notEqual(replacement,old);assert.equal(talkState(d)[policy].get(replacement),policy==='banned'?41:31);
    d.choose(listenInput(9,listeners(['c','d'])));assert.equal(talkState(d).talkScenes[0].id,replacement);
    assert.equal(talkState(d)[policy].get(replacement),policy==='banned'?41:31);
    if(policy==='banned')assert.notEqual(d.current?.key,replacement);
  }
});

test('inferred-circle policy transitions: split/merge inherit only matching raw deadlines, MAX never renews',()=>{
  for(const policy of ['banned','cooling'] as const){
    const d=new WorldDirector(1);d.choose(listenInput(0,listeners(['a','b','c','d'])));const old=d.current!.key;
    talkState(d)[policy].set(old,30);
    const aliases=policy==='banned'?talkState(d).talkBanned:talkState(d).talkCooling;aliases.set('talk:a',35);
    d.choose(listenInput(8,[...listeners(['a','b'],-10),...listeners(['c','d'],10)]));
    const split=talkState(d).talkScenes;assert.ok(split.every(s=>s.id!==old));
    assert.equal(talkState(d)[policy].get(split.find(s=>s.rawKey==='talk:a')!.id),35);
    assert.equal(talkState(d)[policy].has(split.find(s=>s.rawKey==='talk:c')!.id),false);
    d.choose(listenInput(16,listeners(['a','b','c','d'])));const merged=talkState(d).talkScenes[0];
    assert.ok(!split.some(s=>s.id===merged.id));assert.equal(talkState(d)[policy].get(merged.id),35);
    d.choose(listenInput(20,listeners(['b','c','d'])));assert.equal(talkState(d).talkScenes[0].id,merged.id);assert.equal(talkState(d)[policy].get(merged.id),35);
    d.choose(listenInput(35,listeners(['b','c','d'])));assert.equal(talkState(d)[policy].has(merged.id),false);assert.equal(aliases.size,0);
  }
});
