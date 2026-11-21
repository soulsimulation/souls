// #3780: index.html paints the boot card with the page's first frame, titled with the world, never on a `?shot` page or
// a history moment, and takes it away once the arrival card is up or the page has said something else for 600 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('boot-arrival'))!;

type El = { id: string; textContent: string; removed: boolean; attrs: Record<string, string>; innerHTML: string; title: El | null;
  setAttribute(k: string, v: string): void; querySelector(s: string): El | null; remove(): void };
const el = (id = ''): El => ({ id, textContent: '', removed: false, attrs: {}, innerHTML: '', title: null,
  setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return this.title ??= el(); }, remove() { this.removed = true; } });

function boot(href: string) {
  const u = new URL(href), status = el('status'), body: El[] = [], ids = new Map<string, El>([['status', status]]);
  let tick: (() => void) | null = null, now = 1000;
  const document = { createElement: () => el(), body: { appendChild: (e: El) => body.push(e) }, getElementById: (id: string) => ids.get(id) ?? null };
  const clock = { now: () => now };
  new Function('location', 'document', 'setInterval', 'clearInterval', 'Date', script)(
    { search: u.search, hash: u.hash, pathname: u.pathname }, document, (f: () => void) => ((tick = f), 1), () => (tick = null), clock);
  const card = body.find((e) => e.id === 'boot-arrival') ?? null;
  return { card, status, step(ms: number) { now += ms; tick?.(); }, mount: () => ids.set('arrival', el('arrival')), get polling() { return tick !== null; } };
}

test('the boot card shows the world from ?world=, the path, or Souls', () => {
  assert.equal(boot('http://localhost/?world=harbour').card?.title?.textContent, 'harbour');
  assert.equal(boot('https://soul.game/w/eden/').card?.title?.textContent, 'eden');
  assert.equal(boot('http://localhost/?stream=/s/x/').card?.title?.textContent, 'Souls');
  assert.equal(boot('http://localhost/?world=<b>x</b>').card?.title?.textContent, '<b>x</b>'); // plain text, never markup
});

test('a ?shot page and a history moment never show it', () => {
  assert.equal(boot('http://localhost/?world=eden&shot=1').card, null);
  assert.equal(boot('http://localhost/?world=eden#w=eden&l=ab&t=5').card, null);
});

test('it goes the moment the arrival card is up', () => {
  const b = boot('http://localhost/?world=eden');
  b.step(50);
  assert.equal(b.card!.removed, false);
  b.mount();
  b.step(50);
  assert.equal(b.card!.removed, true);
  assert.equal(b.polling, false);
});

test('without the arrival card it goes 600 ms after the page has said something else', () => {
  const b = boot('http://localhost/?world=eden');
  b.step(2000);
  assert.equal(b.card!.removed, false); // still "starting": scripts loading
  b.status.textContent = 'waiting for the stream';
  b.step(50);
  b.step(500);
  assert.equal(b.card!.removed, false);
  b.step(150);
  assert.equal(b.card!.removed, true);
});
