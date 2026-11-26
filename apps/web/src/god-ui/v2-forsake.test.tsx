// #5006 rows 16 and 38: Forsake world on a world the new engine runs asks the world's directory, signed in, to hand the
// world on (a one-use link the recipient accepts) or archive it; nothing on the page deletes a world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(globalThis, { location: { origin: 'https://soul.example', pathname: '/w/hamlet/', search: '', hash: '', href: 'https://soul.example/w/hamlet/' } });
const F = await import('./v2-forsake.ts');
const { V2ForsakeWorld } = await import('./WorldOwnerOps.tsx');
const { OfferCard } = await import('./OfferCard.tsx');

const DIRECTORY = 'https://soul.example';
const page = { directory: DIRECTORY, session: { page: true as const } };
const here = { place: page, world: 'hamlet' };
const CODE = 'A'.repeat(31) + '_';
type Sent = { url: string; init: RequestInit };
const answering = (status: number, body: unknown, sent: Sent[] = []) => ({
  sent,
  post: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch,
});
const token = (t: string | null) => async () => t;

test('the directory is asked as its world routes sign in: a provider token, or a local test person', async () => {
  assert.equal(await F.worldsBearer(page, token('eyJ.provider')), 'eyJ.provider');
  assert.equal(await F.worldsBearer(page, token('dev:bea')), 'test:bea');
  assert.equal(await F.worldsBearer({ session: { testName: 'Ada' } }, token(null)), 'test:Ada');
  assert.equal(await F.worldsBearer(page, token(null)), null);
  await assert.rejects(F.offerHandoff(page, 'hamlet', { token: token(null), post: answering(200, {}).post }), /Sign in first/);
});

test('hand on: the creator gets a one-use link to the world page, with the code in the fragment only', async () => {
  const a = answering(200, { code: CODE, expires: 1_800_000_000, world: 'hamlet' });
  const offer = await F.offerHandoff(page, 'hamlet', { token: token('dev:ada'), post: a.post });
  assert.deepEqual(offer, { code: CODE, expires: 1_800_000_000 });
  assert.equal(a.sent[0].url, `${DIRECTORY}/v1/worlds/handoff/offer`);
  assert.deepEqual(JSON.parse(String(a.sent[0].init.body)), { world: 'hamlet' });
  assert.equal((a.sent[0].init.headers as Record<string, string>).authorization, 'Bearer test:ada');
  assert.equal(a.sent[0].init.credentials, 'omit');
  const link = F.offerLink('http://127.0.0.1:4710/w/hamlet/?as=Ada#watch', CODE);
  assert.equal(link, `http://127.0.0.1:4710/w/hamlet/#worldoffer/${CODE}`, 'the page\'s query (a local as=) is not passed on');
  const c = answering(200, { cancelled: true });
  await F.cancelHandoff(page, 'hamlet', { token: token('x'), post: c.post });
  assert.equal(c.sent[0].url, `${DIRECTORY}/v1/worlds/handoff/cancel`);
});

test('accept: the signed-in recipient sends the world and the code; a refusal is named in plain words', async () => {
  const a = answering(200, { accepted: true, world: 'hamlet' });
  await F.acceptHandoff(page, 'hamlet', CODE, { token: token('dev:bea'), post: a.post });
  assert.equal(a.sent[0].url, `${DIRECTORY}/v1/worlds/handoff/accept`);
  assert.deepEqual(JSON.parse(String(a.sent[0].init.body)), { world: 'hamlet', code: CODE });
  for (const [status, name, words] of [[409, 'handoff-used', /already been used/], [409, 'handoff-expired', /expired/], [403, 'handoff-not-for-you', /another account/],
    [503, 'world-authority-required', /cannot hand worlds on/], [409, 'world-unplaced', /not placed on this server/], [409, 'something-new', /Refused \(something-new\)/]] as const) {
    const err = await F.acceptHandoff(page, 'hamlet', CODE, { token: token('x'), post: answering(status, { refused: name }).post }).catch((e) => e);
    assert.ok(err instanceof F.Refused, name);
    assert.equal(err.refused, name);
    assert.match(err.message, words);
  }
});

