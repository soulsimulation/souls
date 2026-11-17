// Tests for schedules as data (Soul Actions SA-F16, #2854). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as F from './format.mjs';

const H = 3_600_000_000;
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && e.reason.includes(word)), `expected a refusal at ${path} (${word}), got ${JSON.stringify(errors)}`);
};
const base = (kind, hours) => ({format: F.FORMAT, kind, owner: 'thing',
  state: {hours: {n: 1, type: 'schedule', most: 14, default: hours, audience: {rule: 'everyone'}}},
  links: {}, forms: {}, text: {card: 'Hours a Soul can read.'}, card: {text: 'card'}});
const shop = () => base('test:stall', [
  {repeat: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], from_us: 9 * H, to_us: 17 * H},
  {repeat: 'weekly', days: ['sat'], from_us: 10 * H, to_us: 14 * H},
  {repeat: 'once', from_us: 5_000 * H, to_us: 5_006 * H}]);
const klass = () => base('test:pottery_class', [
  {repeat: 'weekly', days: ['tue'], from_us: 18 * H, to_us: 20 * H},
  {repeat: 'weekly', days: ['thu'], from_us: 18 * H, to_us: 20 * H}]);

test('A1: a shop states its hours and a weekly class its sittings', () => {
  assert.deepEqual(F.validateEntry(shop()), []);
  assert.deepEqual(F.validateEntry(klass()), []);
  const a = shop(); a.state.hours.default[0].days = ['mon', 'funday'];
  refused(a, 'state.hours.default.0.days', 'different days');
  const b = shop(); b.state.hours.default[0].to_us = 25 * H;
  refused(b, 'state.hours.default.0.to_us', 'at most a day');
  const c = shop(); c.state.hours.default[1].to_us = 9 * H;
  refused(c, 'state.hours.default.1.to_us', 'after from_us');
  const d = shop(); d.state.hours.default[2].days = ['sun'];
  refused(d, 'state.hours.default.2.days', 'unknown key');
  const e = shop(); e.state.hours.most = 2;
  refused(e, 'state.hours.default', 'the most is 2');
  const f = shop(); f.state.hours.default[0].from_us = 9.5 * H + 0.5;
  assert.ok(F.validateEntry(f).length);
  const g = shop(); g.state.hours.default[0].repeat = 'daily';
  refused(g, 'state.hours.default.0.repeat', 'once, weekly');
  assert.ok(F.stateAtMax(shop()).values === 42);
});

test('A2: a calendar entry validates, its words by reference, interest as a link', () => {
  const entry = JSON.parse(readFileSync(new URL('../../content/kinds/calendar/entry.json', import.meta.url), 'utf8'));
  assert.deepEqual(F.validateEntry(entry), []);
  assert.equal(entry.state.words.type, 'text');
  assert.equal(entry.links.interested.from, 'soul');
  assert.deepEqual(entry.forms.show_interest.effects.map(e => e.change), ['link']);
  const a = structuredClone(entry); a.forms.post.effects[1].to = 'Come to the lecture';
  refused(a, 'forms.post.effects.1.to', 'inline words');
  const b = structuredClone(entry); b.state.words.default = 'Lecture at noon';
  refused(b, 'state.words.default', 'inline words');
  assert.ok(F.hashKinds([entry]).get(entry.kind).ref);
});

test('A3: a form with a start time or a condition is refused, naming the field', () => {
  const entry = () => JSON.parse(readFileSync(new URL('../../content/kinds/calendar/entry.json', import.meta.url), 'utf8'));
  const a = entry(); a.forms.show_interest.at_us = 9 * H;
  refused(a, 'forms.show_interest.at_us', 'no start time');
  const b = entry(); b.forms.show_interest.when = {weekday: 'mon'};
  refused(b, 'forms.show_interest.when', 'waits for no condition');
  const c = entry(); c.forms.post.steps = [{step: 'wait_until', us: H}];
  refused(c, 'forms.post.steps.0.step', 'waits for no condition');
  const d = entry(); d.forms.post.needs.push({need: 'time'});
  refused(d, 'forms.post.needs.1.need', 'no start time');
  const e = entry(); e.forms.post.steps = [{step: 'wait', until: 9 * H}];
  refused(e, 'forms.post.steps.0.until', 'no start time');
  const f = entry(); f.forms.post.effects.push({change: 'set', field: 'start', to: 1, event: 'x', after: H});
  refused(f, 'forms.post.effects.4.after', 'unknown key');
  const g = shop(); g.forms = {open_up: {who: 'anyone', starts: 'act', needs: [], steps: [], effects: [{change: 'set', field: 'hours', to: {arg: 'h'}, event: 'x'}], takes: {h: {type: 'duration'}}}};
  refused(g, 'forms.open_up.effects.0.to', 'a form does not write one');
  // What stays allowed: a stated pause, a timer the world sets, a move's place.
  const ok = entry(); ok.forms.post.steps = [{step: 'wait', us: H}];
  assert.deepEqual(F.validateEntry(ok), []);
});
