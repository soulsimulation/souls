import {worldThinkingBudgetV1} from './thinking-budget.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The program's own settings, shared by every world it runs: the code's build and pinned source commit (god/versions.ts). */
export const program = {
  build: process.env.BUILD_ID || (() => { try { return readFileSync(new URL('../../../BUILD', import.meta.url), 'utf8').trim(); } catch { return 'dev'; } })(),
  sourceCommit: process.env.SIM_SOURCE_COMMIT,
};

/** Worlds with authored content and their own factories; any other key is an entity world (ENABLE_WORLD_ENGINE) on the green field. */
export const KNOWN_WORLD_KEYS = ['toy', 'mars', 'littlemartians', 'eden'] as const;

/** Shards (#2389): one world's configuration from an environment, read once. `env` is kept on the config as the world's own
 *  environment: whatever the world reads after boot reads `cfg.env`, never `process.env`, so two worlds in one program
 *  each see their own. A one-world program passes `process.env` itself (main.ts), so it reads exactly what it read before. */
export function loadConfig(env: NodeJS.ProcessEnv) {
const thinkingBudget=worldThinkingBudgetV1(env);
const bodyTypes=(env.WORLD_BODY_TYPES??'humanoid,ceramic,floater,creature').split(',');
if(!bodyTypes.includes('humanoid')||bodyTypes.some(t=>!['humanoid','ceramic','floater','creature'].includes(t)))throw Error('WORLD_BODY_TYPES must include humanoid and contain only supported body types');
const worldKey = env.WORLD_KEY ?? 'toy';
if (!/^[a-z][a-z0-9-]{0,31}$/.test(worldKey)) throw new Error('invalid WORLD_KEY');
if (env.WORLD_SLUG && !/^[a-z][a-z0-9-]{0,31}$/.test(env.WORLD_SLUG)) throw new Error('invalid WORLD_SLUG');
const config = {
  /** The world's own environment (see loadConfig). */
  env,
  /** Worlds may narrow the platform body families; humanoid remains the default. */
  bodyTypes,
  /** Take recordings (take_chunks + the R2 take archive) are a pose-keyframe cache, not the source of truth: off by default. */
  takesPersist: env.TAKES_PERSIST === '1',
  archiveTakes: env.ARCHIVE_TAKES === '1' && env.TAKES_PERSIST === '1',
  r2: {account:env.R2_ACCOUNT_ID,bucket:env.R2_BUCKET,endpoint:env.R2_ENDPOINT,access:env.R2_ACCESS_KEY_ID,secret:env.R2_SECRET_ACCESS_KEY,prefix:env.R2_PREFIX??'sim'},
  worldKey,
  /** Public routing slug; WORLD_KEY remains the engine identity across URL migrations. */
  worldSlug: env.WORLD_SLUG || undefined as string | undefined,
  /** God mode + entity world (spec eden4/28): on for every non-authored key, or by explicit flag. */
  worldEngine: env.ENABLE_WORLD_ENGINE === '1' || !['toy', 'mars', 'littlemartians', 'eden'].includes(worldKey),
  /** Markdown served at /skill.md (App's agent skill). Unset: edge worlds get a built-in edge stub; central worlds the legacy skill. */
  skillFile: env.EDGE_SKILL_FILE || undefined as string | undefined,
  /** Source-owned onboarding Markdown, served with the selected world's base and display name. */
  instructionsFile: (env.EDGE_INSTRUCTIONS_FILE || resolve(new URL('../../../tools/world-launcher/soul/instructions.md',import.meta.url).pathname)) as string | undefined,
  /** Single-controller CLI served at /eden.mjs (the legacy /eden-agent.mjs answers 404, #1754). Unset: the pinned
   *  tools/world-launcher/soul/eden.mjs (SOURCES.json), so a world started without the launcher serves the pinned controller
   *  CLI too (#983). Its directory's runtime/ files are then published at /soul-runtime/* (soul-runtime-publication.ts). */
  controllerCliFile: (env.EDGE_CONTROLLER_CLI_FILE || fileURLToPath(new URL('../../../tools/world-launcher/soul/eden.mjs', import.meta.url))) as string | undefined,
  /** Who chooses Souls' actions: 'edge' (owners' own agents; the world runs no Soul mind) or 'central' (legacy brain, kept for a future NPC driver). */
  // Default 'edge'. Under node --test (NODE_TEST_CONTEXT) legacy suites keep 'central'; edge tests opt in explicitly.
  mindDriver: ((env.MIND_DRIVER ?? (env.NODE_TEST_CONTEXT ? 'central' : 'edge')) === 'central' ? 'central' : 'edge') as 'edge' | 'central',
  livingWorld: env.ENABLE_LIVING_WORLD === '1',
  /** #2383: DOOR_FIT_BOOT=1 lets this world adopt door-fit/1 at boot (off until a fit runs in slices under 1 s). */
  doorFitBoot: env.DOOR_FIT_BOOT === '1',
  worldId: env.WORLD_ID ?? (worldKey === 'toy' ? 'toy-1' : `${worldKey}-1`),
  worldPath: env.WORLD_PATH ?? `/w/${worldKey}`,
  ownerId: env.WORLD_OWNER_ID ?? (env.DEV_AUTH === '1' ? 'dev:admin' : ''),
  marsWebDir: resolve(env.MARS_WEB_DIR ?? new URL('../../../mars/viewer/dist/client', import.meta.url).pathname),
  port: Number(env.PORT ?? 4500),
  host: env.HOST ?? '127.0.0.1',
  dataDir: resolve(env.DATA_DIR ?? './data'),
  webDir: resolve(env.WEB_DIR ?? new URL('../../web/dist', import.meta.url).pathname),
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4500}`).replace(/\/$/, ''),
  /** Account-linked creation is explicit until its independent rollout is qualified. */
  accountAuthRequired: env.ACCOUNT_AUTH_REQUIRED === '1',
  authProvider: (env.AUTH_PROVIDER ?? 'privy') as 'clerk'|'privy'|'none',
  clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? '',
  clerkIssuer: env.CLERK_ISSUER_URL ?? '',
  clerkSatelliteDomain: env.CLERK_SATELLITE_DOMAIN ?? '',
  clerkSignInUrl: env.CLERK_SIGN_IN_URL ?? '',
  clerkAuthorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map(s=>s.trim()).filter(Boolean),
  accountRegistryPath: env.ACCOUNT_REGISTRY_PATH ?? '',
  // #717 body collections: cross-world membership and attribution, beside the account registry by default.
  bodyCollectionPath: env.BODY_COLLECTION_PATH ?? '',
  privyAppId: env.PRIVY_APP_ID ?? '',
  privyAppSecret: env.PRIVY_APP_SECRET ?? '',
  typesafeKey: env.TYPESAFE_API_KEY || undefined,
  anthropicKey: env.ANTHROPIC_API_KEY || undefined,
  adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  brainMode: (env.BRAIN_MODE === 'fake' ? 'fake' : 'live') as 'live' | 'fake',
  budgetUsdPerDay: thinkingBudget.target,
  thinkingBudgetCeiling: thinkingBudget.ceiling,
  authorizedThinkingWorldId: thinkingBudget.authorizedWorldId,
  narratorModel: env.NARRATOR_MODEL ?? 'claude-haiku-4-5-20251001',
  compilerModel: env.COMPILER_MODEL ?? env.NARRATOR_MODEL ?? 'claude-haiku-4-5-20251001',
  talkModel: env.TALK_MODEL ?? env.NARRATOR_MODEL ?? 'claude-haiku-4-5-20251001',
  worldSeed: env.WORLD_SEED ?? 'sim-genesis-1',
  engine: (env.ENGINE === 'mars' ? 'mars' : 'toy') as 'toy' | 'mars',
  snapshotEveryTicks: Number(env.SNAPSHOT_EVERY_TICKS ?? 20 * 60 * 5),
  // Lane L5: a periodic snapshot is also due once the ticks since the last one would take this long to replay (0 = off),
  // at most once per SNAPSHOT_MIN_GAP_MS; SNAPSHOT_EVERY_TICKS stays the ceiling.
  snapshotDebtMs: Number(env.SNAPSHOT_DEBT_MS ?? 3000),
  snapshotMinGapMs: Number(env.SNAPSHOT_MIN_GAP_MS ?? 20_000),
  snapshotAfterReplayTicks: Number(env.SNAPSHOT_AFTER_REPLAY_TICKS ?? 200),
  seedNatives: env.SEED_NATIVES !== '0',
  maxSoulsPerUser: Number(env.MAX_SOULS_PER_USER ?? 20),
  inviteRequired: env.INVITE_REQUIRED !== '0',
  build: env.BUILD_ID || program.build,
};
mkdirSync(config.dataDir, { recursive: true });
return config;
}
export type Config = ReturnType<typeof loadConfig>;
/** The process default world, for tests and tools that build a host by hand. A world started by startWorld (world-main.ts)
 *  never reads it: the server's own code takes the world's config (the guard in world-config-reads.test.ts). */
export const config = loadConfig(process.env);
/** The config of the world a host belongs to: its own (startWorld sets `host.config`), else the process default. */
export const worldConfig = (host: { config?: Config } | null | undefined): Config => host?.config ?? config;

/** The world's public base URL from configuration alone (never a request's Host). A launcher child runs with PUBLIC_URL =
 *  the bare origin and WORLD_PATH = /worlds/w/<slug>: origin + world path. The legacy servers (tools/core) set PUBLIC_URL
 *  to the full world URL (origin + world path) already: kept as given. E.g. https://soul.game/w/<slug>,
 *  https://soul.game/w/eden. */
export const publicWorldBase = (cfg: Pick<Config, 'publicUrl' | 'worldPath'>) => {
  const u = new URL(cfg.publicUrl), path = u.pathname.replace(/\/+$/, '');
  return u.origin + (path || cfg.worldPath.replace(/\/+$/, ''));
};
