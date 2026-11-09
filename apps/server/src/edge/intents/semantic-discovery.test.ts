import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticDiscovery,exploreDiscovery} from './semantic-discovery.ts';
function setup(){
 const places=[
  {id:'harbour',name:'Harbour',parent:'world'},
  {id:'pier',ref:'west-pier',name:'Harbour West Pier',parent:'world',semanticParent:'harbour',aliases:['west pier'],parts:[{id:'view-seat',title:'Sea-View Bench',aliases:['pier bench'],sit:'sit:west-pier/part-view-seat',target:{entity:'bench',ref:'bench',slot:'seat-1'}},{id:'view',title:'Sunset View'}]},
  {id:'chiba',ref:'chiba',name:'Chiba',aliases:['auditorium','Chiba auditorium'],parent:'world',parts:[{id:'podium',title:'Podium Desk Seat',aliases:['presenter desk','podium desk'],sit:'sit:chiba/part-podium',target:{entity:'presenter',ref:'presenter',slot:'seat'}},{id:'gallery',title:'Gallery',walk:'walk:chiba/part-gallery',target:{level:8}}]},
  {id:'music',ref:'music',name:'Music Hall',parent:'world',semanticKind:'music hall',description:'An indoor hall for music and performances.',salience:3},
  {id:'stage',ref:'stage',name:'Outdoor Stage',parent:'world',semanticKind:'stage',description:'Live music and performance gatherings.'},
  {id:'library',ref:'library',name:'Library',parent:'world',description:'A quiet room to read books.'},
 ];const unavailable=new Set<string>(),secret=new Set<string>();
 const L={places:{byId:new Map(places.map(p=>[p.id,p]))},knowledge:{knows:(_:string,id:string)=>!secret.has(id)},resolveOnDemand:(_:unknown,id:string)=>({v:{kind:'exact',cap:{id,available:!unavailable.has(id),...(unavailable.has(id)?{blocked:{code:'route.unreachable',reason:'No reachable floor.'}}:{})}}})} as any;
 const run=(s:string)=>semanticDiscovery(L,{soulId:'s'} as any,s,[],new Map()) as any;return{run,L,places,secret,unavailable};
}
test('named interaction matrix preserves action and hard place/part constraints',()=>{
 const {run}=setup();
 // the place named, not the seat (a word the seat shares with its place, "pier", names the place): still a choice
 for(const text of ['sit on the harbour west pier','take a seat at the west pier','where can I sit on the harbour west pier']){const r=run(text);assert.equal(r.code,'capability.choose',text);assert.deepEqual(r.didYouMean.map((x:any)=>x.id),['sit:west-pier/part-view-seat']);}
 // #849: one available seat named by its own words answers with it, its note naming it; a purpose question only lists it
 for(const [text,id] of [['sit on a bench in the harbour west pier','sit:west-pier/part-view-seat'],['sit at the podium desk in Chiba','sit:chiba/part-podium'],['sit down at the Chiba auditorium presenter desk','sit:chiba/part-podium'],['take a seat at the podium desk in Chiba to prepare a presentation','sit:chiba/part-podium']]){
  const r=run(text);assert.equal(r.kind,'alias',text);assert.equal(r.cap.id,id,text);assert.match(r.note,new RegExp(`The only seat these words name is .*\\(${id}\\); send that id to sit there`),text);
 }
 for(const text of ['where can I sit at the podium desk in Chiba','where can I sit on a bench in the harbour west pier']){const r=run(text);assert.equal(r.code,'capability.choose',text);assert.equal(r.didYouMean.length,1,text);}
 for(const text of ['sit in the Chiba gallery','sit at the missing desk in Chiba','sit at the podium desk in the missing auditorium','sit at the west pier sunset view'])assert.equal(run(text).didYouMean.length,0,text);
 assert.equal(run('sit down'),null);assert.equal(run('sit:chiba/part-podium'),null);
});
test('#849: an unavailable single named seat is refused with its own reason, never taken; explore only lists',()=>{
 const {run,L,unavailable}=setup();unavailable.add('sit:chiba/part-podium');
 const r=run('sit at the podium desk in Chiba');assert.equal(r.kind,'unknown');assert.equal(r.code,'route.unreachable','its own blocked code');
 assert.match(r.reason,/The only seat these words name, Podium Desk Seat — Chiba \(sit:chiba\/part-podium\), cannot be taken now: No reachable floor\. No other seat was chosen\./);
 assert.deepEqual(r.didYouMean.map((x:any)=>[x.id,x.available]),[['sit:chiba/part-podium',false]]);
 unavailable.clear();const e=exploreDiscovery(L,{soulId:'s'} as any,'sit at the podium desk in Chiba',[],new Map()) as any;
 assert.equal(e.code,'capability.choose');assert.deepEqual(e.didYouMean.map((x:any)=>x.id),['sit:chiba/part-podium']);
});
test('ambiguous seats are choices; private and unavailable anchors never become available',()=>{
 const {run,L,secret,unavailable}=setup();const chiba=L.places.byId.get('chiba');
 chiba.parts.push({id:'second',title:'Podium Desk Seat',sit:'sit:chiba/part-second',target:{entity:'second',ref:'second',slot:'seat'}});
 assert.equal(run('sit at the Chiba podium desk').didYouMean.length,2);
 unavailable.add('sit:chiba/part-podium');assert.equal(run('sit at the Chiba podium desk').didYouMean.find((c:any)=>c.id==='sit:chiba/part-podium').available,false);
 secret.add('chiba');const hidden=run('sit at the Chiba podium desk');assert.ok(!hidden||hidden.didYouMean.length===0);
});
test('purpose-location phrasing returns place choices and evidence, not instrument actions or invented events',()=>{
 const {run}=setup();for(const text of ['somewhere to hear live music','find a place for live music','where can I hear live music']){
  const r=run(text);assert.equal(r.discovery.kind,'purpose');assert.equal(r.didYouMean[0].id,'walk:stage','more requested purpose terms outrank a name-only partial match');assert.ok(r.didYouMean.every((c:any)=>c.id.startsWith('walk:')));assert.match(r.discovery.note,/does not confirm/);
 }
 assert.ok(run('a place to read books').didYouMean.some((c:any)=>c.id==='walk:library'));
 assert.equal(run('somewhere for music in the missing district').didYouMean.length,0);
 assert.equal(run('a place for teleportation').didYouMean.length,0);
});

