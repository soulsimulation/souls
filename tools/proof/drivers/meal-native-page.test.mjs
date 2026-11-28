import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {createHash} from 'node:crypto';
import { wearMealBody, mealBodyReadiness, proveMealCreator, mealWorldPage, mealNodeIdentity, mealArchiveJSON, mealBrowserInstall, mealBrowserStop, mealCheckpoint, mealFinalization } from './meal-native-page.mjs';

class PublicWorker extends EventTarget {
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const inPage = async work => {
  const old = globalThis.window;
  globalThis.window = { Worker: PublicWorker };
  try { await work(window); }
  finally { if (old === undefined) delete globalThis.window; else globalThis.window = old; }
};
const node = (id, extra) => ({ id, kind: id === 'bowl' ? 'eden:soup_bowl@observed' : 'souls:body@observed',
  parent: id === 'bowl' ? 'diner-body' : 'world', slot: id === 'bowl' ? 7 : null, pos: [1, 2, 3], rot: [2 ** 30, 0, 0, 0], ...extra });
const bowl = soup => node('bowl', { fields: { 28: soup } });
const body = () => node('diner-body', { slots: [[7, 200, 950, 0, 0, 1]] });
const expected = { bowl: 'bowl', holder: 'diner-body', soul: 'diner', soup: 2, phase: 'seated' };
function frame(soup = 2, activity = 'sit') {
  return { tick: 20, dt: .05, souls: [{ id: 'diner', entityId: 'visible-diner' }], entities: {
    'visible-diner': { activity, state: { heldEntries: { observedAt: 800000,
      entries: [{ ...bowl(soup), state: { soup } }] } } },
  } };
}

test('native CLI and Worker IDs are reconciled exactly, preserving the original spelling without guessed aliases', async () => inPage(async page => {
  const scope = '0123456789abcdef0123456789abcdef', bowlID = mealNodeIdentity(`${scope}-3`), holder = mealNodeIdentity(`${scope}-12`);
  assert.deepEqual(bowlID, { original: `${scope}-3`, cli: `${scope}-3`, worker: `${scope}.3` });
  assert.equal(mealNodeIdentity(`${scope}.12`).cli, holder.cli);
  assert.equal(mealNodeIdentity(`${scope}-18446744073709551615`).worker, `${scope}.18446744073709551615`);
  for (const bad of ['bowl', `${scope}-03`, `${scope}.1.2`, `${scope}-18446744073709551616`, `${scope.toUpperCase()}-3`, `${scope}-3 trailing`]) assert.throws(() => mealNodeIdentity(bad), /ID format unknown/);
  const identities = { bowl: bowlID, bodies: [holder] };
  mealBrowserInstall({ bowl: bowlID.worker, bodies: [holder.worker], identities });
  const worker = new page.Worker(), native = { ...bowl(2), id: bowlID.worker, parent: holder.worker };
  const input = { t: 'snapshot', s: { nodes: [native, { ...body(), id: holder.worker }] } };
  let unchanged; worker.addEventListener('message', event => { unchanged = event.data; }); worker.message(input);
  assert.equal(unchanged, input); assert.equal(input.s.nodes[0].id, bowlID.worker);
  const drawn = frame(); drawn.entities['visible-diner'].state.heldEntries.entries = [{ ...native, state: { soup: 2 } }];
  page.__soulsEntity = { gameFrame: () => drawn };
  assert(mealCheckpoint({ ...expected, bowl: bowlID.worker, holder: holder.worker }));
  assert.equal(mealCheckpoint({ ...expected, bowl: bowlID.cli, holder: holder.cli }), null, 'browser reads never guess an unconverted alias');
  assert.deepEqual(mealBrowserStop().identities, identities);
}));

test('passive public observation forwards original messages and keeps lossless bounded native records', async () => inPage(async page => {
  const original = page.Worker;
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'], limit: 2 });
  const worker = new page.Worker(), input = { t: 'snapshot', s: { nodes: [bowl(2n), body(), node('unrelated')], removed: [] } };
  let received;
  worker.addEventListener('message', event => { received = event.data; }); worker.message(input);
  assert.equal(received, input, 'the listener does not replace the message or payload');
  assert.deepEqual(input.s.nodes[0].fields, { 28: 2n });
  const observer = page.__mealPayloadObserver;
  assert.equal(observer.messages.length, 1); assert.equal(observer.messages[0].nodes.length, 2);
  assert.deepEqual(observer.messages[0].nodes[0].fields, { 28: { big: '2' } });
  worker.message({ t: 'part', p: { to: 1200000, nodes: [bowl(1)], removed: [] } });
  worker.message({ t: 'part', p: { to: 1300000, nodes: [bowl(0)], removed: [] } });
  assert.equal(observer.messages.length, 2); assert.match(observer.failures[0], /storage limit/);
  const stopped = mealBrowserStop(); assert.equal(page.Worker, original);
  worker.message({ t: 'part', p: { nodes: [], removed: ['bowl'] } });
  assert.equal(observer.messages.length, 2); assert.equal(mealBrowserStop(), stopped);
}));

test('a checkpoint binds same identity, native fields, parent/slot/pose and depicted state without guessing a hand', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'] });
  const worker = new page.Worker(); worker.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  page.__soulsEntity = { gameFrame: () => frame() };
  const checkpoint = mealCheckpoint(expected);
  assert.equal(checkpoint.native.handLabel, null); assert.deepEqual(checkpoint.native.slotRow, [7, 200, 950, 0, 0, 1]);
  assert.equal(checkpoint.native.worldAt, null); assert.equal(checkpoint.depicted.observedAt, 800000);
  assert.equal(checkpoint.depicted.tick, 20);
  worker.message({ t: 'part', p: { to: 1600000, nodes: [bowl(1)] } });
  assert.equal(mealCheckpoint(expected), null, 'current raw quantity cannot be replaced with a stale depicted value');
  page.__soulsEntity.gameFrame = () => frame(1);
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }).native.worldAt, 1600000);
  worker.message({ t: 'part', p: { nodes: [node('diner-body')] } });
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }).native.slotRow, null, 'a missing native slot stays unknown');
  worker.message({ t: 'part', p: { nodes: [], removed: ['bowl'] } });
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }), null);
  mealBrowserStop();
}));

