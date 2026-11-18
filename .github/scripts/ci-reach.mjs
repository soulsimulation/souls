// The reach map: which files a change can affect, from the repository's own text (docs/testing.md#ci-scope).
//
// Built over the tree a CI run tests (every tracked file, plus a diff's deletions). Edges:
//   imports  a code file's static imports and re-exports, and require() and import() of a literal; a workspace package
//            name stands for the whole package (its exports map is not read).
//   names    a path the text names: a string literal with a slash or an extension, a template literal's pieces, the
//            literal arguments of a join(), resolve() or URL() call put together (so join(ROOT, 'content', 'kinds')
//            names content/kinds), and in scripts and data the path-like words. Resolved from the file's folder and
//            every folder above it, else by its tail anywhere in the tree. A bare word alone ('mars', 'edge') is a value
//            far more often than a folder and names nothing.
//   unit     every code file reads any data (not code) of its own unit: the nearest package, else its top folder
//            (tools/<x>, mars/<x>, content, docs ...), so data read by a computed name in the same unit still counts.
// A change makes a set of paths content-changed (the change, and list-like data naming a changed file) and a set of
// code and scripts behaviour-changed: changed code; importers of changed code; a file naming a changed file; a file
// naming a folder with changed data under it, or changed code if it lists folders; a loader (computed import, child
// process, worker, bundler, browser) naming changed code it may run; a loader that lists folders naming a folder that
// holds changed code; every code file of a unit whose data changed. A test is affected when it is behaviour-changed.
//
// Certainty over savings: a change the map cannot place (outside the mapped roots, a package or build config, the
// lockfile, a dotfile, a test-harness baseline, an unknown extension) is the caller's cue to run the full battery.
// Over-reach only costs a job; a missed edge would skip one, so each rule adds edges and none removes a literal one.
import { posix } from 'node:path';

const { dirname, normalize, join, basename } = posix;

