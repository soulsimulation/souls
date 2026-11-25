// The launcher's copy of the world page helpers in apps/server/src/inline-config.ts, and the site log's place from
// apps/server/src/moderation/store.ts (0.134 D2: the launcher imports nothing from the old world server).
import { join, resolve } from 'node:path';

/** JSON safe inside an inline <script>: `<` (no `</script>` or `<!--`), U+2028 and U+2029 escaped. */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The world page's HTML with its config set first thing in <head>, before any script that reads it
 *  (`window.__simConfig`, which apps/web/src/inline-config.ts takes). */
export function withInlineConfig(html, config) {
  if (config === null || typeof config !== 'object') return html;
  const at = html.search(/<head[^>]*>/i);
  if (at < 0) return html;
  const end = html.indexOf('>', at) + 1;
  return html.slice(0, end) + `<script>window.__simConfig=${scriptJson(config)}</script>` + html.slice(end);
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** #894: the world page's own title, description, canonical URL and Open Graph/Twitter fields. The web build's index.html
 *  carries the home page's (it is both pages); without this every world page canonicalises to the home page and cannot be
 *  indexed on its own. `url` comes from configuration, never from a request header. */
export function withWorldMeta(html, world) {
  if (!/<link rel="canonical" href="/i.test(html)) return html;   // not the web build's page (a fixture, an old build): left as is
  const title = `${world.name} · Souls`, description = `${world.name}, a persistent world in Souls. Watch it live, or pair your own agent with a Soul and live here.`;
  const set = (tag, value) => { html = html.replace(tag, (_m, a, b) => a + attr(value) + b); };
  html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${attr(title)}</title>`);
  set(/(<link rel="canonical" href=")[^"]*(")/i, world.url);
  set(/(<meta property="og:url" content=")[^"]*(")/i, world.url);
  for (const k of ['og:title', 'twitter:title']) set(new RegExp(`(<meta (?:property|name)="${k}" content=")[^"]*(")`, 'i'), title);
  for (const k of ['description', 'og:description', 'twitter:description']) set(new RegExp(`(<meta (?:property|name)="${k}" content=")[^"]*(")`, 'i'), description);
  return html;
}

/** The site moderation log every world folds (SIM_MODERATION_SITE_LOG, default `<asset dir>/moderation-site.jsonl`). */
export function defaultSiteLog(env = process.env) {
  if (env.SIM_MODERATION_SITE_LOG) return resolve(env.SIM_MODERATION_SITE_LOG);
  const assets = resolve(env.ASSET_DIR ?? join(resolve(env.DATA_DIR ?? './data'), '..', 'assets'));
  return join(assets, 'moderation-site.jsonl');
}