test('ambiguous workers, unknown quantities, mismatched poses and wrong posture cannot qualify a checkpoint', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'] });
  const worker = new page.Worker(); worker.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  page.__soulsEntity = { gameFrame: () => frame(2, 'idle') };
  assert.equal(mealCheckpoint(expected), null);
  page.__soulsEntity.gameFrame = () => frame();
  worker.message({ t: 'part', p: { nodes: [node('bowl', { fields: {} })] } });
  assert.equal(mealCheckpoint(expected), null);
  worker.message({ t: 'part', p: { nodes: [node('bowl', { fields: { 28: 2 }, pos: [9, 2, 3] })] } });
  assert.equal(mealCheckpoint(expected), null);
  worker.message({ t: 'part', p: { nodes: [bowl(2)] } });
  const another = new page.Worker(); another.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  assert.equal(mealCheckpoint(expected), null, 'never guess which matching live/history worker is authoritative');
  mealBrowserStop();
}));

test('observer cleanup caches ownership failures and never overwrites another wrapper', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: [] });
  const replacement = class extends PublicWorker {}; page.Worker = replacement;
  let first; try { mealBrowserStop(); } catch (error) { first = error; }
  assert.match(first.message, /ownership changed/);
  assert.throws(mealBrowserStop, error => error === first); assert.equal(page.Worker, replacement);
}));

for (const mode of ['lost-context', 'missing-observer']) test(`finalization preserves receipts before ${mode} and caches rejection`, async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'meal-finalize-test-')) }, state = { rows: [{ words: ['receipt'], answer: { phase: 'done' } }], checkpoints: [], installed: true };
  let calls = 0;
  mealFinalization({ evaluate: async () => {
    calls++; assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-meal-sequence.json'))).rows, state.rows);
    if (mode === 'lost-context') throw Error('lost context'); return undefined;
  } }, paths, state);
  const first = state.finalize(); assert.equal(state.finalize(), first);
  await assert.rejects(first, mode === 'lost-context' ? /lost context/ : /collection missing/);
  await assert.rejects(state.finalize()); assert.equal(calls, 1);
  assert(readFileSync(join(paths.dir, 'command-meal-finalization-error.json'), 'utf8').includes(mode === 'lost-context' ? 'lost context' : 'collection missing'));
});

