// A book's title and first page, from Eden's library by the book's id (books.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookText, isBook } from './books.mjs';

const library = JSON.parse(readFileSync(new URL('../../../../content/library/books.json', import.meta.url), 'utf8')).books;

test('a book reads as one row of the library, the same every time, and books differ', () => {
  const a = bookText('cd5ce79e0e0cf90b312c5ba60b941f58-5724');
  assert.ok(library.some((b) => b.title === a.title && b.first_page === a.first_page), 'a row of content/library/books.json');
  assert.ok(a.title.length > 0 && a.first_page.split('. ').length >= 3, 'a title and a first page of a few sentences');
  assert.deepEqual(bookText('cd5ce79e0e0cf90b312c5ba60b941f58-5724'), a, 'the same book reads the same');
  const titles = new Set(Array.from({ length: 20 }, (_, k) => bookText(`cd5ce79e0e0cf90b312c5ba60b941f58-${8600 + k}`).title));
  assert.ok(titles.size >= 15, `twenty books from one shelf are mostly different books: ${titles.size}`);
});

test('a book whose title field names a library row reads as that row', () => {
  const row = library[7];
  assert.deepEqual(bookText('any-1', { title: row.id }), { title: row.title, first_page: row.first_page });
  assert.deepEqual(bookText('any-1', { title: null }), bookText('any-1'), 'no title: by its id');
});

test('only a book is a book', () => {
  assert.equal(isBook('eden:book'), true);
  assert.equal(isBook('eden:book@2'), true);
  for (const k of ['eden:bookcase', 'eden:bookshelf', 'eden:book_stack', 'eden:flipbook', null]) assert.equal(isBook(k), false, String(k));
});
