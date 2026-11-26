// X2 (0.134): copied from v2/web/src/source/signin.ts for the pairing card the old page builds.
// The page's sign-in (Engine v2 V13c, #3418): the same provider script today's site loads (clerk-js, as
// `@clerk/react`'s loader builds its address), behind the same configuration (`window.__simConfig`, which the
// server writes into the page: `authProvider: 'clerk'`, `clerkPublishableKey`, `clerkIssuer`, and `clerkSatellite` on
// a satellite domain). Signed in, the page's session is the provider's, a fresh token asked of the script at each
// exchange (`socket.ts`). Signed out, the provider's own sign-in opens and comes back to this page. Without that
// configuration there is no provider; a local world signs in with `as=<test person>` instead.
/** A signed-in session, as `v2/web/src/source/socket.ts` names it. */
export type Session = { bearer: () => Promise<string> } | { testName: string };

/** The part of today's page configuration the sign-in reads. */
export type SignInConfig = {
  authProvider?: string;
  clerkPublishableKey?: string;
  clerkIssuer?: string;
  clerkSatellite?: { domain: string; signInUrl: string };
};

/** The provider's script as the page loads it: its address, its UI's address and the attributes it is given. */
export type ProviderScript = { src: string; uiSrc: string; attributes: Record<string, string> };

/** The major version of clerk-js today's site loads (`@clerk/react` 6, Clerk Core 3). */
export const CLERK_JS_MAJOR = '6';
/** The major version of Clerk's UI (`@clerk/ui`), which Core 3 loads beside clerk-js for its sign-in modal. */
export const CLERK_UI_MAJOR = '1';

/** The provider's frontend host a publishable key names (`pk_test_…`/`pk_live_…`: base64 of `<host>$`). */
export function frontendApi(key: string): string | null {
  const m = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(key);
  if (!m) return null;
  try {
    const host = atob(m[2].replace(/-/g, '+').replace(/_/g, '/'));
    return /^[a-z0-9.-]+\$$/.test(host) ? host.slice(0, -1) : null;
  } catch {
    return null;
  }
}

/** A satellite's options, as today's site gives them (`clerk-satellite.ts`): only on the satellite's own origin. */
export function satelliteOptions(cfg: SignInConfig, origin: string): { isSatellite: true; domain: string; signInUrl: string } | null {
  const s = cfg.clerkSatellite;
  if (!s || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(s.domain) || origin !== `https://${s.domain}`) return null;
  try {
    const primary = new URL(s.signInUrl);
    if (primary.protocol !== 'https:' || primary.username || primary.password || primary.search || primary.hash || primary.origin === origin) return null;
    return { isSatellite: true, domain: s.domain, signInUrl: primary.href };
  } catch {
    return null;
  }
}

/**
 * The provider's script for this configuration, or null when the page has no provider (the same rule as today's
 * site: `authProvider` is `clerk` and both the publishable key and the issuer are set). On a satellite with a live key
 * the script comes from the satellite's own `clerk.` host, as `@clerk/react` loads it.
 */
export function providerScript(cfg: SignInConfig, origin: string): ProviderScript | null {
  if (cfg.authProvider !== 'clerk' || !cfg.clerkPublishableKey || !cfg.clerkIssuer) return null;
  const api = frontendApi(cfg.clerkPublishableKey);
  if (!api) return null;
  const sat = satelliteOptions(cfg, origin);
  const live = cfg.clerkPublishableKey.startsWith('pk_live_');
  const host = sat && live ? `clerk.${sat.domain}` : api;
  const attributes: Record<string, string> = { 'data-clerk-publishable-key': cfg.clerkPublishableKey };
  if (sat) attributes['data-clerk-domain'] = sat.domain;
  return { src: `https://${host}/npm/@clerk/clerk-js@${CLERK_JS_MAJOR}/dist/clerk.browser.js`,
    uiSrc: `https://${host}/npm/@clerk/ui@${CLERK_UI_MAJOR}/dist/ui.browser.js`, attributes };
}

type ProviderIdentity = { id?: string; user?: { id?: string }; getToken(): Promise<string | null> };
type IdentityState = { session?: ProviderIdentity | null; user?: { id?: string } | null };
/** Optional browser observation; socket Session stays unchanged. */
export type BrowserSession = Session & { subscribeIdentity?: (changed: () => void) => () => void };

/** What the page uses of the provider's script once loaded (`window.Clerk`). */
export type Provider = {
  load(options?: object): Promise<void>;
  session?: ProviderIdentity | null;
  user?: { id?: string } | null;
  addListener?(listener: (state: IdentityState) => void): () => void;
  openSignIn(options: { forceRedirectUrl: string; signUpForceRedirectUrl: string }): void;
  buildSignInUrl(options: { signInForceRedirectUrl: string; signUpForceRedirectUrl: string }): string;
};

