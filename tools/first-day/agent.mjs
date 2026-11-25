// The naive agent: a fresh Claude Code session in an empty folder outside this checkout, as a person's own agent would
// be on their first day. It gets only what the person types: the page's prompt, then plain answers and asks. Each later
// line resumes the same session (`--resume <id>`). `--bare` is not used: it skips the subscription login.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const AGENT_FLAGS = ['--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose'];

/** An empty folder for the agent, outside `repo`, with no Souls home, AGENTS.md or CLAUDE.md in any folder above it. */
export function naiveFolder(repo, base = tmpdir()) {
  const dir = realpathSync(mkdtempSync(join(base, 'first-day-agent-')));
  const r = realpathSync(repo);
  if (dir === r || dir.startsWith(`${r}/`)) throw new Error(`the agent's folder ${dir} is inside the checkout`);
  for (let d = dirname(dir); d !== dirname(d); d = dirname(d)) {
    for (const f of ['.souls', 'AGENTS.md', 'CLAUDE.md']) if (existsSync(join(d, f))) throw new Error(`${join(d, f)} is above the agent's folder: it would reach the agent`);
  }
  return dir;
}

/** A terminal's environment, not this session's: no CLAUDE_*, SOULS_*, SIM_* or other harness variables reach the agent. */
export function personEnv(env = process.env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
  return Object.fromEntries(keep.filter((k) => env[k] != null).map((k) => [k, env[k]]));
}

/** The skills a person's own home folder would give a Claude Code session (`~/.claude/skills`), by name. */
export function homeSkills(home = homedir()) {
  try { return readdirSync(join(home, '.claude/skills')).filter((n) => !n.startsWith('.')); } catch { return []; }
}

/** Why the agent's first event shows a contaminated session (empty when clean): an instruction or memory file from the
 *  home folder or the checkout, the checkout's path, a skill from the home folder, an MCP server, or memory already
 *  kept for its folder. */
export function contamination(init, { home = homedir(), repo, skills = homeSkills(home), memoryFiles = null } = {}) {
  const why = [];
  if (!init || init.type !== 'system' || init.subtype !== 'init') return ['the first event is not the session\'s init'];
  const text = JSON.stringify(init);
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md']) if (text.includes(f)) why.push(`the init event names ${f}`);
  if (repo && text.includes(repo)) why.push('the init event names the checkout');
  if (text.includes('/.souls')) why.push('the init event names a Souls home');
  for (const s of skills) if ((init.skills ?? []).includes(s) || (init.slash_commands ?? []).includes(s)) why.push(`a home-folder skill is loaded: ${s}`);
  if ((init.mcp_servers ?? []).length) why.push(`MCP servers are connected: ${init.mcp_servers.map((m) => m.name ?? m).join(', ')}`);
  const auto = init.memory_paths?.auto;
  const files = memoryFiles ?? (auto && existsSync(auto) ? readdirSync(auto) : []);
  if (files.length) why.push(`memory is already kept for this folder: ${files.join(', ')}`);
  if (init.cwd && repo && (init.cwd === repo || init.cwd.startsWith(`${repo}/`))) why.push('the agent runs inside the checkout');
  return why;
}

const resultText = (c) => typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('\n');

