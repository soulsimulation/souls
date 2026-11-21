// W11 (#2749): the card's line names the world and the command a fresh agent runs; a row says where a Soul is and
// whether an agent is connected; a picture goes to the directory as base64url.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agoText, base64url, cardLine, nameText, nowText, readNow, whereText, type Mine } from './mine.ts';

const row = (extra: Partial<Mine> = {}): Mine => ({ soul: 'soul-0123456789abcdef0123456789abcdef-0', device: null, world: null, name: null, description: null, picture: null, retire_asked: false, ...extra });

test("the card's line is one paste: the world's address and the pair command", () => {
  const line = cardLine('https://soul.example', 'mars');
  assert.ok(line.includes('node souls.mjs pair https://soul.example/mars'), line);
  assert.ok(!/account|acct_/.test(line), 'no account id on a public page');
});

test('a row says its world and whether an agent is connected, and an asked retire', () => {
  assert.equal(nameText(row()), 'Soul 0');
  assert.equal(nameText(row({ name: 'Oriel' })), 'Oriel');
  assert.equal(whereText(row()), 'no world yet · no agent connected');
  assert.equal(whereText(row({ world: 'mars', device: 'studio laptop', retire_asked: true })), 'in mars · agent connected on studio laptop · its agent asked to retire it');
});

test('a picture is sent as base64url without padding', () => {
  assert.equal(base64url(new Uint8Array([0xfb, 0xff, 0xfe, 0x01])), '-__-AQ');
});

test('C14: the status line is read by grant, public and with nothing but its text and time; quoted with its age', async () => {
  const a = `soul-${'ab'.repeat(16)}-1`, b = `soul-${'ab'.repeat(16)}-2`;
  const seen: unknown[] = [];
  const post = (async (url: string, init: RequestInit) => {
    seen.push([url, JSON.parse(String(init.body)), init.credentials]);
    return new Response(JSON.stringify({ now: { [a]: { text: 'Fishing', at: 1000 }, [b]: { text: 7 }, 'soul-x': { text: 'no', at: 1 } } }));
  }) as typeof fetch;
  const got = await readNow([a, b, a, 'not a grant'], post);
  assert.deepEqual([...got], [[a, { text: 'Fishing', at: 1000 }]], 'only well-formed lines of the Souls asked');
  assert.deepEqual(seen, [['/v1/account/now', { souls: [a, b] }, 'omit']], 'one public request, no cookie');
  assert.equal((await readNow([], post)).size, 0);
  assert.equal((await readNow([a], (async () => { throw new Error('down'); }) as typeof fetch)).size, 0, 'a failure is no line');
  assert.equal(nowText({ text: 'Fishing', at: 1000 }, 1000_000 + 20_000), '“Fishing” · just now');
  assert.equal(agoText(1000, 1000_000 + 12 * 60_000), '12 min ago');
  assert.equal(agoText(1000, 1000_000 + 3 * 3600_000), '3 h ago');
  assert.equal(agoText(1000, 1000_000 + 3 * 86400_000), '3 d ago');
});