test('archive: the exact name or no request at all; pending, then archived, by asking the same again', async () => {
  const none = answering(200, { archived: true });
  await assert.rejects(F.archiveWorld(page, 'hamlet', 'Hamlet', { token: token('x'), post: none.post }), /exact name/);
  assert.equal(none.sent.length, 0, 'a wrong name never reaches the directory');
  const p = answering(202, { pending: true, world: 'hamlet' });
  assert.equal(await F.archiveWorld(page, 'hamlet', 'hamlet', { token: token('x'), post: p.post }), 'pending');
  assert.equal(p.sent[0].url, `${DIRECTORY}/v1/worlds/archive`);
  assert.deepEqual(JSON.parse(String(p.sent[0].init.body)), { world: 'hamlet', confirm: 'hamlet' });
  assert.equal(await F.archiveWorld(page, 'hamlet', 'hamlet', { token: token('x'), post: answering(200, { archived: true }).post }), 'archived');
  const err = await F.archiveWorld(page, 'hamlet', 'hamlet', { token: token('x'), post: answering(409, { refused: 'archive-handoff-pending' }).post }).catch((e) => e);
  assert.match(err.message, /Cancel the open handoff link first/);
  // other people's Souls living here hold it: the count, and the two ways out
  const three = await F.archiveWorld(page, 'hamlet', 'hamlet', { token: token('x'), post: answering(409, { refused: 'archive-others-live-here', souls: 3 }).post }).catch((e) => e);
  assert.equal(three.refused, 'archive-others-live-here');
  assert.equal(three.message, '3 Souls of other people live here, and archiving would stop them with the world. Hand the world on instead, or wait until they have left.');
  assert.match(F.refusalText('archive-others-live-here', { souls: 1 }), /^A Soul of someone else's lives here, .* stop it .* until it has left\.$/);
  assert.match(F.refusalText('archive-others-live-here'), /^Souls of other people live here/);
});

test('God Mode\'s Forsake on a new-engine world: hand on and archive, no co-builders, no delete', () => {
  const html = renderToStaticMarkup(<V2ForsakeWorld name="Hello Hamlet" here={here} />);
  assert.match(html, /data-owner-ops="v2"/);
  assert.match(html, /data-ops="transfer"/);
  assert.match(html, /data-ops-transfer="1"/);
  assert.match(html, /data-ops-cancel="1"/);
  assert.match(html, /data-ops="archive"/);
  assert.match(html, /Type <code>hamlet<\/code> to confirm/);
  assert.match(html, /Nothing is deleted/);
  assert.match(html, /While other people&#x27;s Souls live here it cannot be archived: hand it on instead, or wait until they have left\./);
  assert.doesNotMatch(html, /data-ops="cobuilders"/);
  assert.doesNotMatch(html, /\bDelete\b/i);
  const lost = renderToStaticMarkup(<V2ForsakeWorld name="Hello Hamlet" here={null} />);
  assert.match(lost, /cannot be handed on or archived from here/);
});

test('the recipient\'s card on a new-engine world offers the world by the page\'s name and asks no launcher', () => {
  const html = renderToStaticMarkup(<OfferCard link={{ kind: 'worldoffer', code: CODE }} signedIn onDone={() => {}} here={here} />);
  assert.match(html, /data-offer-kind="transfer"/);
  assert.match(html, /You are offered /);
  assert.match(html, /become its creator/);
  assert.match(html, /data-offer-accept="1"/);
  const out = renderToStaticMarkup(<OfferCard link={{ kind: 'worldoffer', code: CODE }} signedIn={false} onDone={() => {}} here={here} />);
  assert.match(out, /Sign in first/);
  assert.doesNotMatch(out, /data-offer-accept/);
  const cobuild = renderToStaticMarkup(<OfferCard link={{ kind: 'cobuildpair', code: CODE }} signedIn onDone={() => {}} here={here} />);
  assert.match(cobuild, /Co-builders are turned off/);
  assert.doesNotMatch(cobuild, /data-offer-accept/);
});
