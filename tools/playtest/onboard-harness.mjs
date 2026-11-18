#!/usr/bin/env node
// #1927: does the first-run text onboard an agent in any harness with a shell? One headless run in Claude Code and one
// in Codex, each in an empty folder and given only the instructions URL of a local fake-mind world. A run passes when
// that folder holds a registered Soul whose approval is pending (no human approves here).
//
//   node tools/playtest/onboard-harness.mjs [--only claude|codex] [--codex-model <model>] [--port 6871] [--minutes 6] [--out <dir>]
//
// It uses each harness's signed-in subscription, never an API key, and a live model briefly: run it only to test
// onboarding. Claude Code runs with no user settings, CLAUDE.md or MCP servers and a budget cap; Codex runs in its
// workspace-write sandbox with network on (the world is on 127.0.0.1). Transcripts and a summary.json go to --out.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(Boolean));
const port = Number(args.port ?? 6871), minutes = Number(args.minutes ?? 6);
const origin = `http://127.0.0.1:${port}`, base = `${origin}/w/toy`, url = `${base}/instructions.md`;
const out = resolve(typeof args.out === 'string' ? args.out : `${root}/.local/onboard-harness/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const harnesses = args.only ? [args.only] : ['claude', 'codex'];
mkdirSync(out, { recursive: true });

// ---------- a local world that needs an account approval (synthetic Clerk issuer, fake minds)
const { clerkKeys, ISSUER, PUBLISHABLE_KEY } = await import('../../apps/server/test/clerk-fixture.ts');
const keys = await clerkKeys(origin), secrets = mkdtempSync(join(tmpdir(), 'onboard-harness-'));
writeFileSync(join(secrets, 'jwks.json'), JSON.stringify({ keys: [keys.jwk] }));
const dataDir = join(out, 'data'); mkdirSync(dataDir, { recursive: true });
const soul = join(root, 'tools/world-launcher/soul');
const env = { ...process.env, WORLD_KEY: 'toy', PORT: String(port), HOST: '127.0.0.1', BRAIN_MODE: 'fake', SEED_NATIVES: '0', INVITE_REQUIRED: '0',
  WORLD_OWNER_ID: 'user_owner', DATA_DIR: dataDir, PUBLIC_URL: base, AUTH_PROVIDER: 'clerk', ACCOUNT_AUTH_REQUIRED: '1',
  ACCOUNT_REGISTRY_PATH: join(dataDir, 'accounts.sqlite'), CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY, CLERK_ISSUER_URL: ISSUER, CLERK_AUTHORIZED_PARTIES: origin,
  EDGE_SKILL_FILE: join(soul, 'skill.md'), EDGE_INSTRUCTIONS_FILE: join(soul, 'instructions.md'), EDGE_CONTROLLER_CLI_FILE: join(soul, 'eden.mjs'),
  SIM_TEST_JWKS_FILE: join(secrets, 'jwks.json'), NODE_OPTIONS: `--import=${join(root, 'apps/server/test/clerk-jwks-preload.mjs')}` };
delete env.DEV_AUTH;
const world = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: root, env, stdio: ['ignore', openSync(join(out, 'world.log'), 'a'), openSync(join(out, 'world.log'), 'a')] });
const stop = () => { try { world.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(130); });
for (let i = 0; ; i++) {
  if (await fetch(`${base}/v1/config`).then((r) => r.ok, () => false)) break;
  if (i > 120) { console.error(`the world did not start: ${join(out, 'world.log')}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}

// ---------- the prompt a person pastes (apps/web god-ui/join-api.ts), with the instructions URL as its only input
const prompt = `Read the instructions at ${url} and follow them to create my new Soul and get it living there. If it gives an approval link, show it to me and I'll approve it.`;
const PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
const runs = {
  claude: (cwd) => ['claude', ['-p', prompt, '--model', 'sonnet', '--max-budget-usd', '0.35', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--allowedTools', 'Bash(node:*)', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Read', 'Write'],
  { cwd, env: { ...process.env, PATH, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' } }],
  codex: (cwd) => ['codex', ['exec', ...(args['codex-model'] ? ['-m', args['codex-model']] : []), '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-C', cwd, prompt],
    { cwd, env: { ...process.env, PATH } }],
};
const exec = (cmd, argv, opts, log) => new Promise((ok) => {
  const p = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }), file = createWriteStream(log);
  let text = ''; p.stdout.on('data', (d) => { text += d; file.write(d); }); p.stderr.on('data', (d) => file.write(d));
  const t = setTimeout(() => { p.kill('SIGTERM'); }, minutes * 60_000);
  p.on('close', (code, signal) => { clearTimeout(t); file.end(); ok({ code, signal, text }); });
});
const lines = (text) => text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
function usage(h, events) {
  if (h === 'claude') {
    const r = events.findLast((e) => e.type === 'result');
    const tools = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? []).filter((c) => c.type === 'tool_use').length;
    return { turns: r?.num_turns ?? null, toolCalls: tools, costUsd: r?.total_cost_usd ?? null, tokens: r?.usage ?? null, final: r?.result ?? null };
  }
  const done = events.filter((e) => e.type === 'turn.completed'), tok = done.reduce((a, e) => ({ input: a.input + (e.usage?.input_tokens ?? 0), cached: a.cached + (e.usage?.cached_input_tokens ?? 0), output: a.output + (e.usage?.output_tokens ?? 0) }), { input: 0, cached: 0, output: 0 });
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item);
  return { turns: done.length, toolCalls: items.filter((i) => i?.type === 'command_execution').length, costUsd: null, tokens: tok, final: items.findLast((i) => i?.type === 'agent_message')?.text ?? null,
    errors: events.filter((e) => e.type === 'error' || e.type === 'turn.failed').map((e) => e.message ?? e.error?.message ?? JSON.stringify(e)).slice(0, 3) };
}
const node = (cwd, argv) => new Promise((ok) => {
  const p = spawn(process.execPath, [join(cwd, 'eden.mjs'), ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let o = '';
  p.stdout.on('data', (d) => { o += d; }); p.on('close', () => { try { ok(JSON.parse(o)); } catch { ok({ raw: o.slice(0, 400) }); } }); p.on('error', () => ok({ missing: true }));
});

const summary = { world: 'local toy world, fake minds, account approval (synthetic Clerk)', prompt: prompt.replace(origin, '<local world>'), runs: {} };
for (const h of harnesses) {
  const cwd = join(out, h); mkdirSync(cwd, { recursive: true });
  const [cmd, argv, opts] = runs[h](cwd), t0 = Date.now();
  console.log(`${h}: running (at most ${minutes} min)…`);
  const r = await exec(cmd, argv, opts, join(out, `${h}.jsonl`));
  const status = await node(cwd, ['status']);
  const pending = !!(status.pending ?? status.pendingApproval ?? status.approval?.status === 'pending');
  summary.runs[h] = { pass: pending, status: { paired: status.paired ?? null, pending: status.pending ?? null }, exit: r.code, killed: r.signal ?? null, wallSec: Math.round((Date.now() - t0) / 1000), ...usage(h, lines(r.text)) };
  console.log(`${h}: ${pending ? 'PASS' : 'FAIL'} ${JSON.stringify({ ...summary.runs[h], final: undefined })}`);
}
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`transcripts and summary: ${out}`);
stop();
process.exit(Object.values(summary.runs).every((r) => r.pass) ? 0 : 1);