test('ordinary exact fixture identities, generic nearest seats and unrelated queries retain vocabulary handling',()=>{
 const {L}=setup(),caps=[{id:'sit:presenter-timber-box',verb:'sit',label:'Sit at the presenter timber box',target:{kind:'object',id:'presenter'}},{id:'sit:e_commons',verb:'sit',label:'commons-bench (a bench, 20 m)',target:{kind:'object',id:'commons'}}] as any;
 for(const query of ['sit presenter-timber-box','sit at the presenter timber box','sit at the commons bench','sit at the closest bench','sit on the nearest chair','sit on unknown spaceship'])assert.equal(semanticDiscovery(L,{soulId:'s'} as any,query,caps,new Map()),null,query);
});

test('explore reuses purpose retrieval; bare queries require every term and preserve named scope',()=>{
 const {L,secret}=setup(),run=(q:string)=>exploreDiscovery(L,{soulId:'s'} as any,q,[],new Map()) as any;
 const live=run('live music');assert.deepEqual(live.didYouMean.map((c:any)=>c.id),['walk:stage']);assert.equal(live.discovery.candidates[0].unverified.length,0);
 assert.ok(run('somewhere to hear live music').didYouMean.length);
 for(const q of ['library missing','live music missing','teleportation','walk:missing'])assert.equal(run(q),null,q);
 assert.equal(run('live music in missing district'),null);
 secret.add('stage');assert.equal(run('live music'),null,'private purpose must not leak through fallback');
});

test('supported untargeted activity commands remain activities before venue discovery',()=>{
 const {L}=setup(),caps=[{id:'read:here',verb:'read',available:true},{id:'nap:here',verb:'nap',available:true}] as any;
 for(const query of ['find somewhere to read a book','find somewhere to take a nap'])assert.equal(semanticDiscovery(L,{soulId:'s'} as any,query,caps,new Map()),null,query);
 const venue=semanticDiscovery(L,{soulId:'s'} as any,'somewhere to hear live music',caps,new Map()) as any;assert.equal(venue.discovery.kind,'purpose');assert.equal(venue.didYouMean[0].id,'walk:stage');
});

