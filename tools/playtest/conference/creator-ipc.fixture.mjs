// Public local IPC unit fixture. Its owned process starts in the fixture socket directory.
import { createServer } from 'node:net';
const server = createServer(socket => {
  // A caller denied before writing must not hold the fixture socket open indefinitely.
  socket.setTimeout(1000, () => socket.destroy());
  let text = '';
  socket.on('data', bytes => {
    text += bytes;
    if (!text.includes('\n')) return;
    console.log(JSON.stringify({ request: JSON.parse(text.split('\n')[0]) }));
    socket.end(JSON.stringify({ ok: true, nodes: [{ id: 'ground', kind: 'eden:ground', parent: null }], kinds: {} }) + '\n');
  });
});
server.listen('daemon.sock', () => console.log(JSON.stringify({ ready: true })));