/** The page around the sign-in: its document, address and global scope (a test passes its own). */
export type PageEnv = {
  document: { createElement(tag: 'script'): HTMLScriptElement; head: { appendChild(n: Node): unknown } };
  href: string;
  global: { Clerk?: Provider; __internal_ClerkUICtor?: unknown };
  navigate(url: string): void;
};

/**
 * Loads the provider's script and signs in from it. Resolves to the provider's session when signed in; when signed
 * out, opens the provider's sign-in (back to this page after) and resolves to null; null too without a provider.
 */
export async function providerSession(cfg: SignInConfig, env: PageEnv, silent = false): Promise<BrowserSession | null> {
  const origin = new URL(env.href).origin;
  const script = providerScript(cfg, origin);
  if (!script) return null;
  const add = (src: string, attributes: Record<string, string>) => new Promise<void>((ok, fail) => {
    const el = env.document.createElement('script');
    el.src = src;
    el.async = true;
    el.crossOrigin = 'anonymous';
    for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
    el.addEventListener('load', () => ok());
    el.addEventListener('error', () => fail(new Error('no sign-in: the provider script did not load')));
    env.document.head.appendChild(el);
  });
  // Clerk Core 3: the sign-in modal lives in Clerk's UI script, handed to load beside clerk-js.
  await Promise.all([env.global.Clerk ? null : add(script.src, script.attributes), env.global.__internal_ClerkUICtor ? null : add(script.uiSrc, {})]);
  const clerk = env.global.Clerk;
  if (!clerk) throw new Error('no sign-in: the provider script did not start');
  const sat = satelliteOptions(cfg, origin);
  await clerk.load({ ...(sat ?? {}), ui: { ClerkUI: env.global.__internal_ClerkUICtor } });
  const session = clerk.session;
  if (session) {
    const identityOf = ({ session, user }: IdentityState) => session ? String(session.id) + '/' + String(user?.id ?? session.user?.id ?? '') : null;
    const initial = identityOf({ session, user: clerk.user });
    return {
      bearer: async () => (await clerk.session?.getToken()) ?? '',
      subscribeIdentity(changed) {
        if (!clerk.addListener) throw new Error('Sign-in cannot observe account changes. Reload to try again.');
        let active = true;
        const check = (state: IdentityState) => {
          if (active && identityOf(state) !== initial) { active = false; changed(); }
        };
        // Detect both a change before registration and one during addListener's initial delivery.
        const unsubscribe = clerk.addListener(check);
        check({ session: clerk.session, user: clerk.user });
        return () => { active = false; unsubscribe(); };
      },
    };
  }
  // `silent` (the card's first look, trial of 0.137): signed out, nothing opens; the Sign in button stays.
  if (silent) return null;
  // Signed out: the provider's sign-in, back to this page. A satellite leaves for the primary's, as today's site does.
  if (sat) env.navigate(clerk.buildSignInUrl({ signInForceRedirectUrl: env.href, signUpForceRedirectUrl: env.href }));
  else clerk.openSignIn({ forceRedirectUrl: env.href, signUpForceRedirectUrl: env.href });
  return null;
}

/** Test identities exist only on the directory's existing plain-HTTP loopback setup. */
export function localTestSignIn(href: string): boolean {
  const u = new URL(href);
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname));
}

/** Installed static pages obtain public provider fields from their own origin; no credentials accompany config. */
export async function signInConfig(post: typeof fetch = fetch): Promise<SignInConfig> {
  const r = await post('/v1/auth/config', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  if (!r.ok) throw new Error('Sign-in is not configured. Ask the operator to configure the public provider.');
  const cfg = await r.json() as SignInConfig;
  if (!providerScript(cfg, 'https://config.invalid')) throw new Error('Sign-in configuration is invalid. Ask the operator to check the public provider.');
  return cfg;
}

/** The existing provider session, or explicit local test sign-in; never a copied or persisted raw token. */
export async function browserSession(testName?: string, env?: PageEnv, post: typeof fetch = fetch, silent = false): Promise<BrowserSession | null> {
  const page = env ?? { document, href: location.href, global: globalThis as PageEnv['global'], navigate: (u: string) => location.assign(u) };
  let cfg: SignInConfig;
  try { cfg = await signInConfig(post); }
  catch (e) {
    if (localTestSignIn(page.href) && testName?.trim()) return { testName: testName.trim() };
    throw e;
  }
  // A configured provider never falls back to a test identity when signed out or unavailable.
  return providerSession(cfg, page, silent);
}

/** Fresh provider bearer on every call; local account test names retain the directory's existing body shape. */
export async function sessionRequest(session: Session, kind: 'account' | 'world', body: Record<string, unknown> = {}): Promise<RequestInit> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if ('bearer' in session) {
    const token = await session.bearer();
    if (!token) throw new Error('Sign-in expired. Sign in again.');
    headers.authorization = `Bearer ${token}`;
  } else if (kind === 'world') headers.authorization = `Bearer test:${session.testName}`;
  else body = { ...body, test_person: session.testName };
  return { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'error' };
}
