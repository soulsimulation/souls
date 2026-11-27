// Resource-free fixed counter-match diagnostic. Callers own already-paired ordinary clients and their lifecycle.
// No world, browser, models or private fixture ids are created here; this is not independent-agent collaboration.
import assert from 'node:assert/strict';
const pause = ms => new Promise(done => setTimeout(done, ms));

export function counterState(answer) {
  assert.equal(answer.ok, true, 'counter inspect must succeed');
  const { remaining, turn } = answer.state ?? {};
  assert(Number.isInteger(remaining) && remaining >= 0 && remaining <= 7, 'remaining must be an observed counter count');
  assert(['first', 'second'].includes(turn), 'turn must name the observed next side');
  return { remaining, turn, winner: remaining === 0 ? (turn === 'first' ? 'second' : 'first') : null };
}
export function counterOffer(answer, form, args = {}) {
  const offer = answer.offers?.find(o => o.name === form);
  assert(typeof offer?.act === 'string', `inspect must teach ${form}`);
  for (const key of Object.keys(args)) assert(offer.params?.[key], `inspect must teach ${form} parameter ${key}`);
  return [offer.act, ...Object.entries(args).map(([key, value]) => `${key}=${value}`)];
}
export function counterDone(answer, label) {
  assert(answer.ok === true && answer.phase === 'done' && answer.receipt?.answers?.at(-1)?.answer === 'receipt', `${label}: ${answer.code ?? answer.phase ?? 'no terminal receipt'}`);
  return answer;
}
export function counterRefused(answer, reason) {
  assert(Number.isSafeInteger(answer.sequence) && answer.sequence > 0, 'refusal must be an ordinary sent native sequence');
  assert.equal(answer.phase, 'refused', 'refusal must reach its terminal phase');
  assert.equal(answer.receipt?.sequence, answer.sequence, 'refusal must retain the exact native sequence');
  const last = answer.receipt?.answers?.at(-1);
  assert(last?.answer === 'refused' && last.reason === reason, `expected native refusal ${reason}`);
  return answer;
}
function activityId(look) {
  assert.equal(look.ok, true, 'activity look must succeed');
  const lines = (look.in ?? []).filter(line => line.includes('counter-match'));
  assert.equal(lines.length, 1, 'look must name one counter-match activity');
  const id = /(?:leave:|take it back:) together leave (\S+)$/.exec(lines[0])?.[1];
  assert(id, 'look must teach the exact activity id'); return id;
}

/** Discover actual public syntax and cards in each player's own copy before any offer or action. */
export async function discoverCounterMatch({ seats, name = 'counter-match', command }) {
  const discovered = [];
  for (const seat of seats) {
    const help = await command(seat, 'help');
    for (const op of ['look', 'find', 'inspect', 'can', 'act', 'together', 'events']) assert(help.commands?.includes(op), `help must list ${op}`);
    const look = await command(seat, 'look');
    assert(look.ok === true && !(look.in ?? []).length, 'players must be free before offering; never cancel an existing activity');
    const catalog = await command(seat, 'together', 'kinds');
    const activity = catalog.activities?.find(row => row.word === 'counter-match');
    assert(catalog.ok === true && activity?.card && !activity.how, 'the world must serve an offerable counter-match');
    assert(activity.where?.includes('(eden:counter_match)'), 'counter-match must be offered at the discovered table kind');
    assert(Number.isInteger(activity.asks) && activity.asks >= seats.length - 1, 'the served invitation count must accommodate this diagnostic');
    const found = await command(seat, 'find', name);
    const boards = (found.found ?? []).filter(row => row.kind?.split('@')[0] === 'eden:counter_match');
    assert(found.ok === true && boards.length === 1 && boards[0].id, 'find must uniquely identify the actual counter table');
    const board = await command(seat, 'inspect', boards[0].id);
    assert.equal(board.id, boards[0].id, 'inspect must read the selected table'); counterState(board);
    const stands = [...new Set(board.card?.match(/\bsecond_(?:stand|back|far)\b/g) ?? [])];
    assert.equal(stands.length, 3, 'the public card must teach three named second-side approaches');
    assert(/offerer first/i.test(board.card), 'the public card must identify the offerer as first');
    counterOffer(board, 'walk');
    for (const form of ['take_1_first', 'take_2_first', 'take_1_second', 'take_2_second', 'restart']) counterOffer(board, form, form.endsWith('second') ? { stand: stands[0] } : {});
    discovered.push({ person: seat.label, board, activity, stands });
  }
  assert(discovered.every(row => row.board.id === discovered[0].board.id), 'players must discover the same table');
  assert(discovered.every(row => JSON.stringify(row.stands) === JSON.stringify(discovered[0].stands)), 'players must agree on the publicly named approaches');
  return discovered;
}

