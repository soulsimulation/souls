// D4 (0.132 Core): the served skill teaches exactly the commands that exist, and stays under 10 kB. Every command the
// skill writes in code (`<command> ...`) is one the client answers: the thin command's (souls.mjs OPS and LOCAL), the
// home's (HOME_COMMANDS), the pictures' and the loader's own (served/loader.mjs: upgrade). Every --flag it names is
// one the client reads. No world, no daemon.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOME_COMMANDS } from '../home/commands.mjs';
import { LOCAL, OPS, requestOf } from './souls.mjs';

const client = join(dirname(fileURLToPath(import.meta.url)), '../..');
const skill = readFileSync(join(client, 'skill/SKILL.md'), 'utf8');
const COMMANDS = new Set([...OPS, ...LOCAL, ...HOME_COMMANDS, 'shoot', 'view', 'map', 'views', 'upgrade']);
// Code spans that are not commands: values, act words and the event pattern the skill quotes.
const NOT_COMMANDS = /^(node eden\.mjs|in 10m|which-soul|ok: (true|false)|<|'\{|20:00|stopped-locally|not-connected)/;

/** Each code span that reads as a command line: a lowercase word, then arguments. */
const spans = [...skill.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const commands = spans.filter((s) => /^[a-z][a-z-]*( |$)/.test(s) && !NOT_COMMANDS.test(s) && (s.includes(' ') || COMMANDS.has(s)));

test('the skill is under 10 kB', () => {
  assert.ok(Buffer.byteLength(skill) < 10_000, `${Buffer.byteLength(skill)} bytes`);
});

test('every command the skill teaches exists', () => {
  const unknown = commands.filter((c) => !COMMANDS.has(c.split(' ')[0]));
  assert.deepEqual(unknown, [], 'commands the skill teaches that the client does not have');
  for (const c of ['look', 'here', 'find', 'act', 'listen', 'pending', 'ack', 'pair', 'say']) assert.ok(commands.some((s) => s.split(' ')[0] === c), `the skill teaches ${c}`);
  assert.match(skill, /node eden\.mjs <command>/, 'the served file is eden.mjs');
  assert.doesNotMatch(skill, /souls\.mjs/, 'no other name for the client');
});

test('the daemon commands it teaches parse, with their flags', () => {
  // A quoted JSON list stands as one; a placeholder as an id; an optional part's brackets go.
  const words = (c) => c.replace(/'[^']*'/g, 'JSONLIST').replace(/"[^"]*"/g, 'x').replace(/<(sequence|cursor|minutes)>/g, '7').replace(/<[^>]*>/g, 'ab-1').replace(/\[|\]|\.\.\./g, ' ')
    .split(/\s+/).filter(Boolean).map((w) => (w === 'JSONLIST' ? '[]' : w));
  for (const c of commands) {
    const w = words(c);
    if (!OPS.includes(w[0])) continue;
    const r = requestOf(w);
    assert.equal(r.refused, undefined, `${c}: ${r.detail}`);
  }
  assert.equal(requestOf(['act', 'sit:ab-1', '--for', 'm1', '--wait']).wait, true, 'act --for --wait');
  assert.deepEqual(requestOf(['listen', '--follow']).req, { op: 'listen', follow: true });
  assert.deepEqual(requestOf(['here']).req, { op: 'look' });
});