test('public world discovery rejects an unrelated or duplicate fixture and never leaves its origin', async () => {
  const original = globalThis.fetch;
  try {
    const row = { name: 'Shared camp meal', template: 'shared-camp-meal', url: '/w/shared-camp-meal/' };
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [row] }) });
    const url = await mealWorldPage({ base: 'https://example.invalid/' }); assert.equal(new URL(url).pathname, row.url);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [row, row] }) });
    await assert.rejects(mealWorldPage({ base: 'https://example.invalid/' }), /unambiguous/);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [{ ...row, url: 'https://other.invalid/w/meal/' }] }) });
    await assert.rejects(mealWorldPage({ base: 'https://example.invalid/' }), /owned origin/);
  } finally { globalThis.fetch = original; }
});


// Decode the documented private archive tags; this is not the Worker/native protocol.
const archiveValue = value => {
  if (Array.isArray(value)) return value.map(archiveValue);
  if (!value || typeof value !== 'object') return value;
  if (value.$mealArchive === 'BigInt') return BigInt(value.decimal);
  if (value.$mealArchive === 'Uint8Array') return Uint8Array.from(value.bytes);
  if (value.$mealArchive === 'undefined') return undefined;
  if (value.$mealArchive === 'object') return Object.fromEntries(value.entries.map(([key,v])=>[key,archiveValue(v)]));
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,archiveValue(v)]));
};

test('move/sample/run-end-only parts and all chair/ancestor/frame records are retained without changing selected latest', async()=>inPage(async page=>{
  mealBrowserInstall({bowl:'bowl',bodies:['diner-body']});
  const worker=new page.Worker(),observer=page.__mealPayloadObserver;
  const chair=node('chair',{kind:'eden:chair',parent:'room',slots:[[1,0,450,0,0,1]],course:Uint8Array.of(1,2)});
  const ancestor=node('room',{kind:'eden:room',parent:'world',pos:[1000,2000,3000],unknownFrameField:{unchanged:true}});
  const initial={t:'snapshot',s:{nodes:[bowl(2),body(),chair,ancestor],removed:[]}};
  const moves={t:'part',p:{number:1,from:100,to:200,nodes:[],removed:[],samples:[],moves:[{body:'diner-body',name:'eat',start:110,ends:[120,180],target:'bowl',run:'run1',limbs:['hand'],contact:'contact',ended:{at:180,how:'done'}}]}};
  const samples={t:'part',p:{number:2,from:200,to:300,samples:[['diner-body','chair',1,250,1,2,3]],courses:{chair:[200,0,0,0,300,1,2,3]},leaves:{chair:350},unknownField:{value:8n}}};
  const runEnds={t:'part',p:{number:3,from:300,to:400,nodes:[],removed:[],samples:[],runEnds:[{body:'diner-body',at:390,how:'done',run:'run1'}]}};
  const delivered=[];worker.addEventListener('message',e=>delivered.push(e.data));
  for(const message of [initial,moves,samples,runEnds])worker.message(message);
  assert.deepEqual(delivered,[initial,moves,samples,runEnds]);assert.equal(observer.messages.length,4);
  assert.deepEqual(observer.messages.map(row=>row.publicMessage),delivered);
  assert.notEqual(observer.messages[0].publicMessage,initial);assert.notEqual(observer.messages[0].publicMessage.s.nodes[2].course,chair.course);
  assert(observer.messages[0].publicMessage.s.nodes[2].course instanceof Uint8Array);
  assert.deepEqual(observer.messages[2].publicMessage.p.samples,samples.p.samples);
  assert.deepEqual(observer.messages[3].publicMessage.p.runEnds,runEnds.p.runEnds);
  assert.equal(observer.workers[0].latest.size,2,'chair ancestors are archived without changing selected-node checkpoint semantics');
  assert.deepEqual(observer.workers[0].latest.get('diner-body').pos,body().pos,'raw samples never synthesize a new node position');
  assert.equal(observer.workers[0].worldAt,400);assert.equal(observer.failures.length,0);
  const archived=archiveValue(JSON.parse(mealArchiveJSON(mealBrowserStop())));
  assert.deepEqual(archived.messages.map(row=>row.publicMessage),delivered);
  assert.equal(samples.p.unknownField.value,8n);assert.deepEqual(chair.course,Uint8Array.of(1,2));
  worker.message(moves);assert.equal(observer.messages.length,4,'cleanup stops archival observation only');assert.equal(delivered.at(-1),moves);
}));

test('private archive tags preserve BigInt/Uint8Array/undefined and cannot impersonate a literal public object',()=>{
  const original={integer:18446744073709551615n,bytes:Uint8Array.of(0,255),present:undefined,literal:{$mealArchive:'BigInt',decimal:'not-a-number'}};
  const decoded=archiveValue(JSON.parse(mealArchiveJSON(original)));
  assert.deepEqual(decoded,original);assert(Object.hasOwn(decoded,'present'));assert(decoded.bytes instanceof Uint8Array);
});

