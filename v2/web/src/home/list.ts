// The front door's one list (Engine v2 O19, #2830): the worlds of both systems, from the directory's `GET /v1/worlds`
// (W3) and today's `/__sim/worlds.json`. Every world opens at /w/<slug>/ on the public name; the proxy sends a slug the
// directory lists to the new system and any other to today's launcher, so a slug both name is the new system's here too.
// front-check.mjs reads the same two answers through this module, so the page and the check agree.
import { worldAddress } from '../source/address.ts';

export type Row = { slug: string; name: string; href: string; system: 'v2' | 'today'; note: string };
export type DirectoryList = { worlds?: { name: string; label?: string; template?: string; awake?: boolean; ready?: boolean }[] };
export type TodayList = {
  worlds?: { slug: string; name?: string; unlisted?: boolean; souls?: number | null }[];
  auth?: { clerkSatellite?: { signInUrl?: string } };
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** One list from both answers (either may be missing: its worlds are then left out). */
export function rows(directory: DirectoryList | null, today: TodayList | null): Row[] {
  const out: Row[] = [], seen = new Set<string>();
  for (const w of directory?.worlds ?? []) {
    if (!SLUG.test(w.name) || seen.has(w.name)) continue;
    seen.add(w.name);
    const note = [w.label, w.template, w.awake === undefined ? '' : w.awake ? 'awake' : 'asleep'].filter(Boolean).join(' · ');
    out.push({ slug: w.name, name: w.name, href: `/w/${w.name}/`, system: 'v2', note });
  }
  for (const w of today?.worlds ?? []) {
    if (w.unlisted || !SLUG.test(w.slug) || seen.has(w.slug)) continue;
    seen.add(w.slug);
    out.push({ slug: w.slug, name: w.name || w.slug, href: `/w/${w.slug}/`, system: 'today', note: w.souls ? `${w.souls} Souls` : '' });
  }
  return out;
}

/** Preview-only directory rows must not replace today's canonical world before activation. */
export async function canonicalRows(directory: DirectoryList | null, today: TodayList | null, origin: string, get: typeof fetch = fetch): Promise<Row[]> {
  const candidates = (directory?.worlds ?? []).filter(w => w.ready !== false && SLUG.test(w.name));
  const active = await Promise.all(candidates.map(async w => {
    try { return await worldAddress(new URL(`/w/${w.name}/`, origin).href, get) ? w : null; } catch { return null; }
  }));
  return rows(directory ? { ...directory, worlds: active.filter((w): w is NonNullable<typeof w> => w !== null) } : null, today);
}

/** The sign-in link: the primary origin's bridge, returning to `here` (the page it left). Null without a bridge. */
export function signInHref(today: TodayList | null, here: string): string | null {
  const at = today?.auth?.clerkSatellite?.signInUrl;
  if (!at) return null;
  try {
    const u = new URL(at);
    u.searchParams.set('redirect_url', here);
    return u.href;
  } catch {
    return null;
  }
}
