// #1475 rework (arm B, #1098): a refusal whose code the world's reference documents ends with `see: "help <topic>"`, and
// that topic's section names the code; other codes add nothing, and --json is the world's answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HELP_TOPICS, NEXT_STEP, SEE_TOPIC, referenceSection} from './soul/eden.mjs';

const soul = fileURLToPath(new URL('./soul/', import.meta.url));
const CLI = join(soul, 'eden.mjs'), notes = readFileSync(join(soul, 'schema-notes.md'), 'utf8');

test('every code that names a topic is written in that topic\'s section', () => {
  for (const [code, topic] of Object.entries(SEE_TOPIC)) {
    assert.ok(HELP_TOPICS.includes(topic), `${code}: ${topic} is a topic`);
    assert.ok(referenceSection(notes, topic).includes('`' + code + '`'), `${code} is in help ${topic}`);
  }
  assert.match(referenceSection(notes, 'refusals'), /`capability\.unknown`: no offer here has that id\. Never build an id from words[^]*`resolve "<the words>"`/);
});

test('#1475 arm B3: every refusals-topic code prints its own next step; the rides codes keep only see', () => {
  for (const [code, topic] of Object.entries(SEE_TOPIC)) assert.equal(Object.hasOwn(NEXT_STEP, code), topic === 'refusals', code);
  assert.match(NEXT_STEP['route.unreachable'], /go where `alternatives` names/);
  assert.match(NEXT_STEP['capability.unknown'], /Never build one from words/);
});

test('act and resolve refusals end with see: help <topic>; an undocumented code and --json add nothing', async t => {
  const refusals = {
    'fly:lab-pond-hall/hall': {code: 'capability.unknown', reason: 'Nothing offered matches.'},
    'walk:field': {code: 'capability.params', reason: 'Bad params.', params: {seconds: {type: 'number'}}},
    'object:balloon:steer': {code: 'steer.unknown-place', reason: 'No such place.'},
    'dance:here': {code: 'act.cooldown', reason: 'Not yet.'},
  };
  const server = createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b || '{}'); res.writeHead(200, {'content-type': 'application/json'});
      if (req.url === '/v1/edge/resolve') return res.end(JSON.stringify({resolve: body.capability === 'fly up to the pond hall'
        ? {ok: false, code: 'ride.unavailable', reason: 'No ride goes there.', alternatives: [{id: 'walk:lab-pond-hall', label: 'Walk to the pond hall', partial: true}]}
        : {ok: false, code: 'capability.unknown', reason: 'Nothing offered matches.', candidates: []}}));
      if (req.url.startsWith('/v1/edge/objects/')) return res.end(JSON.stringify({object: {actions: [{action: 'steer', available: true}]}}));
      res.end(JSON.stringify({accepted: false, ...refusals[body.capability]}));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'eden-cli-see-')); t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-see-token'}), {mode: 0o600});
  const cli = (...args) => new Promise(res => execFile(process.execPath, [CLI, ...args], {cwd: dir}, (e, out) => res({code: e?.code ?? 0, out: JSON.parse(out), text: out})));

  const made = await cli('act', 'fly:lab-pond-hall/hall');
  assert.equal(made.out.code, 'capability.unknown'); assert.equal(made.out.see, 'help refusals'); assert.equal(made.out.next, NEXT_STEP['capability.unknown']);
  assert.equal(Object.keys(made.out).at(-1), 'see', 'the pointer is the last thing printed');
  assert.equal((await cli('act', 'walk:field')).out.see, 'help refusals');
  const steer = (await cli('act', 'object:balloon:steer', '{"to":"nowhere"}')).out; assert.equal(steer.see, 'help rides'); assert.equal(steer.next, undefined);
  const other = await cli('act', 'dance:here');
  assert.equal(other.out.code, 'act.cooldown'); assert.equal(other.out.see, undefined);
  const raw = await cli('act', 'fly:lab-pond-hall/hall', '--json');
  assert.equal(raw.out.code, 'capability.unknown'); assert.equal(raw.out.see, undefined, '--json is the world\'s answer'); assert.equal(raw.out.next, undefined);

  const words = await cli('act', 'fly to the hall');
  assert.equal(words.code, 2); assert.equal(words.out.code, 'act.not-an-id'); assert.equal(words.out.see, 'help refusals');
  assert.equal((await cli('act', 'fly to the hall', '--json')).out.see, undefined);
  const ride = await cli('resolve', 'fly up to the pond hall');
  assert.equal(ride.out.code, 'ride.unavailable'); assert.equal(ride.out.alternatives[0].id, 'walk:lab-pond-hall'); assert.equal(ride.out.see, 'help refusals'); assert.equal(ride.out.next, NEXT_STEP['ride.unavailable']);
  assert.equal((await cli('resolve', 'fly up to the pond hall', '--json')).out.see, undefined);
});