export const CODE = /\.(?:[cm]?[jt]sx?)$/;
/** Text the map reads for edges (beside code). Binary data is placed, never read. */
export const TEXT = /\.(?:json|jsonl|jsonc|md|txt|ya?ml|css|html|svg|csv|sh|py|glsl|wgsl)$/i;
/** Scripts other files run: they execute, so they carry behaviour like code. */
export const SCRIPT = /\.(?:sh|py)$/;
export const EXEC = /\.(?:[cm]?[jt]sx?|sh|py)$/;
/** Structured data that can list other paths a reader then reads: it changes, for its readers, when what it names does. */
export const LISTS = /\.(?:json|jsonl|jsonc|ya?ml|txt|csv)$/i;
/** Code that runs code it does not import by a literal: a computed import or require, a child process, a worker, a bundler or a browser. */
export const LOADER = /\b(?:import|require)\s*\(\s*(?!['"][^'"\n]*['"]\s*[,)])(?!`[^`$]*`\s*[,)])|child_process|worker_threads|new Worker\b|['"](?:esbuild|vite|playwright(?:-core)?)['"]/;
/** Code that lists folders. */
export const ENUMERATES = /\breaddir(?:Sync)?\b|\bopendir(?:Sync)?\b|\bglob(?:Sync)?\s*\(|\bfs\.glob\b|\bls-files\b/;
/** Test files: no loader runs one by listing a folder (test runners are the CI legs themselves). */
export const TEST = /\.test\.[cm]?[jt]sx?$/;
export const BINARY =/\.(?:png|jpe?g|gif|webp|gz|br|mp4|glb|ktx2|wasm|log)$/i;
/** The roots the map covers. A path outside them (root files other than Markdown, .github, vendor ...) is unplaceable. */
export const ROOTS = ['apps/', 'packages/', 'tools/', 'content/', 'mars/', 'e2e/', 'worlds/', 'docs/', 'changes/', 'scripts/', '.claude/'];
const CONFIG = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|requirements[^/]*\.txt)$/;
/** Test-harness baselines and budgets: a deliberate change re-baselines a gate, so everything runs. */
const BASELINE = /^tools\/test-harness\/(?:.*\/)?[^/]*baseline[^/]*(?:\/|$)/;
const MAX_READ = 4 << 20;

/** Why a changed path cannot be placed in the map (so the full battery runs), or null when it can. */
export function unplaceable(file) {
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return 'not a repository path';
  const root = !file.includes('/');
  if (root ? !/\.md$/.test(file) : !ROOTS.some(r => file.startsWith(r))) return 'outside the reach map';
  if (file.split('/').some(s => s.startsWith('.') && s !== '.claude')) return 'a dotfile or dot folder';
  if (CONFIG.test(file)) return 'a package, workspace or build config';
  if (BASELINE.test(file)) return 'a test-harness baseline';
  if (!CODE.test(file) && !TEXT.test(file) && !BINARY.test(file)) return 'an unknown extension';
  return null;
}

/** The unit a file belongs to: its package folder, else its top folder (two deep under tools/ and mars/), else root. */
export function unitOf(file, packageDirs) {
  for (let d = dirname(file); d !== '.'; d = dirname(d)) if (packageDirs.has(d)) return d;
  const s = file.split('/');
  if (s.length === 1) return '';
  return ['tools', 'mars', '.claude'].includes(s[0]) && s.length > 2 ? `${s[0]}/${s[1]}` : s[0];
}

const ancestors = file => { const out = []; for (let d = dirname(file); d !== '.'; d = dirname(d)) out.push(d); return out; };

const IMPORT = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"`]([^'"`\n$]+)['"`]\s*[,)]/g,
  /\brequire(?:\.resolve)?\s*\(\s*['"`]([^'"`\n$]+)['"`]\s*\)/g,
  /\bimport\.meta\.resolve\s*\(\s*['"`]([^'"`\n$]+)['"`]\s*\)/g,
];
const STRING = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const WORD = /(?:^|[\s=:(,'"`<>])((?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/?)/g;

/** The candidate path strings a text names: string literals (template literals split at their substitutions; a piece
 * after a substitution that starts with `/` continues a path), the literal arguments of a join(), resolve() or URL()
 * call put together as one path, and for non-code text, path-like words too. A bare word ('content', 'edge') counts
 * only inside such a call: alone it is far more often a value than a folder. */
export function mentions(text, code) {
  const out = new Set();
  const add = s => { if (s && (s.includes('/') || /\.[a-z0-9]+$/i.test(s))) out.add(s); };
  for (const m of text.matchAll(STRING)) {
    if (m[3] === undefined) {
      // '/docs' alone is a URL route or an absolute path, never this tree; after `+` it continues a path (ROOT + '/docs')
      const s = m[1] ?? m[2];
      if (s.startsWith('/') && !s.startsWith('//')) { if (/\+\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))) add('.' + s); continue; }
      add(s);
      continue;
    }
    m[3].split(/\$\{[^}]*\}?/).forEach((piece, i) => add(i > 0 && piece.startsWith('/') ? '.' + piece : piece));
  }
  for (const m of text.matchAll(PATH_CALL)) {
    const args = callArgs(text, m.index + m[0].length);
    let i = args.length && !literal(args[0]) ? 1 : 0;
    const run = [];
    for (; i < args.length && literal(args[i]) !== null; i++) run.push(literal(args[i]));
    if (run.length) out.add('./' + run.join('/'));
  }
  if (!code) for (const m of text.matchAll(WORD)) out.add(m[1]);
  return out;
}
const PATH_CALL = /\b(?:join|resolve|URL|joinPath|resolvePath)\s*\(/g;
const literal = a => { const m = /^\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`)\s*$/.exec(a); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
/** The top-level comma-separated arguments of a call whose `(` ends at `at` (strings and nested brackets skipped). */
function callArgs(text, at) {
  const args = [];
  let depth = 0, start = at, q = null;
  for (let i = at; i < text.length && i < at + 2000; i++) {
    const c = text[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth-- === 0) { args.push(text.slice(start, i)); return args; } }
    else if (c === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  return [];
}

/** A candidate string reduced to the path part it can name, or null. Globs and substitutions keep the folder before them. */
export function pathPart(s) {
  if (s.length > 400 || /\s/.test(s) || (/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('file:'))) return null;
  let p = s.replace(/^file:\/\//, '').replace(/^\$\{?\w+\}?\//, './').replace(/[?#].*$/, '');
  const wild = p.search(/[*{}[\]$<>|!]/);
  if (wild >= 0) p = p.slice(0, p.lastIndexOf('/', wild) + 1);
  p = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!p || /^[./]*$/.test(p)) return null;
  return p;
}

/**
 * Builds the map. `files` is every path in the tree, `extra` paths that may be gone from it (a diff's deletions), `read(path)`
 * a file's text or null. Returns { affected(changed) → Set, packageDirs, edges }.
 */
export function buildReach({ files, extra = [], read }) {
  const all = [...new Set([...files, ...extra])].sort();
  const known = new Set(all), dirs = new Set();
  for (const f of all) for (const d of ancestors(f)) dirs.add(d);
  const exists = p => known.has(p) || dirs.has(p);
  const byName = new Map();
  for (const p of [...all, ...dirs]) { const b = basename(p); if (!byName.has(b)) byName.set(b, []); byName.get(b).push(p); }

  const packageDirs = new Set(), packages = new Map();
  for (const f of files) if (basename(f) === 'package.json' && f.includes('/')) {
    packageDirs.add(dirname(f));
    try { const name = JSON.parse(read(f) ?? '{}').name; if (name) packages.set(name, dirname(f)); } catch { /* unreadable: no name */ }
  }

  // imports: target (a file, or a package folder) → importers; names: target (a file or folder) → the files that name it
  const imports = new Map(), names = new Map();
  const put = (map, from, to) => { if (!map.has(to)) map.set(to, new Set()); map.get(to).add(from); };
  const resolveFrom = (file, p) => {
    let hit = false;
    for (const base of [...ancestors(file), '']) {
      const q = normalize(join(base || '.', p.replace(/^\/+/, '')));
      if (q.startsWith('..') || q === '.') continue;
      if (exists(q)) { put(names, file, q); hit = true; }
    }
    return hit;
  };
  // a tail with a folder in it ('app/engine-view/people.ts') names every path ending so. A bare file name ('upload.mjs')
  // names its one candidate, or the candidates under a folder near the file: its own folders inside its unit, and the
  // folders it, or a file it imports, names or imports from. An ambiguous name with none near names nothing: it is
  // joined to a base the file never names (a download, a temporary folder), not to a folder of this tree.
  const byTail = (file, p, near) => {
    const tail = p.replace(/^(?:\.{0,2}\/)+/, '');
    if (!tail || /^[./]*$/.test(tail) || (!tail.includes('/') && !/\.[a-z0-9]+$/i.test(tail))) return;
    let cands = (byName.get(basename(tail)) ?? []).filter(q => q === tail || q.endsWith('/' + tail));
    if (!tail.includes('/') && cands.length > 1) cands = cands.filter(q => ancestors(q).some(d => near().has(d)));
    for (const q of cands) put(names, file, q);
  };
  const EXT = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
  const resolveImport = (file, spec) => {
    spec = spec.replace(/[?#].*$/, '');
    if (spec.startsWith('.')) {
      const q = normalize(join(dirname(file), spec));
      const hit = [...EXT.map(e => q + e), q.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')].find(t => known.has(t));
      if (hit) put(imports, file, hit); else if (!q.startsWith('..')) put(imports, file, q); // dangling: still names the path
      return;
    }
    if (spec.startsWith('node:') || spec.startsWith('/')) return;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (packages.has(name)) put(imports, file, packages.get(name)); // the whole package: its exports map is not read
  };

  const unitFiles = new Map(), loaders = new Set(), enumerators = new Set(), tails = new Map();
  for (const f of all) {
    const u = unitOf(f, packageDirs);
    if (EXEC.test(f)) { if (!unitFiles.has(u)) unitFiles.set(u, []); unitFiles.get(u).push(f); }
  }
  for (const f of files) {
    const code = CODE.test(f), script = SCRIPT.test(f);
    if (!code && !TEXT.test(f)) continue;
    const text = read(f);
    if (text == null || text.length > MAX_READ) continue;
    if (code) for (const re of IMPORT) for (const m of text.matchAll(re)) resolveImport(f, m[1]);
    if (script || (code && LOADER.test(text))) loaders.add(f);
    if (script || (code && ENUMERATES.test(text))) enumerators.add(f);
    const list = [];
    for (const s of mentions(text, code)) {
      const p = pathPart(s);
      if (p && !resolveFrom(f, p)) list.push(p);
    }
    if (list.length) tails.set(f, list);
  }
  const targets = new Map(); // file → the paths it names or imports
  for (const map of [names, imports]) for (const [to, from] of map) for (const f of from) { if (!targets.has(f)) targets.set(f, []); targets.get(f).push(to); }
  for (const [f, list] of tails) {
    let near = null;
    const nearOf = () => {
      if (near) return near;
      const unit = unitOf(f, packageDirs);
      near = new Set(ancestors(f).filter(d => unit && (d === unit || d.startsWith(unit + '/'))));
      const add = to => near.add(dirs.has(to) ? to : dirname(to));
      for (const to of targets.get(f) ?? []) { add(to); if (imports.get(to)?.has(f)) for (const t of targets.get(to) ?? []) add(t); }
      return near;
    };
    for (const p of list) byTail(f, p, nearOf);
  }
  // dynamic: a file that both lists folders and runs code by a computed name, so a folder it names may hold code it runs
  const dynamic = new Set([...loaders].filter(f => enumerators.has(f)));

  /**
   * What a change to `changed` can affect. Two sets: `content` (paths whose bytes or listing changed: the change itself,
   * and structured data that names one of them) and `behaviour` (code and scripts whose result can change: the changed
   * code, its importers, files that name a changed path or run a changed file, dynamic files that name a folder holding
   * changed code, and every code file of a unit whose data changed). A test is affected when it is in `behaviour`.
   */
  function affected(changed) {
    // behaviour splits in two: `code` (the change reached it through code: changed code, its importers and runners) and
    // the rest (it read changed data or text). Only code-reached files feed a folder-listing loader (dynamic): it runs
    // code it finds, and that code changed; a module whose result changed only through data it reads does not.
    const content = new Set(), behaviour = new Set(), code = new Set(), qc = [], qb = [], why = new Map();
    let from = null, via = '';
    const markC = x => { if (!content.has(x)) { content.add(x); qc.push(x); if (from) why.set(x, [from, via]); } };
    const markB = (x, byCode) => {
      const fresh = !behaviour.has(x), upgrade = byCode && !code.has(x);
      if (!fresh && !upgrade) return;
      behaviour.add(x); if (byCode) code.add(x); qb.push(x);
      if (from && fresh) why.set(x, [from, via]);
    };
    for (const f of changed) { markC(f); if (EXEC.test(f)) markB(f, true); }
    while (qc.length || qb.length) {
      while (qc.length) {
        const x = from = qc.shift();
        via = `names ${x}`;
        // a test file is a leaf: only another test reads or runs it (CI tooling that lists tests runs no leg's tests)
        const leaf = TEST.test(x), reader = f => !leaf || TEST.test(f);
        for (const f of names.get(x) ?? []) if (reader(f)) EXEC.test(f) ? markB(f, false) : LISTS.test(f) && !CONFIG.test(f) && markC(f);
        // a folder: a file that lists folders reads anything under it; any other reads only data there, by a computed name
        for (const p of ancestors(x)) { via = `names ${p}`; for (const f of names.get(p) ?? []) if (reader(f) && EXEC.test(f) && (enumerators.has(f) || !EXEC.test(x))) markB(f, false); }
        via = 'reads its unit\'s data';
        if (!EXEC.test(x)) for (const g of unitFiles.get(unitOf(x, packageDirs)) ?? []) markB(g, false);
      }
      while (qb.length) {
        const g = from = qb.shift(), byCode = code.has(g);
        // a package import stands for the package's code, not its tests
        for (const p of TEST.test(g) ? [g] : [g, ...ancestors(g)]) { via = `imports ${p}`; for (const f of imports.get(p) ?? []) markB(f, byCode); }
        via = `runs ${g}`;
        for (const f of names.get(g) ?? []) if (loaders.has(f) && (!TEST.test(g) || TEST.test(f))) markB(f, byCode);
        if (byCode && CODE.test(g) && !TEST.test(g)) for (const p of ancestors(g)) { via = `may load code under ${p}`; for (const f of names.get(p) ?? []) if (dynamic.has(f)) markB(f, true); }
      }
    }
    /** The chain from a changed file to `file`, one step per line. */
    const chain = file => { const out = []; for (let f = file, n = 0; f && n < 50; n++) { const w = why.get(f); out.unshift(w ? `${f}  (${w[1]})` : f); f = w?.[0]; } return out; };
    return { content, behaviour, chain };
  }
  return { affected, packageDirs, packages, imports, names, dynamic, files: all, present: new Set(files) };
}

/** A glob (`*` within a segment, `**` across) as a RegExp over repository paths. A pattern ending in `/` owns its folder. */
export function globRe(glob) {
  if (glob.endsWith('/')) glob += '**';
  const src = glob.split('/').map(seg => seg === '**' ? '\u0000' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/');
  return new RegExp('^' + src.replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000$/, '(?:/.*)?').replace(/\u0000/g, '.*') + '$');
}
