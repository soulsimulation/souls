// What a book says: its title and first page, so a Soul that reads one can tell its owner what it read.
//
// A book (`eden:book`) carries its title and first page by reference to a row of Eden's library
// (content/library/books.json: two hundred short original books). The world does not write that reference yet (the
// stock that would, content/worlds/eden/stock.json, is not run by the new engine), so a book is given its row here,
// by its id: the same book always reads the same, for every Soul, and neighbouring books differ. A book whose `title`
// field names a library row (`book:<slug>`) reads as that row.
import library from '../../../../content/library/books.json' with { type: 'json' };

const ROWS = library.books;
const BY_ID = new Map(ROWS.map((b) => [b.id, b]));

/** Whether a kind is a book's (`eden:book`, a pinned `eden:book@2`). */
export const isBook = (kind) => /^(?:[a-z0-9_-]+:)?book(?:@\d+)?$/.test(String(kind ?? ''));

/** FNV-1a over the id's characters: a whole number that is the same on every machine. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** `{title, first_page}` of book `id` (its `fields` as the copy holds them, when there are any). */
export function bookText(id, fields = null) {
  const row = (typeof fields?.title === 'string' && BY_ID.get(fields.title)) || ROWS[hash(String(id)) % ROWS.length];
  return { title: row.title, first_page: row.first_page };
}
