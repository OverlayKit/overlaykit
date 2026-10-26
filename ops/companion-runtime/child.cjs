const net = require('node:net');
const { spawn } = require('node:child_process');
const clients = new Set();
let child;
const server = net.createServer(client => {
  if (clients.size >= 64) return client.destroy();
  const upstream = net.connect('/bridge/https.sock');
  clients.add(client); clients.add(upstream);
  const timeout = setTimeout(() => { client.destroy(); upstream.destroy(); }, 5000);
  upstream.once('connect', () => clearTimeout(timeout));
  const finish = () => { clearTimeout(timeout); client.destroy(); upstream.destroy(); clients.delete(client); clients.delete(upstream); };
  client.on('error', finish); upstream.on('error', finish);
  client.on('close', finish); upstream.on('close', finish);
  client.pipe(upstream).pipe(client);
});
function finish(code) {
  process.exitCode = code;
  for (const socket of clients) socket.destroy();
  server.close();
}
server.once('error', () => { child?.kill('SIGTERM'); finish(1); });
server.listen(18443, '127.0.0.1', () => {
  child = spawn('/app/node-runtimes/main/bin/node', ['/app/main.js', '--admin-address', '0.0.0.0', '--admin-port', '8000', '--config-dir', '/companion', '--extra-module-path', '/app/module-local-dev', '--no-notifications', '--log-level', 'warn'], { stdio: 'inherit' });
  child.once('error', () => finish(1));
  child.once('exit', (code, signal) => finish(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1)));
});
// Forward only explicit whole-service shutdown. USB recovery never signals workers.
process.on('SIGTERM', () => child ? child.kill('SIGTERM') : finish(0));
process.on('SIGINT', () => child ? child.kill('SIGINT') : finish(0));
