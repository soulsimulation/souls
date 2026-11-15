import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { staleBundle } from './useSouls.ts';

/** A page whose tab is hidden, with a reload counter and tab storage. */
function hiddenPage() {
  const g = globalThis as Record<string, unknown>, saved = { document: g.document, location: g.location, sessionStorage: g.sessionStorage };
  const store = new Map<string, string>(); let reloads = 0;
  g.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
  g.location = { reload: () => { reloads++; } };
  g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  return { reloads: () => reloads, store, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } } };
}

test('#2368 A2: a compatible release never reloads the page, however long the tab stays hidden', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const page = hiddenPage();
  try {
    staleBundle('we-new', false);
    mock.timers.tick(10 * 60_000);
    assert.equal(page.reloads(), 0);
  } finally { page.restore(); mock.timers.reset(); }
});

test('#2368: a protocol change still reloads at once, once per build', () => {
  const page = hiddenPage();
  try {
    staleBundle('we-next', true);
    assert.equal(page.reloads(), 1); assert.equal(page.store.get('sim.reloaded'), 'we-next');
  } finally { page.restore(); }
});
