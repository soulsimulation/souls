// The v2 entries runner (tools/entry/v2/, 0.135 E8), driven through its transport: an argument that names a body, a
// Soul or the runner's own thing key reaches the form, and a list field is written to and read back from the tree.
// It runs the built runner (`cargo build --release --manifest-path ../tools/entry/v2/Cargo.toml --target-dir target`
// from v2/, as tools/entry/v2.mjs builds it); a checkout where it is not built has no world to drive, and says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import v2Transport from './v2.mjs';
import {loadCases, loadKinds} from '../../packages/form-rules/src/load.ts';

const BIN = fileURLToPath(new URL('../../v2/target/release/entry-v2', import.meta.url));
const unbuilt = existsSync(BIN) ? false : 'tools/entry/v2 is not built here (no Rust toolchain on this leg)';
const all = loadKinds();
const caseNamed = name => loadCases().find(([, c]) => c.name === name)[1];

async function world(kinds) {
  const t = v2Transport({build: 'no'});
  await t.start(kinds.map(k => ({kind: k, entry: all[k]})));
  return t;
}

test('an argument naming a body the case names reaches the form (swings push_someone_here)', {skip: unbuilt}, async () => {
  const t = await world(['eden:swings']);
  try {
    const c = caseNamed('push_someone_here');
    const id = await t.place('eden:swings');
    const got = await t.act(id, 'push', c.act.args, {case: c, ids: {t1: id}});
    assert.notEqual(got.code, 'arg-missing', JSON.stringify(got));
    assert.equal(got.verdict, 'yes', JSON.stringify(got));
  } finally { await t.stop(); }
});

test("an argument naming a thing by the runner's own key reaches the form", {skip: unbuilt}, async () => {
  const t = await world(['eden:swings']);
  try {
    const c = caseNamed('push_someone_here');
    const id = await t.place('eden:swings'), other = await t.place('eden:swings');
    // the case names the other swings by the runner's key and does not map it in ids
    const nodes = {...c.state.nodes, room: {loose: [...c.state.nodes.room.loose, other]}, [other]: {kind: 'eden:swings'}};
    const got = await t.act(id, 'push', {who: other}, {case: {act: {...c.act, args: {who: other}}, state: {...c.state, nodes}}, ids: {t1: id}});
    assert.notEqual(got.code, 'arg-missing', JSON.stringify(got));
    assert.equal(got.verdict, 'yes', JSON.stringify(got));
  } finally { await t.stop(); }
});

test('a list field is written to the tree and read back from it, enums in records by their bare names', {skip: unbuilt}, async () => {
  const t = await world(['eden:chess_table', 'eden:signup_sheet']);
  try {
    const board = await t.place('eden:chess_table');
    assert.deepEqual((await t.fields(board)).pieces, []);
    const pieces = [{square: 4, piece: 6}, {square: 60, piece: 14}];
    await t.set(board, {pieces});
    assert.deepEqual((await t.fields(board)).pieces, pieces);
    const sheet = await t.place('eden:signup_sheet');
    const notes = [{id: 1, kind: 'question'}, {id: 2, kind: 'note'}];
    await t.set(sheet, {notes});
    assert.deepEqual((await t.fields(sheet)).notes, notes);
    // a record the field cannot hold is not written, and the read is the tree's, not the case's copy
    await t.set(sheet, {notes: [{id: 3}]});
    assert.deepEqual((await t.fields(sheet)).notes, notes);
  } finally { await t.stop(); }
});
