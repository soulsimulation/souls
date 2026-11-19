// W11 (#2749): the card's line names the world and the command a fresh agent runs; a row says where a Soul is and
// whether an agent is connected; a picture goes to the directory as base64url.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, cardLine, nameText, whereText, type Mine } from './mine.ts';

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
