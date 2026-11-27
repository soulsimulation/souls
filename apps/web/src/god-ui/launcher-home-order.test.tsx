import test from 'node:test'; import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LauncherHome, type LauncherList, type LauncherWorldCard } from './LauncherHome.tsx';

Object.assign(globalThis, { location: { origin: 'https://sim.example', pathname: '/', search: '', hash: '' } });
const card = (slug: string, souls: number | null, entities: number | null): LauncherWorldCard => ({ slug, name: slug, basePath: `/w/${slug}`, url: `/w/${slug}/`,
  template: 'empty', templateName: 'Empty', createdAt: 1, god: false, souls, entities, seq: null, status: 'running', restarts: 0 });

// 26 Nov: a world the new engine runs lists its Souls and no "things" count; the page re-sorted by things, so Eden (4 Souls,
// first in the list) went below an old world with 1 Soul and 900 things
test('the homepage keeps the list\'s order, whatever each world\'s things count', () => {
  const list: LauncherList = { contract: 'local-worlds/1', launcher: 'test', templates: [],
    worlds: [card('eden', 4, null), card('old-busy', 1, 900), card('quiet', null, null)] };
  const html = renderToStaticMarkup(<LauncherHome initial={list}/>);
  const at = (slug: string) => html.indexOf(`href="/w/${slug}/"`);
  assert.ok(at('eden') >= 0 && at('old-busy') >= 0 && at('quiet') >= 0, 'every card drawn');
  assert.ok(at('eden') < at('old-busy') && at('old-busy') < at('quiet'), 'in the list\'s order');
  assert.match(html, /data-world-souls="4"/, 'Eden shows its Souls');
});
