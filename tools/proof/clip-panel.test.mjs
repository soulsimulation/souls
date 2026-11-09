// #1644: the debug panel shows the exchange in order, and never device details, tokens or private ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizePanel, makeRedactor, panelHtml, panelStates, summarizeReply } from './clip-panel.mjs';
import { publicationFindings } from './publication.mjs';
import { concatList, overlayGraph, timecodeSprite } from '../../.claude/skills/proof/record.mjs';

test('redaction: URLs, home and temp paths, tokens, emails, IPs and private ids', () => {
  const r = makeRedactor();
  const leaks = [
    'register http://127.0.0.1:4745/w/p1645', 'folder /Users/someone/Souls/.local/soul', 'cwd ~/agent/x', 'tmp /private/tmp/claude-1/x',
    'authorization: Bearer dev:admin-secret', 'token=abcdef0123456789abcdef', 'mail me@example.org', 'at 192.168.1.20:22', 'C:\\Users\\me\\x',
    'key 4f9c2b7d1e8a3f6c5b0d9e2a1c7f4b8d',
  ];
  for (const t of leaks) { const out = r(t); assert.equal(publicationFindings([out]).length, 0, `${t} -> ${out}`); assert.ok(out.includes('<'), `${t} -> ${out}`); }
  assert.equal(r('soul s_6cae1a1b94 then s_6cae1a1b94 and s_0000aaaa11'), 'soul soul-1 then soul-1 and soul-2', 'the same id keeps its ordinal');
  assert.equal(r('receipt r_85d3f2c6-d823-4bf8-a846-6af96a1f8488 completed'), 'receipt receipt-1 completed');
  assert.equal(r('carry:e_f4e88500'), 'carry:entity-1');
  assert.ok(r('x'.repeat(400)).length <= 160);
});

test('finalizePanel: time order, redaction, and the publication check on what is left', () => {
  const { entries, findings } = finalizePanel([
    { at: 2.5, dir: 'reply', text: 'accepted · receipt r_1234567890 started' }, { at: 1, dir: 'cmd', text: 'eden act walk:knoll' },
    { at: 2.5, dir: 'receipt', text: 'receipt r_1234567890 completed' }, { at: -1, dir: 'cmd', text: 'before the take' },
  ]);
  assert.deepEqual(entries.map((e) => [e.at, e.dir]), [[1, 'cmd'], [2.5, 'reply'], [2.5, 'receipt']]);
  assert.match(entries[1].text, /receipt-1/); assert.deepEqual(findings, []);
  const planted = finalizePanel([{ at: 1, dir: 'note', text: 'leak' }], { redact: (t) => t, findings: () => ['ssh target'] });
  assert.deepEqual(planted.findings, ['ssh target'], 'a hit that survives redaction is reported (the recorder fails the take)');
});

test('summarizeReply: one line from the world\'s JSON', () => {
  assert.equal(summarizeReply('{"accepted":true,"now":"idle; not finished yet","receipt":{"id":"r_1","phase":"started"}}'), 'accepted · receipt r_1 started · now: idle; not finished yet');
  assert.equal(summarizeReply('{"accepted":false,"code":"carry.target-blocked"}'), 'refused carry.target-blocked');
  assert.equal(summarizeReply('plain', 2), 'error (exit 2) plain');
});

test('panel states and timing: each state lasts until the next change; durations sum to the clip', () => {
  const e = [{ at: 1, dir: 'cmd', text: 'a' }, { at: 1.4, dir: 'reply', text: 'b' }, { at: 1.4, dir: 'receipt', text: 'c' }, { at: 9, dir: 'receipt', text: 'd' }];
  const st = panelStates(e, 10);
  assert.deepEqual(st.map((s) => [s.start, s.end, s.shown.length]), [[0, 1, 0], [1, 1.4, 1], [1.4, 9, 3], [9, 10, 4]]);
  const list = concatList(st, st.map((_, k) => `/w/panel-${k}.png`));
  assert.match(list, /^ffconcat version 1\.0\nfile 'panel-0\.png'\nduration 1\.000\n/);
  assert.equal(list.match(/^duration /gm).length, 4); assert.match(list, /file 'panel-3\.png'\n$/);
  assert.ok(!list.includes('/w/'), 'only basenames in the list');
  const html = panelHtml(st[3].shown, { side: 'right' });
  assert.ok(html.indexOf('a</span>') < html.indexOf('d</span>'), 'oldest first, newest at the bottom');
  assert.match(html, /font:14px/); assert.match(html, /border-left/); assert.match(panelHtml([], { side: 'bottom' }), /border-top/);
});

test('the graph stacks the panel, then puts the chip and line on the whole frame; fps last; scaled chip', () => {
  const sprite = timecodeSprite(10, undefined, 1.5);
  assert.deepEqual(sprite.cell, { width: 198, height: 36 });
  const g = overlayGraph({ width: 1920, durationSec: 10, sprite, panel: { side: 'right', width: 576, height: 1080 }, world: { width: 1344, height: 1080 }, fps: 30, scale: 1.5 });
  assert.match(g, /\[0:v\]scale=1344:1080,setsar=1\[w\];\[2:v\]fps=25,scale=576:1080,setsar=1\[p\];\[w\]\[p\]hstack=inputs=2:shortest=1\[s\]/);
  assert.match(g, /\[s\]\[tc\]overlay=x=12:y=H-h-18/); assert.match(g, /color=c=0xffc400:s=1920x6/); assert.match(g, /shortest=1,fps=30$/);
  const v = overlayGraph({ width: 1080, durationSec: 10, sprite: null, panel: { side: 'bottom', width: 1080, height: 576 }, world: { width: 1080, height: 1344 } });
  assert.match(v, /\[1:v\]fps=25,scale=1080:576/); assert.match(v, /vstack=inputs=2/); assert.doesNotMatch(v, /fps=\d+$/);
  assert.equal(overlayGraph({ width: 1280, durationSec: 12, sprite: timecodeSprite(12) }), overlayGraph({ width: 1280, durationSec: 12, sprite: timecodeSprite(12), fps: null }), 'pr-proof graph unchanged');
});

test('speech ids and other short-prefixed ids become ordinals; plain words with underscores stay', () => {
  const r = makeRedactor();
  assert.equal(r('said sp_3hyw_biUal0i then p_50xyzw and sp_3hyw_biUal0i'), 'said speech-1 then program-1 and speech-1');
  assert.equal(r('go_home and wait_for it'), 'go_home and wait_for it');
  assert.equal(summarizeReply('{"said":{"id":"sp_1","channel":{"kind":"earshot"},"heardBy":["a","b"]}}'), 'said (earshot, heard by 2)');
  assert.equal(summarizeReply('{"capability":"carry:e_1","phase":"completed","endedAt":{"placePath":["Main Hall","World"]}}'), 'carry:e_1 completed at Main Hall');
});
