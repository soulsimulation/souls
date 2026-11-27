// First day, 27 Nov: an owner's card with no word of its agent said "Checking…" for good (seen on a phone). After
// CHECKING_MS it says what it is still waiting for: the world's answer, or the world's mailbox itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'souls-soul-card-checking-'));
globalThis.location={origin:'https://soul.game',pathname:'/w/eden/',search:'',hash:''};
globalThis.sessionStorage={getItem:()=>null};
const outfile=join(dir,'card.cjs');
await build({stdin:{contents:`export {SoulCardView,CHECKING_MS,checkingNote} from './SoulCard.tsx';export {CARD_FIXTURES,FIXTURE_CLOCK} from './soul-card-fixtures.ts';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`,resolveDir:new URL('.',import.meta.url).pathname,loader:'tsx'},outfile,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty','.json':'json'},logLevel:'silent'});
const {SoulCardView,CHECKING_MS,checkingNote,CARD_FIXTURES:F,FIXTURE_CLOCK:T,createElement:h,renderToStaticMarkup:render}=require(outfile);
test.after(()=>rm(dir,{recursive:true,force:true}));
const text=html=>html.replace(/<[^>]+>/g,'').replace(/&#x27;/g,"'").replace(/&amp;/g,'&');
const unknown=(extra)=>render(h(SoulCardView,{...F.connected,link:null,here:null,...extra}));

test('no word of the agent yet: Checking…, and nothing more, before CHECKING_MS',()=>{
  const html=unknown({checkingSince:T-CHECKING_MS+1000}),t=text(html);
  assert.match(html,/data-status="checking"/);assert.match(t,/Checking…/);
  assert.doesNotMatch(html,/data-checking-why/);
});
test('after CHECKING_MS: "Not known yet" and what it waits for, the world\'s answer or its mailbox',()=>{
  const reached=unknown({checkingSince:T-CHECKING_MS}),t=text(reached);
  assert.match(t,/Not known yet/);assert.doesNotMatch(t,/Checking…/);
  assert.match(reached,/data-checking-why="agent"/);assert.ok(t.includes(checkingNote(true)));
  const unreached=unknown({checkingSince:T-60_000,inbox:null});
  assert.match(unreached,/data-checking-why="mailbox"/);assert.ok(text(unreached).includes(checkingNote(false)));
});
test('a known link, or the world down, never shows the waiting line',()=>{
  assert.doesNotMatch(render(h(SoulCardView,{...F.connected,checkingSince:T-60_000})),/data-checking-why/);
  assert.doesNotMatch(unknown({checkingSince:T-60_000,unavailable:true}),/data-checking-why/);
});
