#!/usr/bin/env node
// A social party composed from the shipped jukebox, body gestures and shared-beat dance.
// All movement and activity changes are commands through the world's downloaded Soul client.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startOldPage } from '../arena/new-engine/old-page.mjs';
import { exportFacts } from '../arena/new-engine/world.mjs';
import { defOf } from '../../entry/look.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['Cedar', 'Maple', 'Willow', 'Birch', 'Aspen'];

export function partyTemplate(jukeboxEntry) {
  assert.equal(jukeboxEntry.kind, 'eden:jukebox', 'use the shipped jukebox');
  const def = defOf(jukeboxEntry);
  assert(def, 'the jukebox must have its existing shape');
  return {
    schema: 'genesis/1', name: 'Garden party', description: 'A jukebox beside an open dance space.',
    constants: { extent: 50, ground: 'land' },
    batches: [{ group: 'party-rehearsal', ops: [
      { op: 'define', def },
      { op: 'place', def: 'core/jukebox@1', name: 'party-jukebox', p: [4, 0, -2] },
    ] }],
  };
}

export function completed(answer, label) {
  assert.equal(answer.ok, true, `${label}: ${answer.code ?? 'not accepted'}`);
  assert.equal(answer.phase, 'done', `${label}: ${answer.phase ?? 'no terminal receipt'}`);
  assert(answer.receipt?.answers?.some((row) => row.answer === 'receipt'), `${label}: terminal receipt`);
  return answer;
}

/** One member leaving must not end the other members' dance. The camera records this entire sequence. */
export async function performParty({ seats, jukebox, mode = 'jukebox', record = () => {}, pause = sleep }) {
  assert.equal(seats.length, 5, 'the rehearsal uses five independent Souls');
  assert(['silent', 'jukebox'].includes(mode), 'choose an explicit supported music mode');
  const [operator, ...guests] = seats;
  const command = async (seat, ...words) => {
    const answer = await seat.cli(...words);
    record({ person: seat.label, words, answer });
    return answer;
  };
  const act = async (seat, form, target, ...args) => completed(await command(seat, 'act', `${form}:${target}`, ...args, '--wait'), form);
  const body = async (seat, form) => completed(await command(seat, 'act', form, '--wait'), form);
  const walk = (seat, target) => act(seat, 'walk', target);
  const leave = async (seat) => completed(await command(seat, 'together', 'leave', 'dance-together'), 'leave dance');
  async function spoken(speaker, listener, words, gesture) {
    const sent = await command(speaker, 'say', words, '--to', listener.body, '--gesture', gesture);
    assert.equal(sent.ok, true, 'the spoken greeting is admitted');
    assert(Number.isInteger(sent.sequence) && Number.isInteger(sent.to?.sequence), 'speech and gesture have separate real receipts');
    for (const sequence of [sent.sequence, sent.to.sequence]) {
      for (const until = Date.now() + 15000;;) {
        const answer = await command(speaker, 'receipt', String(sequence));
        const last = answer.receipt?.answers?.at(-1);
        assert.notEqual(last?.answer, 'refused', `greeting: ${last?.reason}`);
        if (last?.answer === 'receipt' && !answer.receipt.going) break;
        assert(Date.now() < until, 'speech and gesture must complete'); await pause(100);
      }
    }
    for (const until = Date.now() + 15000;;) {
      const events = await command(listener, 'events');
      if (events.events?.some((event) => event.kind === 'heard' && event.words === words)) break;
      assert(Date.now() < until, 'the other Soul must actually hear the words'); await pause(100);
    }
  }
  await spoken(operator, guests[0], 'Welcome! Would you like to dance?', 'wave');
  await spoken(guests[0], operator, 'Yes, let us dance together!', 'nod');
  if (mode === 'jukebox') {
    await walk(operator, jukebox);
    await act(operator, 'switch_on', jukebox);
    await walk(operator, guests[0].body);
  } else {
    const music = await command(operator, 'inspect', jukebox);
    assert.equal(music.state?.on, false, 'silent mode requires the jukebox to remain off');
  }
  completed(await command(operator, 'together', 'offer', 'dance-together', ...guests.map((seat) => seat.body)), 'offer dance');
  for (const guest of guests) completed(await command(guest, 'together', 'accept', 'dance-together'), 'accept dance');
  const together = await command(operator, 'look');
  assert((together.doing ?? []).some((line) => line.includes('dance-together') && line.includes('started')), 'the dance starts through its real offer');
  await pause(6500);
  const leaving = guests.at(-1);
  await leave(leaving);
  // A leave releases a move at its phase boundary. Keep that visible rather than cutting to the next action.
  await pause(850);
  await body(leaving, 'wave');
  const remaining = await command(operator, 'look');
  assert((remaining.doing ?? []).some((line) => line.includes('dance-together') && line.includes('started')), 'the other four keep dancing after one leaves');
  await pause(2500);
  for (const guest of guests.slice(0, -1)) await leave(guest);
  await leave(operator);
  await pause(850);
  if (mode === 'jukebox') await act(operator, 'switch_off', jukebox);
  else {
    const music = await command(operator, 'inspect', jukebox);
    assert.equal(music.state?.on, false, 'silent mode must finish with the jukebox off');
  }
  await body(operator, 'nod');
  const final = await Promise.all(seats.map((seat) => command(seat, 'look')));
  assert(final.every((look) => !(look.doing ?? []).some((line) => line.includes('dance-together'))), 'all members leave the dance');
  return { people: seats.length, jukebox: mode === 'silent' ? 'off-unfinished-approach' : 'switched-on-and-off', mode, dance: 'shared-beat', earlyDeparture: true, allLeft: true, soundProved: false };
}

