// The kinds' looks for the page (#3871): from each `souls-entry/1` file in content/kinds, the part the page draws with
// (its kind, its state fields and its `looks`), one small JSON file per kind at `assets/kinds/<namespace>/<name>.json` (under assets/, which the proxy serves beside a world's page),
// emitted into the build and served by `vite` and `vite preview`. The page fetches a kind's file the first time a thing
// of that kind with no baked model appears (src/kinds/catalogue.ts). Forms, text and the rest stay with the world.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

export const KIND_ROOT = resolve(import.meta.dirname, '../../content/kinds');
const NAME = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
const STATE_KEYS = ['n', 'type', 'values', 'min', 'max', 'unit', 'default'];

function files(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : f.endsWith('.json') ? [p] : [];
  });
}

/** Each kind's drawing file, by its path under `kinds/`. A file that is not an entry, or names a kind twice, is left out. */
export function kindEntryFiles(root = KIND_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files(root)) {
    const e = JSON.parse(readFileSync(file, 'utf8'));
    if (e.format !== 'souls-entry/1' || typeof e.kind !== 'string' || !NAME.test(e.kind)) continue;
    const path = `${e.kind.replace(':', '/')}.json`;
    if (out.has(path)) continue;
    const state = Object.fromEntries(Object.entries((e.state ?? {}) as Record<string, Record<string, unknown>>)
      .map(([k, f]) => [k, Object.fromEntries(STATE_KEYS.filter((x) => x in f).map((x) => [x, f[x]]))]));
    out.set(path, JSON.stringify({ kind: e.kind, state, ...(e.looks ? { looks: e.looks } : {}) }));
  }
  return out;
}

export function kindEntries(root = KIND_ROOT): Plugin {
  let cached: Map<string, string> | null = null;
  const all = () => (cached ??= kindEntryFiles(root));
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const m = /^\/assets\/kinds\/([a-z][a-z0-9_]*\/[a-z][a-z0-9_]*\.json)(\?|$)/.exec(req.url ?? '');
    if (!m) return next();
    const body = all().get(m[1]);
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  };
  return {
    name: 'v2-kind-entries',
    configureServer: (s) => void (s.watcher.add(root), s.watcher.on('change', (f) => f.startsWith(root) && (cached = null)), s.middlewares.use(serve)),
    configurePreviewServer: (s) => void s.middlewares.use(serve),
    generateBundle() {
      for (const [path, body] of all()) this.emitFile({ type: 'asset', fileName: `assets/kinds/${path}`, source: body });
    },
  };
}
