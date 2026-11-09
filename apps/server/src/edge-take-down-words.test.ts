// #1229: "take down" and "remove" never act on a note, line or poster when the words name a writable thing that isn't
// offered, and keep their free words (a poster's title, a note's author). On the kit's real offers: a notice board, a
// notebook stand and a poster wall placed by the god on hello-hamlet, resolved against the menu the edge builds.
//   node --test apps/server/src/edge-take-down-words.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreRef } from '@souls/world-compiler';
import { bootEden } from '../test/eden-capabilities-timing.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('#1229: take down and remove on real board, notebook and poster wall offers', { timeout: 600000 }, async (t) => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url)); t.after(w.close);
  // (the objects framework that offers a god thing's actions comes with the edge's routes)
  const { Hono } = await import('hono'); const { mountEdgeRoutes, edgeSoulResolver } = await import('./edge/routes.ts');
  const comms = mountEdgeRoutes(new Hono(), { host: w.host, db: w.db, souls: w.souls, soul: edgeSoulResolver(w.host, w.souls, () => undefined), ledger: w.edge } as never); t.after(() => comms.close());
  const p = (w.host.engine as any).world.entities[w.soul.entityId].pose.p;
  const placed: any = w.god.act({ ops: [{ op: 'place', def: coreRef('notice-board', 3), name: 'hall-board', p: [p[0] + 1.2, p[2]] }, { op: 'place', def: coreRef('notebook-stand'), name: 'reading-stand', p: [p[0] - 1.2, p[2]] }, { op: 'place', def: coreRef('poster-wall'), name: 'poster-wall', p: [p[0], p[2] + 1.4] }] } as any, 'boards');
  assert.equal(placed.accepted, true, JSON.stringify(placed));
  await w.settle(40);
  const [board, notebook, wall] = Object.keys(placed.ids).map(id => `object:${id}:unpin`);
  const all = [...(w.edge as any).coreA.wordsMenu(w.soul).caps];
  assert.deepEqual([board, notebook, wall].map(id => all.some((c: any) => c.id === id)), [true, true, true], 'the kit offers all three take-downs');
  const only = (...keep: string[]) => all.filter((c: any) => !c.id.startsWith('object:') || keep.some(k => c.id.startsWith(k.replace(/unpin$/, ''))));
  const say = (words: string, caps: any[]) => { const v = (w.edge as any).coreA.resolveText(w.soul, words, caps); return v.kind === 'unknown' ? { code: v.code, reason: v.reason } : { id: v.cap.id }; };
  const refused = (words: string, caps: any[], word: string) => { const r: any = say(words, caps); assert.equal(r.code, 'capability.unknown', `${words}: ${JSON.stringify(r)}`); assert.match(r.reason, new RegExp(`take down or remove goes by "${word}", so nothing was done`), words); };
  const takes = (words: string, caps: any[], id: string) => assert.deepEqual(say(words, caps), { id }, words);
  // A1: words for a thing that isn't offered do nothing, in the kit's synonyms' spellings (on main each took the board's note,
  // the notebook's line or a poster)
  const boardOnly = only(board), nbOnly = only(notebook), wallOnly = only(wall);
  refused('remove my journal note', boardOnly, 'journal'); refused('take down my note in the notebook', boardOnly, 'notebook');
  refused('take down my note from the guest book', boardOnly, 'guest book'); refused('remove my note from the guestbook', boardOnly, 'guestbook');
  refused('take down my note from the notebook stand', boardOnly, 'notebook'); refused('take down my note in the notebook by the door', boardOnly, 'notebook');
  refused('take down the poster from the notice board', wallOnly, 'board'); refused('take down my line off the pinboard', nbOnly, 'pinboard');
  refused('take down my line from the board', nbOnly, 'board'); refused('take down my line in the diary', nbOnly, 'diary');
  refused('take down my note from the notice board', wallOnly, 'board'); refused('take down my note from the guest book', wallOnly, 'guest book');
  // (a stand named with no kind words: the kit's synonyms, not its name, make it the guest book or visitors book)
  takes('take down my note from the guest book', all, notebook); takes('take down my line in the visitors book', nbOnly, notebook); takes('remove my line from the logbook', nbOnly, notebook);
  takes('remove my note from the pinboard', boardOnly, board);
  // ... and with two of them here, the word names one: "in the notebook" is the notebook's line, never the board's note
  takes('take down my note in the notebook', all, notebook);
  const journal: any = say('remove my journal note', all); assert.notDeepEqual(journal, { id: board }, 'the board note stays');
  // A2: topic and adjective words, a note's author and a named board resolve as on main
  takes('take down my note from the wanted board now', boardOnly, board); takes('take down my note from the notice board', all, board);
  takes("remove Ben's note", boardOnly, board); takes('take down the board games poster', boardOnly, board);
  takes('take down the old poster', wallOnly, wall); takes('take down the board games poster', wallOnly, wall); takes('take down the old poster', all, wall);
  for (const x of ['take down the poster of the book fair', 'take down my poster at the board games corner', 'take down the poster from the board games corner']) takes(x, wallOnly, wall);
  for (const x of ['remove the shopping list note', 'take down my note from the log cabin', 'remove my note on the lost diary', 'take down my note on the wall']) takes(x, boardOnly, board);
  takes('take down my line in the journal', nbOnly, notebook); takes('take down my note in the notebook', nbOnly, notebook);
});
