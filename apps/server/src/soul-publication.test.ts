// SOUL3 publication: the launcher's pinned Soul files (tools/world-launcher/soul, SOURCES.json) are served byte for byte,
// and the rendered instructions capture gets this world's approved URL, name and requested window code per request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture} from '../test/native-owner-fixture.ts';
import {CAPTURE, fillInstructions} from './accounts/instructions.ts';

const dir = new URL('../../../tools/world-launcher/soul/', import.meta.url).pathname;
const sources = JSON.parse(readFileSync(dir + 'SOURCES.json', 'utf8'));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const capture = readFileSync(dir + 'instructions.md', 'utf8');

// Keep the historical test identity for release-gate comparison. Versions and hashes are stamped once per release by the
// release owner (tools/world-launcher/soul/stamp.mjs; the release gate runs its --check, #1935), so these tests compare what
// the server publishes with what the files on disk state and hash to, and a client change edits no literal here.
const cliVersion = /^const VERSION = "([0-9.]+)";$/m.exec(readFileSync(dir + 'eden.mjs', 'utf8'))?.[1] ?? '';
const skillVersion = /^  version: "([0-9.]+)"$/m.exec(readFileSync(dir + 'skill.md', 'utf8'))?.[1];
test('SOURCES.json pins every published Soul file by sha: the 2.2.1 controller and guides (soul fix round 1 release candidate), and the retained 1.9 CLI', () => {
  assert.equal(sources.controllerCli.file, 'eden.mjs'); assert.match(cliVersion, /^[0-9]+(\.[0-9]+)*$/, 'eden.mjs states its version');
  assert.equal(sources.skill.version, sources.controllerCli.version, '#1875 A1: the skill and the CLI carry one version');
  assert.equal(skillVersion, cliVersion, '#1875 A1: and so do the files');
  assert.ok(!readFileSync(dir + 'skill.md', 'utf8').includes('{{'), '#1875: no template, so the bytes /v1/config describes are the bytes /skill.md serves');
  assert.equal(sources.cli.file, 'eden-agent.mjs'); assert.ok(readFileSync(dir + 'eden-agent.mjs', 'utf8').includes(`SKILL_VERSION = "${sources.cli.version}.`), 'the legacy CLI keeps its version');
  assert.deepEqual(sources.instructions.capture, CAPTURE, 'the server recognises exactly the recorded capture');
  assert.ok(sources.legacy.skill.sha256 && sources.legacy.instructions.sha256, 'the 1.9 guide provenance is kept');
});

test('the capture gets the world URL, name and a valid window code; no code or a bad one drops the flag and the window claim', () => {
  assert.ok(capture.includes(CAPTURE.base) && capture.includes(` --for ${CAPTURE.code}`), 'the published file is the capture');
  const worlds = [['https://sim.example.test/worlds/w/bench-hamlet', 'Bench Hamlet', 'K7QX-M2PA'], ['http://127.0.0.1:4956/w/mars', 'Mars', 'ZZ22-HJ9P']];
  for (const [base, world, code] of worlds) {
    const out = fillInstructions(capture, 'https://spoofed.test/w/x', world, code, base);
    assert.ok(out.startsWith(`# Create a Soul in ${world}\n\nWorld: ${base} (the world's name is **${world}**;`));
    assert.equal(out.split(`${base}/eden.mjs`).length - 1, 1); assert.equal(out.split(`register ${base}\n`).length - 1, 1);
    assert.equal(out.split(` --for ${code}`).length - 1, 2); assert.match(out, /open Sim window/);
    for (const gone of [CAPTURE.code, 'eden-2026', 'Eden 2026', 'spoofed.test']) assert.ok(!out.includes(gone), gone);
    assert.ok(out.includes('`pair <soulId> --for <CODE>`'), 'the generic pairing placeholder is not a captured code');
  }
  for (const bad of [null, undefined, '', 'k7qx-m2pa', 'K7QX-M2PA`; rm -rf /', '<script>', CAPTURE.code + 'X']) {
    const out = fillInstructions(capture, 'https://x.test/w/a', 'A', bad, 'https://sim.example.test/worlds/w/a');
    assert.match(out, /node eden\.mjs create "<Name>"\n/); assert.match(out, /`create "<new name>"` and a new background/);
    assert.ok(!/--for (?!<CODE>)/.test(out) && !/rm -rf|script|GL7R|open Sim window/.test(out), String(bad));
    assert.match(out, /printed `approvalURL` as a raw clickable link/);
  }
  const lookalike = capture.replace('# Create a Soul in Eden 2026', '# Create a Soul in  Eden 2026');
  assert.equal(fillInstructions(lookalike, 'b', 'w', 'K7QX-M2PA', 'a'), lookalike, 'only the exact capture is rewritten');
});

test('HTTP: the real published files are served by hash; the guide uses configuration, never the request host', async t => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  Object.assign(f.souls.cfg, {controllerCliFile: dir + 'eden.mjs', skillFile: dir + 'skill.md', instructionsFile: dir + 'instructions.md', publicUrl: 'https://sim.example.test'});
  const onDisk = (file: string) => sha(readFileSync(dir + file));
  assert.equal(sha(Buffer.from(await (await f.request('/eden.mjs')).arrayBuffer())), onDisk('eden.mjs'));
  const described = (await (await f.request('/v1/config')).json() as {soulClient: {sha256: string; skill: {version: string; sha256: string}}}).soulClient;
  assert.equal(described.sha256, onDisk('eden.mjs'), '/v1/config describes the bundle it serves');
  assert.deepEqual([described.skill.version, described.skill.sha256], [skillVersion, onDisk('skill.md')], '#1875: and the skill beside it');
  assert.equal((await f.request('/eden-agent.mjs')).status, 404, '#1754: the legacy client is not served');
  assert.equal(sha(await (await f.request('/skill.md')).text()), onDisk('skill.md'), 'the 2.1 skill has no templates');
  // CTRL-7 (#1099): a short core (its size limit is a client test now, tools/world-launcher/soul-skill-size.test.mjs, #1935);
  // the reference is its notes plus the generated schema, cacheable by ETag
  const core = await (await f.request('/skill.md')).text();
  assert.doesNotMatch(core, /\b(cannot|can't|must not)\b/i, 'the offers say what is possible');
  const ref = await f.request('/schema.md'), refText = await ref.text(), etag = ref.headers.get('etag')!;
  assert.match(refText, /\| walk \| via \|/); assert.match(refText, /When things go wrong/);
  assert.doesNotMatch(refText, /structured intent/, 'a strict act takes offered ids only');
  assert.equal((await f.app.request('/schema.md', {headers: {'if-none-match': etag}})).status, 304);
  const get = (q: string) => f.app.request('/instructions.md' + q, {headers: {host: 'evil.test', 'x-forwarded-host': 'evil.test'}});
  const mine = await get('?for=K7QX-M2PA'), text = await mine.text();
  assert.equal(mine.status, 200); assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.ok(text.startsWith('# Create a Soul in Eden\n\nWorld: https://sim.example.test/w/eden ('));
  assert.match(text, /create "<Name>" --for K7QX-M2PA/); assert.ok(!/evil|GL7R|eden-2026/.test(text));
  const plain = await get(''), shared = await plain.text();
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=60'); assert.ok(!/--for (?!<CODE>)|GL7R/.test(shared));
});