/** The pairing ask the agent got (`{"step":"approve","link","code"}`), from a tool result or its own words. */
export function pairingIn(events) {
  for (const e of events) {
    if (e?.type !== 'user') continue;
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_result') continue;
      for (const line of resultText(c).split('\n')) {
        const m = /\{.*"step"\s*:\s*"approve".*\}/.exec(line);
        if (m) { try { const j = JSON.parse(m[0]); if (j.code) return { code: j.code, link: j.link ?? null, from: 'tool' }; } catch { /* not JSON */ } }
      }
    }
  }
  for (const e of events) {
    if (e?.type !== 'assistant') continue;
    const t = (e.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(t)?.[1];
    if (code) return { code, link: /(https?:\/\/\S+pair\S*)/.exec(t)?.[1]?.replace(/[)>.,`*]+$/, '') ?? null, from: 'words' };
  }
  return null;
}

/** One line from the person to the agent. `sessionId` resumes; `onEvent` sees each event as it comes.
 *  → {sessionId, events, init, result, final, ms, exit, timedOut} */
export function say({ cwd, text, sessionId = null, model = null, maxSec = 600, onEvent = () => {}, onSpawn = () => {}, bin = 'claude' }) {
  const args = ['-p', text, ...AGENT_FLAGS, ...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : [])];
  const t0 = Date.now(), events = [];
  return new Promise((ok) => {
    const p = spawn(bin, args, { cwd, env: personEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(p);
    let buf = '', err = '', timedOut = false, stopped = false, answered = false, ended = null;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, maxSec * 1000);
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        e._at = Date.now() - t0; events.push(e);
        let r; try { r = onEvent(e, events); } catch { /* the watcher's own failure never stops the agent */ }
        if (r === 'stop') { stopped = true; p.kill('SIGTERM'); }
        // The turn is over when the agent has answered: a background task it started (a `listen --follow`) keeps a
        // `-p` process alive, so the process ends 5 s after a reply unless the agent goes on. A resumed session can
        // open with an empty result for a stale task notice: that is not a reply.
        if (e.type === 'result' && String(e.result ?? '').trim()) { clearTimeout(ended); ended = setTimeout(() => { answered = true; p.kill('SIGTERM'); }, 5000); }
        else if (e.type === 'assistant') clearTimeout(ended);
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (exit) => {
      clearTimeout(timer); clearTimeout(ended);
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
      // a reply ends the turn; with none (cut off at the cap), the turn lasted until it was stopped, and an empty result
      // (a resumed session's stale task notice) is not a reply
      const reply = events.findLast((e) => e.type === 'result' && String(e.result ?? '').trim()) ?? null;
      const result = reply ?? events.findLast((e) => e.type === 'result') ?? null;
      ok({ sessionId: result?.session_id ?? init?.session_id ?? sessionId, events, init, result, final: String(reply?.result ?? ''), ms: reply?._at ?? Date.now() - t0, exit, timedOut: timedOut && !reply, answered, stopped, stderr: err.slice(-2000) });
    });
  });
}

/** What a turn shows about the agent's experience: its tool calls, the commands it ran, what was refused (by its
 *  harness's safety check or by the world), the questions it asked the person, and errors. */
export function turnSummary(turn) {
  const calls = [], results = new Map();
  for (const e of turn.events) {
    for (const c of e.message?.content ?? []) {
      if (e.type === 'assistant' && c.type === 'tool_use') calls.push({ id: c.id, tool: c.name, command: c.input?.command ?? c.input?.url ?? c.input?.file_path ?? null });
      if (e.type === 'user' && c.type === 'tool_result') results.set(c.tool_use_id, { error: !!c.is_error, text: resultText(c).slice(0, 600) });
    }
  }
  for (const c of calls) Object.assign(c, results.get(c.id) ?? { error: false, text: '' });
  const denials = (turn.result?.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input?.command ?? JSON.stringify(d.tool_input ?? {}).slice(0, 200) }));
  const blocked = calls.filter((c) => c.error && /denied|not allowed|permission|refus|blocked/i.test(c.text)).map((c) => ({ command: c.command, said: c.text.slice(0, 300) }));
  const worldRefusals = calls.filter((c) => /"ok"\s*:\s*false/.test(c.text)).map((c) => ({ command: c.command, said: c.text.slice(0, 300) }));
  const commands = calls.filter((c) => c.tool === 'Bash').map((c) => c.command);
  const repeats = commands.filter((c, i) => commands.indexOf(c) !== i);
  const questions = String(turn.final).split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter((s) => s.endsWith('?'));
  return { seconds: Math.round(turn.ms / 100) / 10, tools: calls.length, commands, denials, blocked, worldRefusals, repeats: [...new Set(repeats)], errors: calls.filter((c) => c.error).length, questions, final: String(turn.final).slice(0, 1200), timedOut: turn.timedOut, exit: turn.exit };
}

/** What a newcomer answers to the agent's last words: a name when it asks for one, the permission when it names the
 *  rule, otherwise yes. → {text, why} */
export function personReply(final, { name, ruleAdded = false }) {
  const f = String(final);
  if (/\bname\b/i.test(f) && /\?/.test(f) && !/approve/i.test(f)) return { text: `Call it ${name}.`, why: 'asked-name' };
  if (!ruleAdded && /Bash\(node eden\.mjs:\*\)/.test(f)) return { text: 'I added that rule. Go ahead.', why: 'asked-permission', addRule: true };
  return { text: 'Yes, go ahead.', why: 'asked-yes' };
}

/** The agent's own Soul daemon(s), started by its client in its folder: stopped by pid, never by a pattern. */
export function stopAgentProcesses(dir) {
  let n = 0;
  for (const l of execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    if (!l.includes(dir)) continue;
    const pid = Number(l.trim().split(/\s+/)[0]);
    if (pid && pid !== process.pid) { try { process.kill(pid); n++; } catch { /* gone */ } }
  }
  return n;
}
