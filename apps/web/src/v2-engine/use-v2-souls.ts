// Stage 3 (#4153): useSouls for a world the new engine runs. Same `Souls` shape as the old socket's, so Shell, LiveWorld,
// the renderer and the camera read it unchanged: `takes` from the v2 stream (bridge.ts), the Souls the stream's bodies
// name, and a Connection that is never connected (its welcome, replica and stats set from the stream instead).
// Switched on by the world's inline config naming its v2 stream (`__simConfig.v2Stream`, a same-origin `/s/…/` path);
// the old socket is then not opened.
import { useEffect, useRef, useState } from 'react';
import { Connection } from '@souls/client';
import type { PublicSoul } from '@souls/protocol';
import { apiPath } from '../world-path.ts';
import type { Souls } from '../useSouls.ts';
import type { V2Bridge } from './bridge.ts';
import { streamNotice } from './stream-health.ts';
import { EdgeLog, WorldState, type LayerLike } from './world-state.ts';
import { CreatorKinds } from './creator-kinds.ts';
import { bundledEntries, CarriedParts } from './take-parts.ts';
import { TICK_US } from './takes.ts';
import { setAssetSource } from '../gen-mesh/gltf-assets.ts';
import { historyBase, setV2History, V2History } from './history.ts';

const STREAM = /^\/s\/[A-Za-z0-9._/-]+\/$/;
/** The v2 stream this world's page reads, when its inline config names one; else null (the old socket). */
export function v2Stream(): string | null {
  const v = typeof window === 'undefined' ? undefined : (window as unknown as { __simConfig?: { v2Stream?: unknown } }).__simConfig?.v2Stream;
  return typeof v === 'string' && STREAM.test(v) && !v.split('/').some((s) => s === '.' || s === '..') ? v : null;
}

/** A Connection that never opens a socket: the page's code reads its welcome, replica and stats as it does today. */
function quietConnection(worldId: string): Connection {
  const conn = new Connection('ws://v2.invalid/ws', async () => null, {}, () => { throw new Error('the v2 page opens no world socket'); });
  conn.welcome = { t: 'welcome', build: 'dev', proto: 0, worldId, rulesVersion: 'souls-v2/1', schema: 'souls-v2/1', dt: 0.05, clockRate: 1, serverTick: 0, you: null, serverTime: Date.now(), epoch: 'v2' };
  conn.stats.state = 'open';
  return conn;
}

const empty = (conn: Connection): Souls => ({ takes: { serverTick: 0, chunks: [], receivedAt: 0 }, privateAuthorityGeneration: 0, conn, station: null, me: null, log: [], brain: [], camera: null,
  ticker: [], narratives: {}, stats: null, bytesPerSec: 0, kernel: null, plays: [], talk: [], edge: [], awaitingWelcome: false });