for(const [name,options,message,reason] of [
  ['bytes',{maxBytes:100},{t:'part',p:{nodes:[],samples:[],unknown:'x'.repeat(200)}},/byte limit/],
  ['nodes',{maxNodes:1},{t:'snapshot',s:{nodes:[bowl(2),body()]}},/node limit/],
  ['records',{maxRecords:3},{t:'part',p:{nodes:[],samples:[],moves:[]}},/record limit/],
  ['unsupported binary',{}, {t:'part',p:{nodes:[],samples:[],unknown:new Uint16Array([1,2])}},/unsupported public binary/],
]) test(`full public observation fails visibly before partial retention on ${name}`,async()=>inPage(async page=>{
  mealBrowserInstall({bowl:'bowl',bodies:['diner-body'],...options});const worker=new page.Worker();let delivered;
  worker.addEventListener('message',e=>delivered=e.data);worker.message(message);
  const result=mealBrowserStop();assert.equal(delivered,message);assert.equal(result.messages.length,0);assert.match(result.failures[0],reason);
  assert.deepEqual(result.retained,{publicMessageByteUpperBound:0,nodes:0,records:0});
}));

test('the eight-worker cap remains visible without preventing ordinary worker creation',async()=>inPage(async page=>{
  mealBrowserInstall({bowl:'bowl',bodies:[]});const workers=Array.from({length:9},()=>new page.Worker());
  assert(workers.every(w=>w instanceof PublicWorker));assert.equal(page.__mealPayloadObserver.workers.length,8);
  assert.match(mealBrowserStop().failures[0],/worker observation limit/);
}));

// Independent ordinary public replies; no client/native projection builders are imported.
function creatorFixture({ admits = ['thing'], metadata = true, registry = ['eden:soup_bowl@loaded-revision'], refused = false, names = {1:'placed-bowl'}, sequence = 23, readback = {} } = {}) {
  const calls=[], rows=[];
  const creator={label:'creator',cli:async(...words)=>{
    calls.push(words);
    if(words[0]==='describe' && words.length===1) return {ok:true,nodes:[{id:'ground',kind:'eden:ground',parent:'world'}],
      kinds:{...Object.fromEntries(registry.map(kind=>[kind,{}])),...(metadata?{'eden:ground@ground-revision':{admits}}:{})}};
    if(words[0]==='place') return refused?{ok:false,code:'edit.child-not-admitted'}:{ok:true,sequence,names};
    if(words[0]==='describe') return {ok:true,id:'placed-bowl',kind:'eden:soup_bowl',in:[{id:'ground',kind:'eden:ground'}],at:[12,0,12],...readback};
    throw Error('unexpected public creator command');
  }};
  return {creator,calls,rows,run:()=>proveMealCreator({creator,record:row=>rows.push(row)})};
}

test('creator places the unique loaded revision and reads back only its returned identity and plain kind', async()=>{
  const f=creatorFixture(), proof=await f.run();
  assert.deepEqual(f.calls,[['describe'],['place','eden:soup_bowl@loaded-revision','--in','ground','--at','12,0,12'],['describe','placed-bowl']]);
  assert.equal(proof.requestedKind,'eden:soup_bowl@loaded-revision');assert.equal(proof.readbackKind,'eden:soup_bowl');
  assert.equal(proof.sequence,23);assert.equal(f.rows.length,3);assert.deepEqual(proof.admissionMetadata.admits,['thing']);
});

test('missing optional admission metadata does not override a successful authoritative place',async()=>{
  const f=creatorFixture({metadata:false});assert.equal((await f.run()).admissionMetadata,null);assert.equal(f.calls.length,3);
});

test('optional admission hints are recorded without overruling a successful native edit',async()=>{
  const f=creatorFixture({admits:[]});assert.deepEqual((await f.run()).admissionMetadata.admits,[]);assert.equal(f.calls.length,3);
});

test('creator retains a native refusal and never retries or changes position',async()=>{
  const f=creatorFixture({refused:true});await assert.rejects(f.run(),/edit.child-not-admitted/);
  assert.equal(f.calls.length,2);assert.equal(f.rows.at(-1).answer.code,'edit.child-not-admitted');
});

