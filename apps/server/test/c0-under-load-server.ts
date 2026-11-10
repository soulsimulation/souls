// #1750 A4 fixture: a world-shaped HTTP server whose thread is kept busy (ticks of TICK_MS every 50 ms, and heavy acts that
// each hold the thread ACT_MS, all through the real admission middleware), with the C0 bookkeeping routes beside them.
// Prints its port. Used by load-c0-under-load.test.ts in a child process, so the load and the probe do not share a thread.
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {Hono} from 'hono';
import {Admission, admissionMiddleware} from '../src/load/admission.ts';

const TICK_MS = Number(process.env.TICK_MS ?? 12), ACT_MS = Number(process.env.ACT_MS ?? 15);
const hold = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* the thread is busy */ } };
const adm = new Admission(), app = new Hono();
app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
app.post('/v1/edge/act', async c => { await c.req.text(); hold(ACT_MS); return c.json({accepted: true}); });
app.get('/v1/edge/receipts/:id', c => c.json({receipt: {id: c.req.param('id'), phase: 'started'}}));
app.post('/v1/edge/inbox/:id/ack', async c => { await c.req.text(); return c.json({ok: true}); });
app.post('/v1/edge/inbox/:id/result', async c => { await c.req.text(); return c.json({ok: true}); });
app.get('/v1/edge/inbox/listen', async c => { await new Promise(r => setTimeout(r, Number(c.req.query('timeoutMs')))); return c.json({messages: []}); });
setInterval(() => hold(TICK_MS), 50);
const server = createServer(getRequestListener(app.fetch));
server.keepAliveTimeout = 60_000;
server.listen(0, '127.0.0.1', () => console.log(`port ${(server.address() as {port: number}).port}`));
