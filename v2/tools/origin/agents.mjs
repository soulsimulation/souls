// The agents' relay (stage 2c, #4152): the agents' gateway paths of every world (`/w/<slug>/v2/ws`, `v2/creator-token`,
// `v2/entries`, canonical and `/preview/`), relayed to the world's own gatewayd by the same rules as the viewers'
// origin (world-routes.mjs: trusted placement metadata names the gateway, refusals by name), in a process of its own.
// The front door sends those paths here and every viewer path to the origin, so a viewer join wave that saturates or
// restarts the origin never drops an agent (docs/architecture/scaling.md: one concern, one process, one limit, one
// gauge). Any other path is a 404.
//
// The gauge: `stats` gives agent sockets open now, sockets asked for and HTTP requests since start. AGENTS_STATS
// names a file it is written to every 10 s (AGENTS_STATS_MS) with the process's processor seconds and resident memory.
// Usage: node agents.mjs [port] [host]. Prints `agents <port>`; on SIGTERM or SIGINT prints `stats {json}` and exits.
import { rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { worldRoutes } from './world-routes.mjs';

/** The relay over the placement file `worldRoutes` (default: SOULS_WORLD_ROUTES, else world-routes.mjs's path). */
export function createAgents(routes) {
  const worlds = worldRoutes(routes), stats = { open: 0, sockets: 0, requests: 0 };
  const server = createServer((req, res) => {
    stats.requests++;
    if (worlds.handle(req, res)) return;
    res.writeHead(404, { 'cache-control': 'no-store', 'content-length': 0 }).end();
  });
  server.on('upgrade', (req, socket, head) => {
    // A refused socket is ended at once; a relayed one stays open until either side closes it.
    stats.open++; stats.sockets++;
    socket.once('close', () => stats.open--);
    worlds.upgrade(req, socket, head);
  });
  server.keepAliveTimeout = 60_000;
  return { server, stats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port = '7330', host = '127.0.0.1'] = process.argv.slice(2);
  const { server, stats } = createAgents();
  const started = Date.now(), file = process.env.AGENTS_STATS, every = Number(process.env.AGENTS_STATS_MS || 10_000);
  const figures = () => {
    const cpu = process.cpuUsage();
    return { started, pid: process.pid, ...stats, cpu_s: (cpu.user + cpu.system) / 1e6, rss_bytes: process.memoryUsage.rss() };
  };
  server.listen(Number(port), host, () => console.log(`agents ${server.address().port}`));
  if (file) setInterval(() => writeFile(`${file}.tmp`, JSON.stringify(figures())).then(() => rename(`${file}.tmp`, file)).catch(() => {}), every).unref();
  const stop = () => { console.log(`stats ${JSON.stringify(figures())}`); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