for(const registry of [[],['eden:soup_bowl'],['eden:soup_bowl@one','eden:soup_bowl@two']]) test(`creator rejects absent, unqualified or ambiguous loaded revision: ${registry.join(',')}`,async()=>{
  const f=creatorFixture({registry});await assert.rejects(f.run(),/revision/);assert.equal(f.calls.length,1);
});

for(const [label,options,why] of [
  ['missing sequence',{sequence:null},/sequence/],['missing identity',{names:{}},/identity/],
  ['wrong identity',{readback:{id:'other'}},/identity/],['qualified readback',{readback:{kind:'eden:soup_bowl@guess'}},/plain kind/],
  ['wrong parent',{readback:{in:[{id:'other-ground'}]}},/parent/],['wrong position',{readback:{at:[12,1,12]}},/position/],
]) test(`creator rejects ${label} without fallback`,async()=>{
  const f=creatorFixture(options);await assert.rejects(f.run(),why);assert.equal(f.calls.filter(words=>words[0]==='place').length,1);
});


function declaredFixture(t,{refused=false,badEntryHash=false,replies,abortPending=false}={}) {
 const root=resolve('.local/meal-body-source-tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'declared-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),kind='ab'.repeat(32),resources=[['souls:hand-left',2,1],['souls:hand-right',2,2],['souls:voice',4]];
 const entry=JSON.stringify({kindHash:kind,resources});writeFileSync(join(dir,'monster.json'),entry);
 const catalogue=JSON.stringify({format:'souls/bodies/1',bodies:[{preset:'monster',hash:kind,entry:'monster.json',entryHash:badEntryHash?'0'.repeat(64):hash(entry)}]});writeFileSync(join(dir,'bodies.json'),catalogue);
 const calls=[],rows=[],controller=new AbortController();let verified=0,index=0;
 // Retained native CLI wear answers sent:true, not phase:done; ordinary receipt carries the terminal answer.
 const sent={ok:true,sequence:2,sent:true,verb:'life:wear',basis:17,at:19,age:681};
 const receipt=answers=>({ok:true,receipt:{sequence:2,verbs:['life:wear'],answers,going:answers.at(-1)?.answer==='accepted'}});
 const sequence=replies??[receipt([]),receipt([{answer:'accepted'},{answer:refused?'refused':'receipt',...(refused?{reason:'body-unknown'}:{})}])];
 return{calls,rows,resources,kind,sent,receipt,run:()=>wearMealBody({seat:{label:'diner',cli:async(...words)=>{
   calls.push(words);if(words[0]==='wear')return sent;const answer=sequence[Math.min(index++,sequence.length-1)];if(abortPending)controller.abort(Error('preparation deadline'));return answer;
 }},bodies:{catalogue:join(dir,'bodies.json'),sha256:hash(catalogue)},verify:()=>verified++,record:row=>rows.push(row),signal:controller.signal}),verified:()=>verified};
}
test('declared meal wear polls its ordinary exact-sequence receipt and preserves sent and pending replies',async t=>{
 const f=declaredFixture(t),r=await f.run();assert.deepEqual(f.calls,[['wear','monster'],['receipt','2'],['receipt','2']]);assert.equal(f.verified(),1);assert.equal(r.hash,f.kind);assert.equal(r.sequence,2);assert.deepEqual(r.resources,f.resources);assert.equal(f.rows.length,3);assert.equal(f.rows[0].answer.sent,true);assert.deepEqual(f.rows[1].answer.receipt.answers,[]);assert.equal(r.receipt.answers.at(-1).answer,'receipt');
});
test('wear refusal and companion drift stop without choosing a substitute body',async t=>{
 const refused=declaredFixture(t,{refused:true});await assert.rejects(refused.run(),/body-unknown/);assert.equal(refused.calls.length,3);assert.equal(refused.rows.at(-1).answer.receipt.answers.at(-1).answer,'refused');
 const drift=declaredFixture(t,{badEntryHash:true});await assert.rejects(drift.run(),/entryHash drift/);assert.equal(drift.calls.length,0);
});
test('sent or pending wear never completes when the existing preparation deadline expires',async t=>{
 const f=declaredFixture(t,{abortPending:true});await assert.rejects(f.run(),/preparation deadline/);assert.deepEqual(f.calls,[['wear','monster'],['receipt','2']]);assert.equal(f.rows.length,2);
});
for(const [label,answer,why]of [
 ['sent acknowledgement',{ok:true,sequence:2,sent:true,verb:'life:wear'},/receipt sequence differs/],
 ['wrong inner sequence',{ok:true,receipt:{sequence:3,verbs:['life:wear'],answers:[{answer:'receipt'}]}},/receipt sequence differs/],
 ['wrong supplied outer sequence',{ok:true,sequence:3,receipt:{sequence:2,verbs:['life:wear'],answers:[{answer:'receipt'}]}},/receipt sequence differs/],
 ['wrong verb',{ok:true,receipt:{sequence:2,verbs:['life:look'],answers:[{answer:'receipt'}]}},/receipt verb differs/],
 ['missing answers',{ok:true,receipt:{sequence:2,verbs:['life:wear']}},/receipt answers missing/],
 ['malformed terminal answer',{ok:true,receipt:{sequence:2,verbs:['life:wear'],answers:[null]}},/receipt answer malformed/],
 ['receipt lookup refusal',{ok:false,code:'receipt-not-found'},/receipt-not-found/],
])test(`wear refuses ${label} instead of treating it as completion`,async t=>{
 const f=declaredFixture(t,{replies:[answer]});await assert.rejects(f.run(),why);assert.equal(f.calls.length,2);assert.equal(f.rows.length,2);
});
test('page qualification requires actual native hash and verified hand mapping while default stays unknown',async()=>inPage(async page=>{
 const hash='ab'.repeat(32),resources=[['souls:hand-left',2,1],['souls:hand-right',2,2]],expected={preset:'monster',hash,resources};
 mealBrowserInstall({bowl:'bowl',bodies:['diner-body','cook-body']});const worker=new page.Worker();worker.message({t:'snapshot',s:{nodes:[node('diner-body',{body:hash}),node('cook-body')]}});
 const drawn={souls:[{id:'diner',entityId:'draw-diner'},{id:'cook',entityId:'draw-cook'}],entities:{'draw-diner':{state:{body:{nativeBody:'diner-body',nativeKindHash:hash,nativeResources:resources}}},'draw-cook':{state:{}}}};
 page.__soulsEntity={gameFrame:()=>drawn};const args={declared:'diner-body',defaultBody:'cook-body',soul:'diner',defaultSoul:'cook',expected};
 assert.equal(mealBodyReadiness(args).nativeHash,hash);drawn.entities['draw-diner'].state.body.nativeResources=[];assert.equal(mealBodyReadiness(args),null,'unverified/missing companion mapping never passes');drawn.entities['draw-diner'].state.body.nativeResources=resources;
 drawn.entities['draw-cook'].state.body={nativeResources:resources};assert.equal(mealBodyReadiness(args),null,'declared mapping must not leak onto default control');mealBrowserStop();
}));


