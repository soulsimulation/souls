// The tester's report: a pass/fail table, what was confusing (from the naive agent's transcript), and the findings,
// each written as text ready to file as a task.
import { relative } from 'node:path';

const RANK = { blocker: 0, major: 1, minor: 2 };

/** A step passes when the eye says pass and no blocker or major check failed. */
export function stepPassed(s) {
  if (s.skipped) return false;
  const bad = (s.checks ?? []).some((c) => !c.ok && c.severity !== 'minor');
  if (s.judged === false) return !bad && s.ok !== false;
  return s.verdict === 'pass' && !bad && s.ok !== false;
}

/** Findings from the judged steps. `repro(step)` gives the one-line repro. */
export function findingsOf(steps, { repro }) {
  const out = [];
  for (const s of steps) {
    const failed = (s.checks ?? []).filter((c) => !c.ok);
    if (!stepPassed(s)) {
      const worst = failed.filter((c) => c.severity !== 'minor').sort((a, b) => RANK[a.severity] - RANK[b.severity])[0];
      const why = s.skipped ? s.skipped : worst ? `${worst.check}: ${worst.detail}` : (s.problems?.[0] ?? s.seen ?? 'judged a fail by eye');
      out.push({ step: s.id, title: `${s.title}: ${why}`.slice(0, 140), expected: s.expect, seen: [s.seen, ...failed.map((c) => `${c.check}: ${c.detail}`), ...(s.notes ?? [])].filter(Boolean).join(' '),
        screenshot: s.shots?.at(-1) ?? null, severity: s.severity ?? worst?.severity ?? 'major', repro: repro(s) });
    }
    for (const c of failed.filter((c) => c.severity === 'minor' && c.check !== 'no-console-errors')) {
      out.push({ step: s.id, title: `${s.title}: ${c.check}: ${c.detail}`.slice(0, 140), expected: s.expect, seen: c.detail, screenshot: s.shots?.at(-1) ?? null, severity: 'minor', repro: repro(s) });
    }
  }
  const errs = steps.flatMap((s) => (s.consoleErrors ?? []).map((e) => `${s.id}: ${e}`));
  if (errs.length) out.push({ step: [...new Set(errs.map((e) => e.split(':')[0]))].join(', '), title: `The page logs ${errs.length} console error(s) during the first day`, expected: 'No console errors.',
    seen: [...new Set(errs)].slice(0, 6).join(' | ').slice(0, 900), screenshot: null, severity: 'minor', repro: 'Open the Eden page with the browser console open and walk the first day.' });
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** What the naive agent's transcript shows was confusing: its questions, refusals, retries, errors and time per step. */
export function confusingOf(turns) {
  const rows = turns.map((t) => ({ step: t.step, said: t.said, seconds: t.summary.seconds, tools: t.summary.tools, questions: t.summary.questions, denials: t.summary.denials,
    blocked: t.summary.blocked, worldRefusals: t.summary.worldRefusals, repeats: t.summary.repeats, errors: t.summary.errors, timedOut: t.summary.timedOut }));
  return {
    rows,
    questions: rows.flatMap((r) => r.questions.map((q) => `${r.step}: ${q}`)),
    denials: rows.flatMap((r) => [...r.denials, ...r.blocked].map((d) => `${r.step}: ${d.tool ?? 'Bash'} ${String(d.input ?? d.command ?? '').slice(0, 160)}${d.said ? ` -> ${d.said.slice(0, 200)}` : ''}`)),
    worldRefusals: rows.flatMap((r) => r.worldRefusals.map((d) => `${r.step}: ${String(d.command).slice(0, 120)} -> ${d.said.slice(0, 200)}`)),
    retries: rows.flatMap((r) => r.repeats.map((c) => `${r.step}: ran again: ${String(c).slice(0, 160)}`)),
  };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

export function markdown(rep, { root }) {
  const rel = (f) => (f ? relative(root, f) : '');
  const L = [];
  L.push(`# First day: ${rep.target}`, '', `Run ${rep.stamp}. ${rep.passed}/${rep.steps.length} steps pass. Build: ${rep.build ?? 'unknown'}.`, '');
  if (rep.aborted) L.push(`**Stopped:** ${rep.aborted}`, '');
  L.push('## Steps', '', '| Step | What | Eye | Checks | Seconds | Screenshot |', '|---|---|---|---|---|---|');
  for (const s of rep.steps) {
    const failed = (s.checks ?? []).filter((c) => !c.ok).map((c) => `${c.check}`);
    L.push(`| ${s.id} | ${cell(s.ask ? `"${s.ask}"` : s.title)} | ${stepPassed(s) ? 'PASS' : 'FAIL'} (${s.judged === false ? 'not judged' : s.verdict ?? '-'}) | ${cell(failed.length ? `failed: ${failed.join(', ')}` : 'ok')} | ${s.seconds ?? ''} | ${rel(s.shots?.at(-1))} |`);
  }
  L.push('', '## What was confusing', '');
  const c = rep.confusing;
  L.push('Time per step (the agent\'s turns):', '', '| Step | The person said | Seconds | Tools | Questions | Refused |', '|---|---|---|---|---|---|');
  for (const r of c.rows) L.push(`| ${r.step} | ${cell(r.said.slice(0, 90))} | ${r.seconds} | ${r.tools} | ${r.questions.length} | ${r.denials.length + r.blocked.length + r.worldRefusals.length} |`);
  for (const [h, list] of [['Questions the agent asked the person', c.questions], ['Refused by the agent\'s own safety check or permissions (verbatim)', c.denials],
    ['Refused by the world', c.worldRefusals], ['Retries', c.retries]]) {
    L.push('', `**${h}:** ${list.length ? '' : 'none'}`);
    for (const x of list) L.push(`- ${cell(x)}`);
  }
  L.push('', '## Findings', '');
  if (!rep.findings.length) L.push('None.');
  rep.findings.forEach((f, i) => {
    L.push(`### ${i + 1}. [${f.severity}] ${f.title}`, '', `- **Step:** ${f.step}`, `- **Expected:** ${f.expected}`, `- **Seen:** ${f.seen}`, `- **Screenshot:** ${rel(f.screenshot) || 'none'}`, `- **Repro:** ${f.repro}`, '');
  });
  L.push('## Files', '', `- Video: ${(rep.videos ?? []).map(rel).join(', ')}`, `- Agent transcript: ${rel(rep.agent?.transcript)}`, `- Report JSON: report.json`, '');
  return L.join('\n');
}
