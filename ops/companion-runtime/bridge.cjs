'use strict';
const net = require('node:net');
// Opaque, bounded loopback listener piped to a Unix socket. No payload parsing or logging.
// Starts listening immediately; callers attach 'listening'/'error' handlers.
function bridge({ port, socketPath }, clients) {
  const server = net.createServer(client => {
    if (clients.size >= 64) return client.destroy();
    const upstream = net.connect(socketPath);
    clients.add(client); clients.add(upstream);
    const timeout = setTimeout(() => { client.destroy(); upstream.destroy(); }, 5000);
    upstream.once('connect', () => clearTimeout(timeout));
    const finish = () => { clearTimeout(timeout); client.destroy(); upstream.destroy(); clients.delete(client); clients.delete(upstream); };
    client.on('error', finish); upstream.on('error', finish);
    client.on('close', finish); upstream.on('close', finish);
    client.pipe(upstream).pipe(client);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
module.exports = { bridge };
