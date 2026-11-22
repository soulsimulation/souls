// #4159: a world's public stream and history may come from its one CDN hostname, and from no other host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STREAM_ORIGIN, worldAddress } from './address.ts';
import { historyLocation } from '../history/page.ts';
import { writeMoment } from '../history/link.ts';

const lineage = 'ab'.repeat(16), zone = `${'cd'.repeat(16)}-0`;
const moment = { world: `${lineage}-${zone}`, lineage, at: 90_000_000, camera: null };
const path = `${lineage}/${zone}/7/${zone}/1/everyone/`;
const href = `https://soul.game/w/garden/${writeMoment(moment)}`;
const bootstrap = (extra: object) => ({ world: 'garden', stream: `/s/w/${moment.world}/views/${path}`, history: `/s/w/${moment.world}/history/`, directory: '/', gateway: '/w/garden/v2/ws', creatorToken: '/w/garden/v2/creator-token', ...extra });
const read = (body: object) => worldAddress(href, (async () => new Response(JSON.stringify(body))) as typeof fetch);

test('#4159: a bootstrap naming the stream host reads stream and history there; the socket and token stay on the page host', async () => {
  assert.equal(STREAM_ORIGIN, 'https://stream.eden.art');
  const a = await read(bootstrap({ streamOrigin: STREAM_ORIGIN }));
  assert.equal(a?.stream, `https://stream.eden.art/s/w/${moment.world}/views/${path}`);
  assert.equal(a?.history, `https://stream.eden.art/s/w/${moment.world}/history/`);
  assert.deepEqual([a?.directory, a?.gateway, a?.creatorToken], ['https://soul.game', 'wss://soul.game/w/garden/v2/ws', 'https://soul.game/w/garden/v2/creator-token']);
  assert.equal(historyLocation(moment, href, a!).href, a?.history, 'the history on the stream host is accepted');
  const same = await read(bootstrap({}));
  assert.equal(same?.stream, `https://soul.game/s/w/${moment.world}/views/${path}`, 'without it, the page host as before');
});

test('#4159: any other stream host is refused, and history on a foreign host is refused', async () => {
  for (const streamOrigin of ['https://evil.example', 'http://stream.eden.art', 'https://stream.eden.art/', 'https://stream.eden.art:444', 'https://x.stream.eden.art', '', null]) {
    await assert.rejects(read(bootstrap({ streamOrigin })), /world routing is invalid/, String(streamOrigin));
  }
  await assert.rejects(read(bootstrap({ streamOrigin: STREAM_ORIGIN, stream: 'https://evil.example/s/x/' })), /world routing is invalid/);
  const foreign = { stream: `https://evil.example/s/w/${moment.world}/views/${path}`, history: `https://evil.example/s/w/${moment.world}/history/` };
  assert.throws(() => historyLocation(moment, href, foreign), /history-live-foreign/);
});
