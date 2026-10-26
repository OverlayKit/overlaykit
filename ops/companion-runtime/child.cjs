const { bridge } = require('./bridge.cjs');
const { spawn } = require('node:child_process');
const clients = new Set();
let child;
function finish(code) {
  process.exitCode = code;
  for (const socket of clients) socket.destroy();
  for (const server of servers) server.close();
}
const servers = [
  bridge({ port: 18443, socketPath: '/bridge/https.sock' }, clients),
  bridge({ port: 4455, socketPath: '/bridge/obs.sock' }, clients)
];
let listening = 0;
for (const server of servers) {
  server.once('error', () => { child?.kill('SIGTERM'); finish(1); });
  server.once('listening', () => {
    if (++listening !== servers.length) return;
    child = spawn('/app/node-runtimes/main/bin/node', ['/app/main.js', '--admin-address', '0.0.0.0', '--admin-port', '8000', '--config-dir', '/companion', '--extra-module-path', '/app/module-local-dev', '--no-notifications', '--log-level', 'warn'], { stdio: 'inherit' });
    child.once('error', () => finish(1));
    child.once('exit', (code, signal) => finish(code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1)));
  });
}
// Forward only explicit whole-service shutdown. USB recovery never signals workers.
process.on('SIGTERM', () => child ? child.kill('SIGTERM') : finish(0));
process.on('SIGINT', () => child ? child.kill('SIGINT') : finish(0));