async function pairServedSeat({ world, page, directory, index, record, register }) {
  const folder = join(directory, 'people', String(index));
  mkdirSync(folder, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SOULS_HOME: join(folder, '.souls'), BRAIN_MODE: 'fake' };
  const seat = { label: names[index], body: null, cli: async (...words) => {
    const result = await exec(process.execPath, [join(directory, 'served-client.mjs'), ...words], { cwd: folder, env, timeout: 90000, maxBuffer: 8000000 });
    for (const line of result.stdout.trim().split('\n').reverse()) { try { return JSON.parse(line); } catch { /* pair prints its approval link too */ } }
    throw new Error('the served client returned no JSON answer');
  } };
  register(seat); // Even a partially paired home is cleaned up if later preparation fails.
  const pairing = await seat.cli('pair', page, '--name', names[index]);
  assert.equal(pairing.step, 'approve');
  const approved = await fetch(new URL('/v1/pair/approve', world.directory), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, confirm: true, test_person: `party-owner-${index}` }),
  });
  assert.equal(approved.status, 200);
  for (const until = Date.now() + 30000; Date.now() < until;) {
    const status = await seat.cli('status');
    if (status.connected && !status.syncing && status.body) { seat.body = status.body; record({ person: seat.label, status }); return seat; }
    await sleep(100);
  }
  throw new Error('the paired Soul did not arrive');
}

export async function rehearse({ directory, mode = 'jukebox', startFile = null, onReady = () => {} }) {
  directory = resolve(directory);
  assert(!existsSync(directory), 'use a fresh isolated output directory');
  assert(directory.startsWith(join(REPO_ROOT, '.local') + '/'), 'outputs belong in this checkout’s ignored .local/');
  mkdirSync(directory, { recursive: true });
  const report = { fakeMinds: true, rows: [], complete: false };
  const save = () => {
    const file = join(directory, 'rehearsal-private.json');
    writeFileSync(file + '.tmp', JSON.stringify(report, null, 2)); renameSync(file + '.tmp', file);
  };
  const record = (row) => { report.rows.push({ at: Date.now(), ...row }); save(); };
  const template = join(directory, 'garden-party.json');
  writeFileSync(template, JSON.stringify(partyTemplate(JSON.parse(readFileSync(join(REPO_ROOT, 'content/kinds/music/jukebox.json'), 'utf8')))));
  const facts = exportFacts(template, join(directory, 'facts.json'));
  let running;
  const seats = [];
  try {
    running = await startOldPage({ template, facts, dir: join(directory, 'page') });
    report.page = running.page; save();
    const config = await (await fetch(running.page + 'v1/config')).json();
    const response = await fetch(running.page + 'eden.mjs');
    const client = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(hash(client), config.soulClient.sha256, 'the downloaded client matches the served hash');
    writeFileSync(join(directory, 'served-client.mjs'), client); report.clientSHA256 = hash(client);
    for (let index = 0; index < 5; index++) await pairServedSeat({ world: running.world, page: running.page, directory, index, record, register: (seat) => seats.push(seat) });
    const found = await seats[0].cli('find', 'party-jukebox');
    const jukebox = found.found.find((node) => node.kind === 'eden:jukebox')?.id;
    assert(jukebox, 'the served client sees the existing jukebox kind');
    const floor = (await seats[0].cli('inspect', seats[0].body)).parent;
    assert(floor, 'the Soul stands on its authoritative floor');
    report.ready = true; save(); await onReady({ page: running.page, directory });
    if (startFile) {
      for (const until = Date.now() + 300000; !existsSync(startFile);) { assert(Date.now() < until, 'the recorder did not start'); await sleep(100); }
    }
    report.demonstrationStart = Date.now(); save();
    report.result = await performParty({ seats, jukebox, mode = 'jukebox', record });
    report.complete = true; report.demonstrationEnd = Date.now(); save();
    await sleep(2000);
    return report;
  } catch (error) { report.failure = String(error.stack ?? error); save(); throw error; }
  finally {
    await Promise.allSettled(seats.map((seat) => seat.cli('quit')));
    if (running) await running.stop();
    report.stopped = true; save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  if (!args.includes('--dir')) throw new Error('usage: rehearse.mjs --dir .local/<fresh folder> [--silent] [--start-file <recorder marker>]');
  const result = await rehearse({ directory: value('--dir'), mode: args.includes('--silent') ? 'silent' : 'jukebox', startFile: args.includes('--start-file') ? resolve(value('--start-file')) : null,
    onReady: ({ page }) => console.log(JSON.stringify({ ready: true, page })),
  });
  console.log(JSON.stringify({ complete: result.complete, result: result.result }));
}