export function useV2Souls(stream: string, worldId: string | undefined): Souls {
  const [, force] = useState(0);
  const s = useRef<Souls | null>(null);
  if (!s.current) s.current = empty(quietConnection(worldId ?? (window as unknown as { __simConfig?: { worldId?: string } }).__simConfig?.worldId ?? 'v2'));
  useEffect(() => {
    const st = s.current!, conn = st.conn;
    let bridge: V2Bridge | null = null, members: { stop(): void } | null = null, failed = false, stopped = false, lastSouls: unknown = null, lastError: string | null = null, lastEntities: unknown = null;
    const startedAt = performance.now();
    // #4176: doors, lamps and the weather as v2 has them, brought to the page's entity layer by its own world diffs
    const world = new WorldState(), edges = new EdgeLog();
    let said: readonly unknown[] = [], seenSpeech: unknown = null, seenTurns: unknown = null;
    // 0.133 V1: a creator's kinds that exist only in the new format, drawn by the entity layer from their records
    const kinds = new CreatorKinds((h) => apiPath(`/v2/uploads/${h}`), setAssetSource); // K3: the world's own uploads, through the front door
    // K1 (0.135): a carried load moves with its carry's samples; construction parts draw from their own entries
    const parts = new CarriedParts(kinds, bundledEntries(import.meta.glob('../../../../content/kinds/construction/*.json', { eager: true })));
    let seenParts = 0, lastPartAt: number | null = null, errorAtParts: number | null = null, seenTo: number | null = null;
    // The scenery the page binds is the world's own (/v1/scene, published with the world); takes carry its rules version.
    void (async () => {
     try {
      const scene = await fetch(apiPath('/v1/scene')).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { renderSceneRef?: { rulesVersion?: string } } | null;
      const [{ V2Bridge }, { makeReader, makeHistoryReader }] = await Promise.all([import('./bridge.ts'), import('./reader.ts')]);
      if (stopped) return;
      // `hour=HH:MM`, as on the v2 page: the light of the picture only, the world's clock unchanged
      const hour = /^([01]\d|2[0-3]):[0-5]\d$/.exec(new URLSearchParams(location.search).get('hour') ?? '')?.[0];
      const frame = { rulesVersion: scene?.renderSceneRef?.rulesVersion ?? 'souls-v2/1', ...(scene?.renderSceneRef ? { renderSceneRef: scene.renderSceneRef } : {}) };
      bridge = new V2Bridge(frame, hour);
      // K4: a thing on a course (a balloon) and its riders move where its course has them: the reader's worker posts the
      // places with each part (course-samples.ts), so the page never loads the replica itself
      bridge.thingKey = (origin, at) => {
        const m = (window as unknown as { __soulsEntity?: { layer?: LayerLike } }).__soulsEntity?.layer?.model;
        if (!m) return undefined;
        if (origin && m.entities.has(origin)) return origin;
        for (const e of m.entities.values()) if (e.in?.parent === 'world' && e.p && Math.hypot(e.p[0] - at[0], e.p[2] - at[2]) < 0.05) return e.id;
        return undefined;
      };
      // R2: the old page's rewind reads this world's past from its history export (history.ts)
      const past = historyBase(stream, (window as unknown as { __simConfig?: unknown }).__simConfig);
      if (past) setV2History(new V2History(past, () => makeHistoryReader(new URL(apiPath('/replica.js'), location.href).href), frame, hour));
      bridge.start(stream, () => parts.watch(kinds.watch(world.watch(makeReader(new URL(apiPath('/replica.js'), location.href).href)))));
      members = (await import('./member-turns.ts')).memberTurns((h) => bridge?.heard(h), (grants) => bridge?.bodiesOf(grants) ?? []); // R3b: private turns, to their members
      if (stopped) members.stop();
      // read-only, for checks and proof: what the stream gave (parts played, newest time, the reader's last error)
      (window as unknown as { __soulsV2?: unknown }).__soulsV2 = bridge.view;
      // The world's body catalogue, where its config (or `?bodies=`, as on the v2 page) names the v2 body assets: each
      // body is then drawn in the look the v2 world gives it (take-bodies.ts); without it, body kinds stay default people.
      const { bodiesUrl, catalogueOf } = await import('./take-bodies.ts');
      const cfg = (window as unknown as { __simConfig?: { v2Bodies?: unknown } }).__simConfig?.v2Bodies;
      const url = bodiesUrl(new URLSearchParams(location.search).get('bodies') ?? cfg);
      const rows = url ? catalogueOf(await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null)) : null;
      if (rows && !stopped) bridge.looks(rows);
     } catch (e) { failed = true; console.warn('v2 stream:', e); }
    })();
    const get = (path: string) => fetch(apiPath(path)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void get('/v1/kernel').then((v) => { if (v && !st.kernel) st.kernel = v; });
    const t = setInterval(() => {
      if (bridge) {
        const v = bridge.view;
        st.takes = v.takes;
        // what the Souls said aloud, and (R3) private turns with their words withheld: one list while neither changes
        if (v.speech !== seenSpeech || v.conversations !== seenTurns) { seenSpeech = v.speech; seenTurns = v.conversations; said = v.conversations.length ? [...v.speech, ...v.conversations] : v.speech; }
        st.ticker = v.ticker; // R3: what the Souls did (take-talk.ts)
        conn.replica.tick = v.takes.serverTick;
        // the replica's entities as the old socket keeps them: who is in the world now (search and follow read them)
        const newest = v.takes.chunks.at(-1)?.take as { finalState?: { entities?: Record<string, unknown> } } | undefined;
        if (newest?.finalState?.entities && newest.finalState.entities !== lastEntities) conn.replica.entities = (lastEntities = newest.finalState.entities) as typeof conn.replica.entities;
        conn.anchor = { tick: v.takes.serverTick, at: Date.now() - (performance.now() - v.takes.receivedAt) };
        if (v.souls !== lastSouls) {
          lastSouls = v.souls;
          // B3-3: the card's name, description and what it is doing now, from the stream; its body is awake unless the world
          // is winding it down (idle, zombie, asleep)
          conn.replica.souls = new Map([...v.souls.values()].map((x) => [x.id, { id: x.id, entityId: x.entityId, name: x.name, description: x.description, owner: '', intent: null, intentText: '',
            mood: '', energy: '', doing: x.doing, native: false, body: { state: x.state, doing: null, since: 0 } } satisfies PublicSoul]));
        }
        if (v.error && v.error !== lastError) { lastError = v.error; errorAtParts = v.parts; console.warn('v2 stream:', v.error); }
        if (v.parts !== seenParts) { seenParts = v.parts; lastPartAt = performance.now(); }
        // B2-3: a still world's pointer moving its time on is the stream alive, not silent
        if (v.newestTo !== seenTo) { seenTo = v.newestTo; if (seenTo !== null) lastPartAt = performance.now(); }
        const diff = world.next((window as unknown as { __soulsEntity?: { layer?: LayerLike } }).__soulsEntity?.layer, Date.now());
        // what the Souls said aloud (take-speech.ts; the speech layer and dialogue dock read it as public) and the world
        // diffs, in one log: a diff is never dropped when the speech changes
        st.edge = edges.step(said, diff) as typeof st.edge;
        // K1: the moving frames where the page draws now (the newest chunk's end, less the play delay, and the time since)
        kinds.apply(parts.frames((v.takes.serverTick - v.takes.playDelay) * TICK_US + (performance.now() - v.takes.receivedAt) * 1000), []);
        const made = kinds.next((window as unknown as { __soulsEntity?: { layer?: LayerLike } }).__soulsEntity?.layer, Date.now(), diff?.seq);
        if (made) st.edge = edges.step(said, made) as typeof st.edge;
      }
      // one visible state for every way the stream can fail or stall: the page's own status line (LiveWorld, ViewerFrame)
      st.streamNotice = streamNotice({ failed, error: bridge?.view.error ?? null, errorAtParts, parts: seenParts, startedAt, lastPartAt, now: performance.now() });
      force((n) => n + 1);
    }, 200);
    return () => { stopped = true; clearInterval(t); bridge?.stop(); members?.stop(); setV2History(null); };
  }, [stream]);
  return s.current;
}
