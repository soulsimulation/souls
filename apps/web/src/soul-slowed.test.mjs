// #456: the Soul chip and card say when the world slows or refuses that Soul, and say nothing once `until` has passed.
// Static renders from the card fixtures (soul-card-fixtures.ts); no effects run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'souls-soul-slowed-'));
globalThis.location={origin:'https://sim.eden.art',pathname:'/worlds/w/eden-2026/',search:'',hash:''};
globalThis.sessionStorage={getItem:()=>null};
const outfile=join(dir,'slowed.cjs');
await build({stdin:{contents:`export {SoulCardView} from './SoulCard.tsx';export {SoulChip} from './SoulChip.tsx';export {CARD_FIXTURES,FIXTURE_CLOCK} from './soul-card-fixtures.ts';export {readSlowed,slowedText} from './soul-state.ts';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:new URL('.',import.meta.url).pathname,loader:'tsx'},outfile,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty','.json':'json'},logLevel:'silent'});
const {SoulCardView,SoulChip,CARD_FIXTURES:F,readSlowed,slowedText,createElement:h,renderToStaticMarkup:render}=require(outfile);
const text=html=>html.replace(/<[^>]+>/g,'').replace(/&#x27;/g,"'");

test('reader: only the three reasons with a time; the line clears at until',()=>{
 assert.deepEqual(readSlowed({reason:'world.busy',until:5}),{reason:'world.busy',until:5});
 for(const bad of [null,{},{reason:'soul.busy',until:5},{reason:'world.busy'},{reason:'world.busy',until:'x'}])assert.equal(readSlowed(bad),null);
 assert.equal(slowedText({reason:'world.busy',until:10},5),'waiting: the world is busy');
 assert.equal(slowedText({reason:'world.crowded',until:10},5),'waiting: the world is crowded');
 assert.match(slowedText({reason:'soul.slow-down',until:10},5),/^waiting: .*slowed it down$/);
 assert.equal(slowedText({reason:'world.busy',until:10},10),null);
});

test('A2: the chip shows the line in place of the status while it applies, and the status after',()=>{
 const later=Date.now()+60_000,base={kind:'follow',name:'Ada',status:'walking to the pond',openCard(){}};
 const on=render(h(SoulChip,{...base,slowed:{reason:'world.busy',until:later}}));
 assert.match(text(on),/Adawaiting: the world is busy/);assert.match(on,/role="status"/);assert.match(on,/data-slowed="1"/);
 const off=render(h(SoulChip,{...base,slowed:{reason:'world.busy',until:Date.now()-1}}));
 assert.match(text(off),/walking to the pond/);assert.doesNotMatch(off,/data-slowed|waiting:/);
 assert.match(text(render(h(SoulChip,base))),/walking to the pond/,'A3: no slowed, unchanged');
});

test('A2/A3: the card adds one line while slowed, for owner and visitor; without it every state renders as before',()=>{
 for(const name of Object.keys(F)){
  const plain=render(h(SoulCardView,F[name]));
  assert.doesNotMatch(plain,/soul-slowed/,`${name}: unchanged without slowed`);
  const slowed=render(h(SoulCardView,{...F[name],soul:{...F[name].soul,slowed:{reason:'soul.slow-down',until:Date.now()+60_000}}}));
  assert.equal(slowed.replace(/<p class="soul-slowed[^"]*"[^>]*>[^<]*<\/p>/,''),plain,`${name}: only the line is added`);
 }
});