test('#848: relation words between a seat and its place: inside reads as in, outside is a constraint (outdoor)',()=>{
 const {run,L}=setup();
 L.places.byId.set('cottage',{id:'cottage',ref:'cottage',name:'Knoll Cottage',aliases:['cottage'],parent:'world',parts:[{id:'outdoor-bench',title:'Outdoor Bench',aliases:['hill bench'],sit:'sit:cottage/part-outdoor-bench',target:{entity:'bench',ref:'bench',slot:'seat'}}]});
 // (#849: each names one available seat by its own words, so resolve answers with it)
 assert.equal(run('sit on the bench outside the cottage').cap.id,'sit:cottage/part-outdoor-bench');
 assert.equal(run('sit on the bench by the cottage').cap.id,'sit:cottage/part-outdoor-bench');
 // ... but the relation word alone is not the seat's name: the place named, so still a choice (#849 review)
 for(const text of ['sit outside the cottage','sit outside knoll cottage']){const r=run(text);assert.equal(r.code,'capability.choose',text);assert.deepEqual(r.didYouMean.map((x:any)=>x.id),['sit:cottage/part-outdoor-bench'],text);}
 assert.equal(run('sit at the podium desk inside Chiba').cap.id,'sit:chiba/part-podium');
 assert.equal(run('sit at the podium desk outside Chiba').didYouMean.length,0,'no outdoor seat in Chiba: the constraint is kept');
});

test('#848 review: a generic sit does not build the named-seat parts (no cost before the early return)',()=>{
 const {L,places}=setup(),knows=L.knowledge.knows;let calls=0;L.knowledge.knows=(...a:[string,string])=>{calls++;return knows(...a);};
 for(const query of ['sit down','sit on a bench']){calls=0;assert.equal(semanticDiscovery(L,{soulId:'s'} as any,query,[],new Map()),null,query);assert.equal(calls,places.length,`${query}: only the known-places filter`);}
});

test('F5 (#376): a bound seat whose own name holds every word keeps the vocabulary path; seats of different names are named, never chosen',()=>{
 const {L}=setup(),seat=(name:string,id=name)=>({id:'sit:e_'+id,verb:'sit',label:`${name} (a mars-presenter-timber-box, sit on top, 23 m)`,target:{kind:'object',id},available:true});
 const run=(q:string,caps:any[])=>semanticDiscovery(L,{soulId:'s'} as any,q,caps,new Map()) as any;
 // "presenter" names a Chiba part alias ("presenter desk"), so on main this was refused with no candidates
 assert.equal(run('sit on the presenter box',[seat('presenter-timber-box')]),null);
 assert.equal(run('sit on the presenter box',[seat('presenter-timber-box'),seat('presenter-timber-box-2')]),null,'numbered copies of one seat stay the nearest-of-them');
 const two=run('sit on the presenter box',[seat('presenter-timber-box'),seat('presenter-spare-box')]);
 assert.equal(two.code,'capability.choose');assert.deepEqual(two.didYouMean.map((c:any)=>c.id).sort(),['sit:e_presenter-spare-box','sit:e_presenter-timber-box']);
 assert.match(two.reason,/presenter-spare-box/);assert.match(two.reason,/presenter-timber-box/);assert.equal(two.discovery.requested,'sit');
 // a "by <neighbour>" clause or the kind in a label never names the seat; case and separators do not split copies
 const by=(name:string,near:string)=>({id:'sit:e_'+name,verb:'sit',label:`${name} (a mars-navy-sofa, seat 0.5 m high; by ${near}; 3 m)`,target:{kind:'object',id:name},available:true});
 assert.equal(run('sit on the auditorium sofa',[by('auditorium-guest-sofa','camp-tracks'),by('navy-sofa','chiba/part-auditorium')]),null,'only one seat is named both words');
 assert.equal(run('sit on the presenter box',[seat('crate-a'),seat('crate-b')]).code,'capability.unavailable','the kind is not a name');
 assert.equal(run('sit on the presenter box',[seat('Presenter Timber Box','a'),seat('presenter-timber-box-2','b')]),null);
 // the choice keeps one seat per name, and the reason names what it lists
 const many=run('sit on the presenter box',[...Array.from({length:9},(_,i)=>seat(`presenter-box-${i+1}`)),seat('presenter-spare-box')]);
 assert.deepEqual(many.didYouMean.map((c:any)=>c.id),['sit:e_presenter-box-1','sit:e_presenter-spare-box']);assert.match(many.reason,/presenter-box-1, presenter-spare-box/);
 const none=run('sit on the auditorium sofa',[seat('presenter-timber-box')]);assert.equal(none.code,'capability.unavailable');assert.equal(none.didYouMean.length,0);
});

