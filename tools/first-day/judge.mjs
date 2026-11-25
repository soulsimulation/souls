// Judging by eye: a vision model looks at a step's screenshots and says what it sees against what the person expected.
// It runs as its own `claude -p` in the run's folder, allowed only to Read the screenshots; it never sees the page's
// state, the agent's words or the checks, so what it reports is what is on the screen.
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { personEnv } from './agent.mjs';

export function judgePrompt({ title, ask, expect, images }) {
  return [
    'You are a user tester watching a person use soul.game, a 3D world where each person has a character (a "Soul") that their own AI agent controls.',
    ask ? `The person just told their agent, in plain words: "${ask}"` : `The person is at this step: ${title}.`,
    `What they expect to SEE on the screen: ${expect}`,
    `Read these screenshots, in time order, with the Read tool: ${images.map((f) => basename(f)).join(', ')}.`,
    'Judge only by what is visible in the pictures. A label or a status line that claims something happened is not proof that it did; the picture is.',
    'Note anything a first-time visitor would find confusing, broken, empty, overlapping or wrong (error text, a blank world, a Soul floating or inside a wall, a card that contradicts the picture).',
    'Answer with exactly one JSON object and nothing else:',
    '{"verdict": "pass" | "fail" | "unclear", "seen": "<one or two sentences: what the screenshots show>", "problems": ["<each visible problem, short>"]}',
  ].join('\n');
}

/** Parses the judge's last JSON object. → {verdict, seen, problems} */
export function parseVerdict(text) {
  const m = String(text).match(/\{[\s\S]*\}/g);
  for (const s of (m ?? []).reverse()) {
    try {
      const j = JSON.parse(s);
      if (['pass', 'fail', 'unclear'].includes(j.verdict)) return { verdict: j.verdict, seen: String(j.seen ?? ''), problems: (j.problems ?? []).map(String) };
    } catch { /* next */ }
  }
  return { verdict: 'unclear', seen: `the judge gave no verdict: ${String(text).slice(0, 200)}`, problems: [] };
}

/** One judgement. `cwd` holds the images. → {verdict, seen, problems, ms} */
export function judge({ cwd, model = null, maxSec = 240, ...step }) {
  const args = ['-p', judgePrompt(step), '--setting-sources', 'project', '--strict-mcp-config', '--allowedTools', 'Read', '--output-format', 'json', ...(model ? ['--model', model] : [])];
  const t0 = Date.now();
  return new Promise((ok) => {
    const p = spawn('claude', args, { cwd, env: personEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), maxSec * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      clearTimeout(timer);
      let text = out; try { text = JSON.parse(out).result ?? out; } catch { /* raw */ }
      ok({ ...parseVerdict(text), ms: Date.now() - t0 });
    });
  });
}

/** Judges many steps, `n` at a time. */
export async function judgeAll(items, { n = 3, ...opts }) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (let i; (i = next++) < items.length;) out[i] = await judge({ ...opts, ...items[i] }); }));
  return out;
}
