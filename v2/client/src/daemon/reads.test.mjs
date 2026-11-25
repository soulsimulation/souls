// #3704: query, catalog and context on a copy's rows, and the CLI's request for each, with batch and views.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUDGET, NEAR_METRES, catalog, context, metresFrom, placeOf, query } from './reads.mjs';
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

test('#3851: near keeps what is within its metres of an id, a name or me, from the poses composed up the tree', () => {
  const ONE = 2 ** 30, half = Math.round(ONE * Math.SQRT1_2), m = 1e6;
  const at = (id, name, kind, parent, pos, rot) => [id, { id, name, kind, parent, path: [], children: 0, pos, ...(rot ? { rot } : {}) }];
  const posed = new Map([
    at('z', 'Eden', 'eden:world', null, [0, 0, 0]),
    // The square is turned a quarter about y: its +x is the world's -z.
    at('sq', 'the square', 'eden:place', 'z', [100 * m, 0, 0], [half, 0, half, 0]),
    at('f', 'fountain', 'eden:fountain', 'sq', [10 * m, 0, 0]),
    at('b', 'bench', 'eden:bench', 'sq', [0, 0, 50 * m]),
    at('far', 'far bench', 'eden:bench', 'z', [500 * m, 0, 0]),
    at('me', 'Ada', 'souls:body', 'z', [100 * m, 0, -12 * m]),
  ]);
  const p = placeOf(posed, 'f').pos.map((c) => Math.round(c / m));
  assert.deepEqual(p, [100, 0, -10], 'turned with its parent');
  assert.equal(NEAR_METRES, 80, "today's radius");
  const q = query(posed, [{ kind: 'eden:bench', near: 'the square' }, { find: 'fountain', near: 'me', within: 5 }, { find: 'bench', near: 'me', within: 1 }, { kind: 'eden:bench', near: 'nobody' }], { me: 'me' });
  assert.deepEqual(q.answers[0].found.map((r) => [r.id, r.metres]), [['b', 50]], 'the far bench is past 80 m');
  assert.deepEqual(q.answers[0].near, { id: 'sq', name: 'the square', within: 80 });
  assert.deepEqual(q.answers[1].found.map((r) => [r.id, r.metres]), [['f', 2]]);
  assert.deepEqual(q.answers[2].found, []);
  // first-day E5: none within the radius names the nearest anywhere, so far is never read as none
  assert.deepEqual(q.answers[2].nearest, { id: 'b', name: 'bench', kind: 'eden:bench', metres: 51 });
  assert.equal(q.answers[0].nearest, undefined, 'found within: no nearest beyond');
  assert.deepEqual(query(posed, [{ kind: 'eden:bench', near: 'me', within: 10 }], { me: 'me' }).answers[0].nearest.id, 'b');
  assert.equal(q.answers[3].code, 'query.unknown-near');
  assert.equal(query(posed, [{ find: 'fountain', near: 'me' }]).answers[0].code, 'query.unknown-near', 'no body: me is not placed');
});

test('first-day E5: find\'s metres, from the Soul to anything placed; a zone at the ground\'s origin has none', () => {
  const m = 1e6, at = (id, parent, pos) => [id, { id, name: id, kind: 'k', parent, path: [], children: 0, ...(pos ? { pos } : {}) }];
  const rows = new Map([at('g', null, null), at('zone', 'g', [0, 0, 0]), at('me', 'g', [1 * m, 0, 0]), at('house', 'g', [30 * m, 0, 40 * m]), at('shelf', 'house', [0, 0, 0])]);
  const placed = metresFrom(rows, 'me', { placed: true }), any = metresFrom(rows, 'me');
  assert.equal(Math.round(placed(rows.get('shelf'))), 49, 'at its house\'s origin, placed by the house');
  assert.equal(placed(rows.get('zone')), undefined);
  assert.equal(any(rows.get('zone')), 1, 'near queries keep every pose');
  assert.equal(metresFrom(rows, 'nobody'), null);
});
