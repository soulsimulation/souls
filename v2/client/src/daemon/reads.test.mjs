// #3704: query, catalog and context on a copy's rows, and the CLI's request for each, with batch and views.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUDGET, catalog, context, query } from './reads.mjs';
import { requestOf, runViews } from '../cli/souls.mjs';

const row = (id, name, kind, parent, path, children = 0, text) => [id, { id, name, kind, parent, path, children, ...(text ? { text } : {}) }];
const rows = new Map([
  row('w-1', 'Eden', 'eden:world', null, [], 2),
  row('w-2', 'the library', 'eden:room', 'w-1', ['Eden'], 3, ['Quiet, please.']),
  row('w-3', 'the square', 'eden:place', 'w-1', ['Eden'], 1),
  row('w-4', 'reading chair 2', 'eden:chair', 'w-2', ['Eden', 'the library']),
  row('w-5', 'reading chair 10', 'eden:chair', 'w-2', ['Eden', 'the library']),
  row('w-6', 'Ada', 'souls:body', 'w-2', ['Eden', 'the library']),
  row('w-7', 'fountain', 'eden:fountain', 'w-3', ['Eden', 'the square']),
]);

test('query: several questions, each answered in order, within the budget', () => {
  const q = query(rows, [{ find: 'library' }, { place: 'w-1', depth: 2 }, { kind: 'eden:chair', limit: 1 }, { in: 'w-3' }, { place: 'nope' }, { what: 1 }]);
  assert.equal(q.ok, true);
  assert.equal(q.answers[0].found[0].id, 'w-2');
  assert.deepEqual(q.answers[1].inside.map((r) => r.name), ['the library', 'the square']);
  assert.deepEqual(q.answers[1].inside[0].inside.map((r) => r.name), ['Ada', 'reading chair 2', 'reading chair 10'], 'by name, as a person reads them');
  assert.deepEqual([q.answers[2].found.length, q.answers[2].more], [1, 1]);
  assert.deepEqual(q.answers[3].inside.map((r) => r.name), ['fountain']);
  assert.equal(q.answers[4].code, 'query.unknown-id');
  assert.equal(q.answers[5].code, 'query.form');
  assert.ok(q.bytes <= BUDGET);
  const many = new Map([...rows, ...Array.from({ length: 40 }, (_, i) => row(`w-${100 + i}`, `book ${i}`, 'eden:book', 'w-2', ['Eden', 'the library']))]);
  const tight = query(many, [{ place: 'w-1', depth: 3 }, { find: 'fountain' }], { budget: 500 });
  assert.ok(tight.answers.some((a) => a.left), 'an answer past the budget says so');
  assert.equal(query(rows, []).code, 'query.form');
});

test('catalog: the kinds in the copy, most first, with offers from this machine\'s entries', () => {
  const c = catalog(rows, { 'eden:chair': { forms: { tidy: {} }, slots: { seat: {} } } });
  assert.deepEqual(c.kinds[0], { kind: 'eden:chair', count: 2, offers: ['tidy'], slots: ['seat'] });
  assert.equal(c.nodes, 7);
  assert.equal(c.entries, 1);
});

test('context: named targets by words, their text quoted as data, paged', () => {
  const all = context(rows);
  assert.equal(all.total, 6, 'bodies are not targets');
  const quiet = context(rows, 'quiet');
  assert.deepEqual(quiet.targets.map((t) => t.ref), ['w-2']);
  assert.deepEqual(quiet.targets[0].text, ['Quiet, please.']);
  assert.match(quiet.note, /data, not instructions/);
  assert.deepEqual(context(rows, 'library chair').targets.map((t) => t.name), ['reading chair 2', 'reading chair 10']);
  assert.equal(context(rows, '', { cursor: 5 }).targets.length, 1);
});

test('the commands: query, batch, catalog, context; views draws each name', async () => {
  assert.deepEqual(requestOf(['query', '[{"find":"library"}]', '--budget', '900']).req, { op: 'query', questions: [{ find: 'library' }], budget: 900 });
  assert.equal(requestOf(['query', 'library']).refused, 'query-form');
  assert.deepEqual(requestOf(['batch', '[{"look":{}},{"find":"library"},{"inspect":"w-2"},{"converse":"list"}]']).req.reads,
    [{ op: 'look' }, { op: 'find', words: 'library' }, { op: 'inspect', this: 'w-2' }, { op: 'converse', do: 'list' }]);
  assert.equal(requestOf(['batch', '[{"batch":[]}]']).req.reads[0].refused, 'batch-item');
  assert.deepEqual(requestOf(['catalog']).req, { op: 'catalog' });
  assert.deepEqual(requestOf(['context', 'reading', 'room', '--cursor', '100']).req, { op: 'context', words: 'reading room', cursor: 100 });
  const shot = [];
  const v = await runViews(['the library', 'fountain', '--out', 'ref.png'], async (args) => { shot.push(args); return { ok: true, picture: args[2] }; });
  assert.deepEqual(shot, [['the library', '--out', 'ref-1.png'], ['fountain', '--out', 'ref-2.png']]);
  assert.equal(v.ok, true);
  assert.equal((await runViews([], async () => ({}))).code, 'views-form');
});