/** Turn/refusal/consent diagnostic through ordinary interfaces; successful receipts are followed by state reads. */
export async function rehearseCounterMatch({ seats, name, record = () => {}, sleep = pause, observe = async () => {}, midRoundDeparture = false }) {
  assert(seats.length >= 2 && seats.length <= 4, 'this diagnostic plays the intended 1 versus 1–3 layout');
  assert(!midRoundDeparture || seats.length >= 3, 'mid-round departure needs a remaining teammate');
  assert(new Set(seats.map(s => s.body)).size === seats.length && new Set(seats.map(s => s.label)).size === seats.length && seats.every(s => s.body && s.label), 'each participant must control a distinct known body');
  const command = async (seat, ...words) => { const answer = await seat.cli(...words); record({ person: seat.label, words, answer }); return answer; };
  const discovery = await discoverCounterMatch({ seats, name, command }), board = discovery[0].board.id;
  const [first, ...second] = seats, word = discovery[0].activity.word;
  const read = async (seat, expected) => {
    const answer = await command(seat, 'inspect', board); assert.equal(answer.id, board, 'state readback must retain table identity');
    const state = counterState(answer);
    for (const [key, value] of Object.entries(expected)) assert.equal(state[key], value, `counter ${key} readback`);
    await observe('state', { seat, board, state, answer });
    return state;
  };
  const use = async (seat, form, args) => counterDone(await command(seat, 'act', ...counterOffer(discovery[seats.indexOf(seat)].board, form, args), '--wait'), form);
  const membership = async (id, people) => {
    const answer = await command(first, 'inspect', id);
    assert(answer.ok === true && answer.id === id && answer.activity === word, 'inspect must identify this activity');
    if (people.some(s => s !== first)) assert.equal(answer.started, true, 'accepted sides must start the game');
    assert.deepEqual(answer.members?.map(m => [m.body, m.role]).sort(), people.map(s => [s.body, s === first ? 'first' : 'second']).sort(), 'public roles must match the accepted participants');
    assert.equal(answer.leave, `together leave ${id}`, 'inspect must teach independent leave'); return answer;
  };
  await read(first, { remaining: 7, turn: 'first', winner: null });
  // Use each client's discovered ordinary approach, never assume fixture placement or hand reach.
  const approaches = [];
  for (const seat of seats) {
    const reply = counterDone(await command(seat, 'act', ...counterOffer(discovery[seats.indexOf(seat)].board, 'walk'), '--wait'), 'approach table');
    approaches.push({ person: seat.label, reply });
  }
  for (const seat of seats) { const look = await command(seat, 'look'); assert(look.ok === true && !(look.in ?? []).length, 'players must still be free immediately before offering'); }
  counterDone(await command(first, 'together', 'offer', word, ...second.map(s => s.body)), 'offer game');
  const id = activityId(await command(first, 'look'));
  const accept = async seat => {
    let invitation;
    for (let n = 0; n < 10 && !invitation; n++) {
      const events = await command(seat, 'events');
      assert(!events.events?.some(e => e.kind === 'together' && (e.offer === id || e.activity === id) && ['declined', 'expired', 'ended'].includes(e.what)), 'this game invitation became unavailable');
      invitation = events.events?.find(e => e.kind === 'together' && e.what === 'offered' && e.offer === id && e.touch === word && e.from_id === first.body);
      if (!invitation) await sleep(100);
    }
    assert(invitation, 'the player must observe the exact invitation before accepting');
    counterDone(await command(seat, 'together', 'accept', invitation.offer), 'accept game');
  };
  await accept(second[0]);
  const initialMembers = await membership(id, [first, second[0]]);
  const secondArgs = seat => ({ stand: discovery[seats.indexOf(seat)].stands[second.indexOf(seat)] });
  const wrongTurnAdvisory = await command(second[0], 'can', ...counterOffer(discovery[1].board, 'take_1_second', secondArgs(second[0])));
  const wrongTurn = counterRefused(await command(second[0], 'act', ...counterOffer(discovery[1].board, 'take_1_second', secondArgs(second[0])), '--wait'), 'field_differs');
  await read(first, { remaining: 7, turn: 'first', winner: null });
  await use(first, 'take_1_first'); await read(first, { remaining: 6, turn: 'second' });
  for (const seat of second.slice(1)) await accept(seat);
  const allMembers = await membership(id, seats);
  const recovered = await command(second[0], 'can', ...counterOffer(discovery[1].board, 'take_2_second', secondArgs(second[0])));
  await use(second[0], 'take_2_second', secondArgs(second[0])); await read(second[0], { remaining: 4, turn: 'first' });
  await use(first, 'take_1_first'); await read(first, { remaining: 3, turn: 'second' });
  const departures = [];
  const depart = async (seat, expected) => {
    counterDone(await command(seat, 'together', 'leave', id), 'independent leave');
    const look = await command(seat, 'look'); assert(look.ok === true && !(look.in ?? []).some(line => line.includes(word)), 'departed player must no longer be a member');
    departures.push(seat.label); await membership(id, seats.filter(s => !departures.includes(s.label)));
    await read(first, expected);
    await observe('departure', { seat, board, midRound: expected.remaining === 3 });
  };
  if (midRoundDeparture) await depart(second.at(-1), { remaining: 3, turn: 'second' });
  const next = midRoundDeparture ? second[0] : second.at(-1);
  await use(next, 'take_1_second', secondArgs(next)); await read(second.at(-1), { remaining: 2, turn: 'first' });
  await use(first, 'take_2_first'); const finished = await read(first, { remaining: 0, turn: 'second', winner: 'first' });
  await use(first, 'restart'); await read(first, { remaining: 7, turn: 'first', winner: null });
  for (const seat of [...second].reverse().filter(s => !departures.includes(s.label))) await depart(seat, { remaining: 7, turn: 'first' });
  const noOpponentAdvisory = await command(first, 'can', ...counterOffer(discovery[0].board, 'take_1_first'));
  const noOpponent = counterRefused(await command(first, 'act', ...counterOffer(discovery[0].board, 'take_1_first'), '--wait'), 'not_linked');
  await read(first, { remaining: 7, turn: 'first' });
  counterDone(await command(first, 'together', 'leave', id), 'first leaves');
  const final = await command(first, 'look'); assert(final.ok === true && !(final.in ?? []).some(line => line.includes(word)), 'first must leave too');
  await observe('clean', { seats, board });
  return { complete: true, diagnosticOnly: true, independentCollaborationProved: false, approaches, handContactProved: false, discovery, initialMembers, allMembers,
    refusalRecovery: { wrongTurnAdvisory, wrongTurn, recovered, completedSecondTake: true }, finished, winnerBasis: 'remaining=0: opposite the recorded next turn; last observed taker was first', departures, midRoundDeparture, noOpponentAdvisory, noOpponent };
}
