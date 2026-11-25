import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contamination, pairingIn, personReply, turnSummary, personEnv } from './agent.mjs';
import { checkStep, arrivalChecks } from './checks.mjs';
import { parseVerdict } from './judge.mjs';
import { stepPassed, findingsOf, confusingOf, markdown } from './report.mjs';

const init = (extra = {}) => ({ type: 'system', subtype: 'init', cwd: '/tmp/first-day-agent-x', skills: ['debug'], slash_commands: ['debug'], mcp_servers: [], memory_paths: { auto: '/nowhere/memory/' }, ...extra });

test('a clean first event passes; instruction files, the checkout, home skills and MCP fail it', () => {
  assert.deepEqual(contamination(init(), { repo: '/src/souls', skills: ['walkie'], memoryFiles: [] }), []);
  assert.match(contamination(init({ files: ['/home/me/.claude/CLAUDE.md'] }), { repo: '/src/souls', skills: [], memoryFiles: [] })[0], /CLAUDE\.md/);
  assert.match(contamination(init({ cwd: '/src/souls/x' }), { repo: '/src/souls', skills: [], memoryFiles: [] }).join(), /checkout/);
  assert.match(contamination(init({ skills: ['walkie'] }), { repo: '/src/souls', skills: ['walkie'], memoryFiles: [] })[0], /walkie/);
  assert.match(contamination(init({ mcp_servers: [{ name: 'x' }] }), { repo: '/r', skills: [], memoryFiles: [] })[0], /MCP/);
  assert.match(contamination(init(), { repo: '/r', skills: [], memoryFiles: ['MEMORY.md'] })[0], /memory/);
  assert.equal(contamination({ type: 'assistant' }, { repo: '/r', skills: [] }).length, 1);
});

test('the pairing ask comes from the client\'s JSON line, else the agent\'s words', () => {
  const tool = [{ type: 'user', message: { content: [{ type: 'tool_result', content: '{"ok":true,"step":"approve","link":"http://w/pair?code=AB12-CD34","code":"AB12-CD34"}' }] } }];
  assert.deepEqual(pairingIn(tool), { code: 'AB12-CD34', link: 'http://w/pair?code=AB12-CD34', from: 'tool' });
  const words = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Open https://w/pair?code=ZZ99-YY88. and check the code ZZ99-YY88' }] } }];
  assert.equal(pairingIn(words).code, 'ZZ99-YY88');
  assert.equal(pairingIn(words).link, 'https://w/pair?code=ZZ99-YY88');
  assert.equal(pairingIn([]), null);
});

test('the person answers a name ask with a name, a named rule once, else yes', () => {
  assert.equal(personReply('What name would you like for your Soul?', { name: 'Juniper' }).text, 'Call it Juniper.');
  assert.equal(personReply('Please allow Bash(node eden.mjs:*) and tell me.', { name: 'J' }).addRule, true);
  assert.equal(personReply('Please allow Bash(node eden.mjs:*) and tell me.', { name: 'J', ruleAdded: true }).text, 'Yes, go ahead.');
  assert.equal(personReply('Shall I download it?', { name: 'J' }).text, 'Yes, go ahead.');
});

test('a turn summary lists commands, refusals, repeats and questions', () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'node eden.mjs look' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"ok":false,"code":"not-here"}' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'node eden.mjs look' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'Permission to use Bash has been denied.' }] } },
  ];
  const s = turnSummary({ events, result: { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'curl x' } }] }, final: 'Done. Want me to sit too?', ms: 1234 });
  assert.equal(s.tools, 2); assert.equal(s.worldRefusals.length, 1); assert.equal(s.blocked.length, 1); assert.equal(s.denials[0].input, 'curl x');
  assert.deepEqual(s.repeats, ['node eden.mjs look']); assert.deepEqual(s.questions, ['Want me to sit too?']); assert.equal(s.seconds, 1.2);
});