for(const [value,tag] of [[NaN,'NaN'],[Infinity,'positive Infinity'],[-Infinity,'negative Infinity']])
 test(`strict public numeric rejection identifies ${tag} without rewriting delivery`,async()=>inPage(async page=>{
  mealBrowserInstall({bowl:'bowl',bodies:[]});const worker=new page.Worker();let delivered;
  worker.addEventListener('message',event=>delivered=event.data);
  const message={t:'part',p:{nodes:[],moves:[{ends:[12,value]}]}};worker.message(message);
  const result=mealBrowserStop();assert.equal(delivered,message);assert(Object.is(delivered.p.moves[0].ends[1],value));
  assert.equal(result.messages.length,0);assert.equal(result.failures.length,1);assert.match(result.failures[0],/unsupported public nonfinite number/);
  assert.deepEqual(result.rejections,[{worker:0,category:'part',path:['p','moves','0','ends','1'],pathTruncated:false,valueType:'number',nonfinite:tag}]);
  assert.equal(result.retained.records,0);
 }));
test('numeric diagnostics distinguish snapshot workers, unusual keys and bounded paths from normal values',async()=>inPage(async page=>{
 mealBrowserInstall({bowl:'bowl',bodies:[]});const first=new page.Worker(),second=new page.Worker();
 first.message({t:'part',p:{nodes:[],value:12}});const key='x'.repeat(200);
 second.message({t:'snapshot',s:{nodes:[],[key]:{['a/b~c']:Infinity}}});
 const result=mealBrowserStop();assert.equal(result.messages.length,1);assert.equal(result.messages[0].publicMessage.p.value,12);
 assert.deepEqual(result.rejections[0],{worker:1,category:'snapshot',path:['s','x'.repeat(128),'a/b~c'],pathTruncated:true,valueType:'number',nonfinite:'positive Infinity'});
}));
