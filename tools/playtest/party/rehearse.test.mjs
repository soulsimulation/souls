import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completed, partyTemplate, performParty } from './rehearse.mjs';

const receipt = () => ({ ok: true, phase: 'done', receipt: { answers: [{ answer: 'receipt' }] } });

test('the party cannot count a pending or refused intent as a completed action', () => {
  assert.throws(() => completed({ ok: true, phase: 'started' }, 'dance'), /started/);
  assert.throws(() => completed({ ok: false, code: 'body-in-activity' }, 'dance'), /body-in-activity/);
});

test('the scene uses the existing jukebox shape and places it outside the dance space', () => {
  const entry = JSON.parse(readFileSync(new URL('../../../content/kinds/music/jukebox.json', import.meta.url)));
  const scene = partyTemplate(entry), [definition, placement] = scene.batches[0].ops;
  assert.equal(definition.def.name, 'core-jukebox');
  assert.equal(definition.def.make.args.shapes.length, entry.looks.shape.shapes.length);
  assert(placement.p[0] - entry.geometry.bounds_mm[0] / 2000 > 3);
});

test('an early departure that ends everyone’s dance fails before a success report', async () => {
  const calls = [], seats = Array.from({ length: 5 }, (_, index) => ({ label: String(index), body: `body-${index}`,
    cli: async (...words) => {
      calls.push([index, ...words]);
      if (words[0] === 'say') return { ok: true, sequence: 1, to: { sequence: 2 } };
      if (words[0] === 'events') return { events: [{ kind: 'heard', words: calls.findLast((row) => row[1] === 'say')?.[2] }] };
      if (words[0] === 'inspect') return { state: { on: 0 } };
      if (words[0] === 'look') return { ok: true, doing: calls.some((row) => row[1] === 'together' && row[2] === 'leave') ? [] : ['you are in dance-together with the group (started)'] };
      return receipt();
    },
  }));
  await assert.rejects(performParty({ seats, mode: 'silent', jukebox: 'jukebox', pause: async () => {} }), /other four keep dancing/);
  assert(!calls.some((row) => row[2]?.startsWith('switch_off:')));
});

 test('silent mode refuses a jukebox that is already on instead of claiming silence', async () => {
  const seats = Array.from({length:5},(_,i)=>({label:String(i),body:`body-${i}`,cli:async(...words)=>{
    if(words[0]==='say') return {ok:true,sequence:1,to:{sequence:2}};
    if(words[0]==='events') return {events:[{kind:'heard',words:i===1?'Welcome! Would you like to dance?':'Yes, let us dance together!'}]};
    if(words[0]==='inspect') return {state:{on:1}};
    return receipt();
  }}));
  await assert.rejects(performParty({seats,jukebox:'jukebox',mode:'silent',pause:async()=>{}}),/remain off/);
});
