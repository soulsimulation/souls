// Where the page's own code is loaded from (#4986). A release's script and style files are immutable, content-hashed and
// the same for every viewer, and they are most of what a new viewer downloads; the `soul.game` record is DNS only, so
// each of them came from the host. The built code names its files by where it was loaded from (vite.config.ts builtUrl),
// so the same build runs from the origin or from a copy on the asset CDN, and index.html's loader (phased-entry.ts) asks
// for the copy when the launcher says this build's files are all there (`appCdn` in the inline config,
// tools/world-launcher/cutover.mjs: only once it has seen the set's marker on the CDN). A visitor can add `?appcdn=0` to
// load from the origin; the loader adds it itself, once, when an entry does not load from the CDN.
// No imports: vite.config.ts loads this file in node, and appCdn is serialised into index.html as it stands.

/** The one directory, besides the page's origin, the page's code may be loaded from. */
export const APP_CDN = 'https://cdn.soul.game/assets/app/';

/** The CDN directory holding this build's files when the config names exactly it, else '' (the origin). Self-contained
 *  and plain: the loader carries its text. */
export function appCdn(config: { appCdn?: unknown } | undefined | null, search: string): string {
  return config && config.appCdn === 'https://cdn.soul.game/assets/app/' && !/[?&]appcdn=0(?:&|$)/.test(search) ? 'https://cdn.soul.game/assets/app/' : '';
}
