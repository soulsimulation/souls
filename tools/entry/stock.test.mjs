// Tests for stock (Soul Actions SA-F12, #2851). Each test is one acceptance item of the issue; the cases are data in
// packages/form-rules/cases/stock/stock.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as F from './format.mjs';

const doc = JSON.parse(readFileSync(new URL('../../packages/form-rules/cases/stock/stock.json', import.meta.url), 'utf8'));
const copy = v => structuredClone(v);
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};

test('Step 0: a bookshelf, a wardrobe, a fridge and a market stall are stock of kinds, counts and a refill rate', () => {
  assert.equal(F.SECTIONS.stock, 15);
  for (const [name, e] of Object.entries(doc.kinds)) assert.deepEqual(F.validateEntry(e), [], name);
  assert.deepEqual(F.kindRefs(doc.kinds['test:bookshelf']), ['test:book']);
  assert.ok(F.hashKinds([...Object.values(doc.kinds), ...['book', 'coat', 'milk', 'apple'].map(n => ({format: F.FORMAT, kind: `test:${n}`, owner: 'thing'}))]).size >= 8);
});

for (const c of doc.cases) {
  test(c.name, () => {
    const entry = doc.kinds[c.kind];
    let got;
    if (c.take) got = F.takeStock(entry, {name: c.take, fields: c.fields, opened: c.opened ?? true, receipt: c.receipt});
    else if (c.list) got = {listed: F.stockOf(entry, {fields: c.fields, opened: c.opened})};
    else got = {count: F.refilled(entry, c.refill.stock, c.refill.from, c.refill.us)};
    assert.deepEqual(Object.fromEntries(Object.keys(c.expect).map(k => [k, got[k]])), c.expect);
  });
}

test('A1: taking is one batch, the make and the count lowered by one, and a shelf of 40 ends at 39', () => {
  const shelf = doc.kinds['test:bookshelf'];
  let fields = {books: 40};
  for (let i = 1; i <= 40; i++) {
    const r = F.takeStock(shelf, {name: 'books', fields, receipt: `t${i}`});
    assert.equal(r.ok, true);
    assert.equal(r.changes.reduce((a, c) => a + (c.by ?? 0), 0), -1);
    fields = {books: r.changes[1].to};
  }
  assert.equal(fields.books, 0);
  assert.equal(F.takeStock(shelf, {name: 'books', fields, receipt: 'last'}).code, 'empty');
});

test('A2: a take form that does not refuse an empty stock, or sets the count itself, or makes something else, is refused', () => {
  const shelf = doc.kinds['test:bookshelf'];
  let e = copy(shelf); e.forms.take_book.needs = e.forms.take_book.needs.filter(n => n.need !== 'state'); refused(e, 'stock.books.take', 'empty');
  e = copy(shelf); e.forms.take_book.needs = e.forms.take_book.needs.filter(n => n.need !== 'hand'); refused(e, 'stock.books.take', 'free hand');
  e = copy(shelf); e.forms.take_book.effects.push({change: 'set', field: 'books', to: 99, event: 'cheat'}); refused(e, 'stock.books.take', 'does not set');
  e = copy(shelf); e.forms.take_book.effects[0].kind = 'test:coat'; refused(e, 'stock.books.take', 'makes one test:book');
  e = copy(shelf); e.forms.take_book.effects[0].into = 'here'; refused(e, 'stock.books.take', 'actor_hand');
  e = copy(shelf); e.stock.books.take = 'nowhere'; refused(e, 'stock.books.take', 'names the form');
});

test('A2: a stock is a count that runs out and refills only by a stated rate', () => {
  const shelf = doc.kinds['test:bookshelf'];
  let e = copy(shelf); delete e.state.books.max; refused(e, 'stock.books.count', 'runs out');
  e = copy(shelf); e.state.books.min = 1; refused(e, 'stock.books.count', 'runs out');
  e = copy(shelf); e.state.books.default = 61; refused(e, 'stock.books.count');
  e = copy(shelf); e.stock.books.refill = {every_us: 0}; refused(e, 'stock.books.refill.every_us', 'above zero');
  e = copy(shelf); e.stock.books.refill = {per_s: 1}; refused(e, 'stock.books.refill.per_s', 'unknown key');
  e = copy(shelf); e.stock.books.price = 3; refused(e, 'stock.books.price', 'unknown key');
  e = copy(shelf); e.stock.books.carries = []; refused(e, 'stock.books.carries');
});

test('a stock\'s take form is paid by its count: the check gate finds no "makes" in it, and still finds one in any other free make', async () => {
  const C = await import('./check.mjs');
  const makes = e => C.checkText(JSON.stringify(e)).findings.filter(f => f.rule === 'makes').map(f => f.path);
  for (const [name, e] of Object.entries(doc.kinds)) assert.deepEqual(makes(e), [], name);
  const e = copy(doc.kinds['test:bookshelf']);
  e.forms.conjure = {...copy(e.forms.take_book), needs: [], effects: [{...e.forms.take_book.effects[0]}]};
  assert.deepEqual(makes(e), ['forms.conjure.effects.0'], 'a make outside the take form is still paid for or found');
});
