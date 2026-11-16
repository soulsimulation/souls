// The launcher homepage (`<base>/`, new worlds): its own lazy chunk with its Clerk, so a world page never downloads
// either (P1 phones: main.tsx loads it only on the homepage).
import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/clerk-react';
import { useEffect, useRef, useState } from 'react';
import { clerkSatelliteOptions, startClerkSignIn } from './clerk-satellite.ts';
import { clerkHomeRoute, homeClerkNow } from './auth-ui.ts';
import { signOutAndReturn } from './clerk-sign-out.ts';
import { BASE } from './base-path.ts';
import { publishSession, type Session } from './auth-session.ts';
import { LauncherHome, type LauncherList } from './god-ui/LauncherHome.tsx';

/** The page, and beside it the sign-in that publishes its session: Clerk when the launcher serves Clerk worlds (creating
 *  a world needs a signed-in creator), else the local name. #2464: the page is never remounted when Clerk arrives. */
export default function LauncherRoot({ list }: { list: LauncherList }) {
  return <><LauncherHome initial={list} /><HomeSession list={list} /></>;
}
function HomeSession({ list }: { list: LauncherList }) {
  const a = list.auth;
  if (a?.provider === 'clerk' && a.clerkPublishableKey) {
    const route = clerkHomeRoute(a.authenticationOrigin, location.origin, BASE);
    if (route.initialize) return <HomeClerkWhenNeeded list={list} publishableKey={a.clerkPublishableKey} />;
    return <Publish session={{ mode: 'clerk', ready: true, authed: false, label: null, signInUrl: route.signInUrl ?? undefined, getToken: async () => null, login: () => { if (route.signInUrl) location.assign(route.signInUrl); }, logout: () => {} }} />;
  }
  const name = localStorage.getItem('sim.dev');
  return <Publish session={{ mode: 'dev', ready: true, authed: !!name, label: name, getToken: async () => name ? 'dev:' + name : null, login: devLogin, logout: () => { localStorage.removeItem('sim.dev'); location.reload(); } }} />;
}
/** Local test launcher: sign in under a typed name (dev auth accepts any; `admin` is an admin). */
function devLogin() {
  const n = (prompt('Sign in locally as (any name):') ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  if (n) { localStorage.setItem('sim.dev', n); location.reload(); }
}
function Publish({ session }: { session: Session }) {
  useEffect(() => { publishSession(session); });
  return null;
}

/** #2464: a sign-in the person asked for on this tab, kept across Clerk's sync and the primary's sign-in page:
 *  `sent` once the sign-in page was opened, so coming back mounts Clerk without opening it again. */
const ASKED = 'soul.home-signin';
type Asked = { t: number; sent: boolean };
function readAsked(): Asked | null { try { const v = JSON.parse(sessionStorage.getItem(ASKED) ?? 'null'); return v && typeof v.t === 'number' ? { t: v.t, sent: !!v.sent } : null; } catch { return null; } }
function writeAsked(v: Asked | null) { try { if (v) sessionStorage.setItem(ASKED, JSON.stringify(v)); else sessionStorage.removeItem(ASKED); } catch { /* private mode: the click still signs in */ } }

/** #2464: a signed-out satellite's Clerk leaves for the primary's sync and loads the homepage again, on every signed-out
 *  visit. So Clerk mounts only when homeClerkNow says so; until then the page is signed out, and Sign in mounts it. */
function HomeClerkWhenNeeded({ list, publishableKey }: { list: LauncherList; publishableKey: string }) {
  const [load, setLoad] = useState(() => homeClerkNow(location.href, document.cookie, readAsked()?.t ?? null, Date.now()));
  if (load) return <ClerkProvider publishableKey={publishableKey} {...clerkSatelliteOptions(list.auth?.clerkSatellite, location.origin)}><HomeClerk list={list} /></ClerkProvider>;
  return <Publish session={{ mode: 'clerk', ready: true, authed: false, label: null, getToken: async () => null, login: () => { writeAsked({ t: Date.now(), sent: false }); setLoad(true); }, logout: () => {} }} />;
}
function HomeClerk({ list }: { list: LauncherList }) {
  const session = useAuth(), clerk = useClerk(), profile = useUser();
  const signingOut = useRef(false), settled = useRef(false);
  const login = () => { if (!signingOut.current) startClerkSignIn(clerk, list.auth?.clerkSatellite, location.href, url => location.assign(url)); };
  // the sign-in asked for before Clerk was here opens once Clerk has loaded (after its sync, when it needed one)
  useEffect(() => {
    if (!session.isLoaded || settled.current) return;
    settled.current = true;
    const asked = readAsked();
    if (asked && !asked.sent && !session.isSignedIn) { writeAsked({ ...asked, sent: true }); login(); } else if (asked) writeAsked(null);
  }, [session.isLoaded]);
  return <Publish session={{ mode: 'clerk', ready: session.isLoaded, authed: session.isLoaded && !!session.isSignedIn, label: profile.user?.primaryEmailAddress?.emailAddress ?? profile.user?.firstName ?? null, avatarUrl: profile.user?.imageUrl ?? null,
    getToken: async () => session.isLoaded && session.isSignedIn ? session.getToken({ skipCache: true }) : null,
    login,
    logout: async () => { if (signingOut.current) return; signingOut.current = true; try { await signOutAndReturn(clerk); } catch (error) { signingOut.current = false; throw error; } } }} />;
}