test('#1242: "sit outside with <someone unknown>" lists the outdoor seat, chooses nothing, and names who was not found',()=>{
 const {L}=setup(),soul={soulId:'s'} as any,bench={id:'sit:e_bench',verb:'sit',label:'commons-bench (a bench, 20 m)',target:{kind:'object',id:'commons'},available:true};
 L.places.byId.set('cottage',{id:'cottage',ref:'cottage',name:'Knoll Cottage',aliases:['cottage'],parent:'world',parts:[{id:'outdoor-bench',title:'Outdoor Bench',sit:'sit:cottage/part-outdoor-bench',target:{entity:'bench',ref:'bench',slot:'seat'}}]});
 // (as the ledger does: words go through discovery, then the vocabulary, here the nearest bench for a generic bench)
 L.resolveOnDemand=(_:unknown,text:string,caps:any[],plans:any)=>{const c=caps.find(x=>x.id===text);if(c||text.includes(':'))return {v:{kind:'exact',cap:c??{id:text,verb:'sit',available:true}}};
  return {v:semanticDiscovery(L,soul,text,caps,plans)??(/\bbench\b/.test(text)&&caps[0]?{kind:'alias',cap:caps[0],note:''}:{kind:'unknown',reason:'none',didYouMean:[]})};};
 L.host={minds:new Map()};const run=(s:string,caps:any[]=[])=>semanticDiscovery(L,soul,s,caps,new Map()) as any;
 for(const [text,who] of [['sit outside with Bo','Bo'],['sit outside with Zed.','Zed'],['sit outside with a friend','a friend'],['take a seat outside along with Bo and Zed','Bo, Zed'],['sit outside with Bo now','Bo'],['sit outside with Bo for a minute','Bo'],['sit outside with Bo next to the fire','Bo']]){
  const r=run(text);assert.equal(r.kind,'unknown',text);assert.equal(r.code,'capability.choose',text);
  assert.deepEqual(r.didYouMean.map((x:any)=>x.id),['sit:cottage/part-outdoor-bench'],text);
  assert.deepEqual(r.discovery.unresolved,{with:who},text);assert.ok(r.reason.includes(`"${who}" is not read: no Soul you can invite from here is called that`),text);assert.match(r.reason,/No seat has been selected/,text);
 }
 // the seat named by its own words alone is still only listed (never an alias) while a companion is missing
 const own=run('sit on the outdoor bench with Bo');assert.equal(own.code,'capability.choose');assert.deepEqual(own.didYouMean.map((x:any)=>x.id),['sit:cottage/part-outdoor-bench']);
 // a generic seat with a missing companion lists the seat the plain words resolve to, and takes nothing
 const generic=run('sit on the bench with Zed',[bench]);assert.equal(generic.code,'capability.choose');assert.deepEqual(generic.didYouMean.map((x:any)=>x.id),['sit:e_bench']);assert.deepEqual(generic.discovery.unresolved,{with:'Zed'});
 // A3: words that name a different place still refuse; nothing nearby is substituted (and the missing Soul is still said)
 for(const text of ['sit outside near the orchard','sit at the podium desk outside Chiba'])assert.equal(run(text).didYouMean.length,0,text);
 const elsewhere=run('sit at the podium desk outside Chiba with Bo');assert.equal(elsewhere.code,'capability.unavailable');assert.equal(elsewhere.didYouMean.length,0);assert.deepEqual(elsewhere.discovery.unresolved,{with:'Bo'});
 // review: a seat named after "with" is not swapped for the ground; "with" words that name a part ("a sunset view") keep the refusal
 for(const text of ['sit with Zed on the outdoor bench','sit down with Zed on the outdoor bench','sit outside with a sunset view']){const r=run(text,[{id:'sit:here',verb:'sit',label:'Sit down on the ground here',available:true}]);assert.ok(!r||!r.didYouMean.some((x:any)=>x.id==='sit:here'),text);assert.equal(r?.discovery?.unresolved,undefined,text);}
 // review: of two names, only the one no Soul has is named missing; all present but not invitable says so, not "missing"
 L.host.minds.set('s_bo',{soulId:'s_bo',name:'Bo'});
 assert.deepEqual(run('sit outside with Bo and Zed').discovery.unresolved,{with:'Zed'});
 const present=run('sit outside with Bo');assert.equal(present.code,'capability.choose');assert.match(present.reason,/^"Bo" could not all be invited from here, so nobody was invited/);
 // A4: unchanged readings without a companion
 assert.equal(run('sit outside').code,'capability.choose');assert.equal(run('sit outside').discovery.unresolved,undefined);
});