test('the agent gets a terminal\'s environment, not this session\'s', () => {
  const env = personEnv({ PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', SOULS_HOME: '/s' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

const soulAt = (p, extra = {}) => ({ souls: [{ id: 's_1', name: 'Juniper', p, yaw: 0, doing: 'standing', activity: 'idle', ...extra }], speech: [], navbar: [], text: '' });

test('step checks read movement, nearness, posture, speech and banners from the page state', () => {
  const d = { checks: ['moved', 'near', 'seated', 'spoke', 'held', 'facing'], near: [10, 0] };
  const after = { ...soulAt([9, 0, 0], { doing: 'seated', prop: 'core/book@1' }), speech: [{ soul: 's_1', text: 'hello' }], text: 'This world\'s stream is not available right now.' };
  const c = Object.fromEntries(checkStep(d, { before: soulAt([0, 0, 0]), after, soul: { id: 's_1' } }).map((x) => [x.check, x]));
  for (const k of ['moved', 'near-target', 'seated', 'spoke', 'held-item', 'facing', 'soul-visible']) assert.equal(c[k].ok, true, k);
  assert.equal(c['no-bad-banner'].ok, false);
  const still = Object.fromEntries(checkStep({ checks: ['moved', 'seated'] }, { before: soulAt([0, 0, 0]), after: soulAt([0.5, 0, 0]), soul: { id: 's_1' } }).map((x) => [x.check, x]));
  assert.equal(still.moved.ok, false); assert.equal(still.seated.ok, false);
});

test('arrival needs the Soul in the world, named, in the navbar, the camera on it and its card connected', () => {
  const st = { ...soulAt([5, 0, 5]), navbar: ['Open Juniper'], camera: { pivot: [6, 0, 5] }, card: { name: 'Juniper', statusKey: 'connected' } };
  assert.ok(arrivalChecks(st, { id: 's_1' }).every((c) => c.ok));
  const bare = arrivalChecks({ ...soulAt([5, 0, 5]), camera: { pivot: [90, 0, 5] } }, { id: 's_1' });
  assert.deepEqual(bare.filter((c) => !c.ok).map((c) => c.check), ['in-navbar', 'camera-on-soul', 'card-connected']);
});

test('the judge\'s verdict is its last JSON object; anything else is unclear', () => {
  assert.equal(parseVerdict('I looked.\n{"verdict":"fail","seen":"a blank sky","problems":["no world"]}').verdict, 'fail');
  assert.equal(parseVerdict('no json').verdict, 'unclear');
});

test('the report turns failed steps into findings, worst first, and renders a table', () => {
  const steps = [
    { id: 'S2', title: 'Open Eden', expect: 'world', verdict: 'pass', checks: [{ check: 'live', ok: true, severity: 'blocker' }], shots: ['/o/shots/S2-after.png'] },
    { id: 'E3', title: 'Put out the campfire', ask: 'Put out the campfire.', expect: 'fire out', verdict: 'fail', seen: 'the fire still burns', severity: 'major',
      checks: [{ check: 'facing', ok: false, detail: '90 degrees off', severity: 'minor' }], shots: ['/o/shots/E3-after.png'], consoleErrors: ['boom'] },
    { id: 'S6', title: 'Approve', expect: 'arrives', verdict: 'pass', severity: 'blocker', checks: [{ check: 'in-navbar', ok: false, detail: 'none', severity: 'major' }], shots: [] },
  ];
  assert.equal(stepPassed(steps[0]), true); assert.equal(stepPassed(steps[2]), false);
  const f = findingsOf(steps, { repro: (s) => `rerun ${s.id}` });
  assert.deepEqual(f.map((x) => [x.step, x.severity]), [['S6', 'blocker'], ['E3', 'major'], ['E3', 'minor'], ['E3', 'minor']]);
  assert.match(f[1].seen, /fire still burns/);
  const turns = [{ step: 'S4', said: 'Read the instructions', summary: { seconds: 40, tools: 5, questions: ['Shall I?'], denials: [], blocked: [], worldRefusals: [], repeats: [], errors: 0 } }];
  const md = markdown({ target: 'local', stamp: 'x', passed: 1, steps, findings: f, confusing: confusingOf(turns), videos: [], agent: { transcript: '/o/agent/t.jsonl' } }, { root: '/o' });
  assert.match(md, /\| E3 \| "Put out the campfire\." \| FAIL/);
  assert.match(md, /S4: Shall I\?/);
  assert.match(md, /shots\/E3-after\.png/);
});
