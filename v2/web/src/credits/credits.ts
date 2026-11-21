// N-W7 (#3693): the asset and licence credits page, filled at build time from the CDN's licence records
// (`tools/cdn/approved-derivatives.json`): every third-party source with its licence and where it came from, the files
// derived from each, and the models this repository draws itself. Today's `ImportCredits` (apps/web) thanked the CC0
// artists in the camera help card; this page carries that thanks and the full record behind it.

export type SourceFile = { path: string; licence: string; url?: string };
export type Derivative = { path: string; licence: string; source: string };
export type Records = {
  sources: Record<string, SourceFile[]>;
  derivatives: Derivative[];
  generated?: { licence: string; note?: string; models: { path: string; licence: string; kind?: string }[] };
};

/** Today's thanks (`apps/web/src/ImportCredits.tsx`): CC0 needs no attribution, but the artists are named. */
export const THANKS: readonly { who: string; what: string; url: string }[] = [
  { who: 'Quaternius', what: 'people and their animations (Universal Animation Library 1 & 2), animals, crops, food, boats, bikes, house fixtures, plants and trees', url: 'https://quaternius.com' },
  { who: 'Kenney', what: 'rowboats, canoe, table food and kitchenware, flowers and mushrooms', url: 'https://kenney.nl' },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const link = (url: string, text: string) => (/^https:\/\//.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(text)}</a>` : esc(text));
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The credits section's HTML from the licence records (the template's `<!--credits-->` is replaced by it). */
export function creditsBody(r: Records): string {
  const out: string[] = [];
  out.push('<section class="cr-thanks"><h2>Thank you</h2><p>Many of the people, animals and small things in Souls are CC0 (public domain) models and animations. Thank you:</p><ul>');
  for (const t of THANKS) out.push(`<li>${link(t.url, t.who)}: ${esc(t.what)}</li>`);
  out.push('</ul></section>');
  out.push('<section class="cr-sources"><h2>Sources and licences</h2>');
  for (const [name, files] of Object.entries(r.sources)) {
    const derived = r.derivatives.filter((d) => d.source === name);
    const licences = [...new Set(files.map((f) => f.licence))].join(', ');
    out.push(`<article class="cr-source"><h3>${esc(name)}</h3><p class="cr-licence">Licence: ${esc(licences)}</p><ul>`);
    for (const f of files) out.push(`<li>${f.url ? link(f.url, fileName(f.path)) : esc(fileName(f.path))} <span class="cr-dim">(${esc(f.licence)})</span></li>`);
    out.push('</ul>');
    if (derived.length) out.push(`<details><summary>${derived.length} file${derived.length === 1 ? '' : 's'} made from it</summary><ul>${derived.map((d) => `<li>${esc(d.path)} <span class="cr-dim">(${esc(d.licence)})</span></li>`).join('')}</ul></details>`);
    out.push('</article>');
  }
  out.push('</section>');
  const g = r.generated;
  if (g) {
    out.push(`<section class="cr-own"><h2>Our own models</h2><p>${g.models.length} models are drawn by Souls' own mesh builders, with no third-party bytes in them. Licence: ${esc(g.licence)}.</p>`);
    out.push(`<details><summary>Every model</summary><ul>${g.models.map((m) => `<li>${esc(m.kind ?? fileName(m.path))} <span class="cr-dim">${esc(fileName(m.path))}</span></li>`).join('')}</ul></details></section>`);
  }
  return out.join('\n');
}

/** The credits page: the template with its `<!--credits-->` marker filled. */
export function creditsHtml(template: string, r: Records): string {
  if (!template.includes('<!--credits-->')) throw new Error('credits.html has no <!--credits--> marker');
  return template.replace('<!--credits-->', creditsBody(r));
}

/** The baked models a world's `models.json` draws (`things` → model hash, `kinds[].model`) with no licence record:
 *  each must be in the records' generated models (`models/<hash>.glb`) or a derivative's path. Empty means every
 *  model is credited. */
export function uncredited(models: { things?: Record<string, string | null>; kinds?: { model?: string | null }[] }, r: Records): string[] {
  const known = new Set<string>();
  for (const m of r.generated?.models ?? []) known.add(fileName(m.path).replace(/\.glb$/, ''));
  for (const d of r.derivatives) known.add(fileName(d.path).replace(/\.glb$/, ''));
  const used = new Set<string>();
  for (const h of Object.values(models.things ?? {})) if (h) used.add(h);
  for (const k of models.kinds ?? []) if (k.model) used.add(k.model);
  return [...used].filter((h) => !known.has(h)).sort();
}
