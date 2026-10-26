import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { bridge } = createRequire(import.meta.url)('./bridge.cjs');
const listening = server => new Promise((resolve, reject) => { if (server.listening) return resolve(); server.once('listening', resolve); server.once('error', reject); });
const closed = server => new Promise(resolve => server.close(resolve));
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ok-bridge-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const connect = port => new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
test('bridge pipes bytes both ways to the unix socket', () => fixture(async directory => {
  const socketPath = path.join(directory, 'echo.sock');
  const echo = net.createServer(s => s.pipe(s));
  await new Promise(resolve => echo.listen(socketPath, resolve));
  const server = bridge({ port: 0, socketPath }, new Set());
  await listening(server);
  const client = await connect(server.address().port);
  const reply = new Promise(resolve => client.once('data', resolve));
  client.write('ping');
  assert.equal((await reply).toString(), 'ping');
  client.destroy(); await closed(server); await closed(echo);
}));
test('bridge closes the client when the socket target is absent', () => fixture(async directory => {
  const server = bridge({ port: 0, socketPath: path.join(directory, 'absent.sock') }, new Set());
  await listening(server);
  const port = server.address().port;
  for (let i = 0; i < 2; i++) {
    const client = await connect(port);
    const started = Date.now();
    await new Promise(resolve => client.once('close', resolve));
    assert.ok(Date.now() - started < 5000);
  }
  assert.equal(server.listening, true);
  await closed(server);
}));
test('bridge refuses clients beyond 64', () => fixture(async directory => {
  const clients = new Set(Array.from({ length: 64 }, () => ({})));
  const server = bridge({ port: 0, socketPath: path.join(directory, 'absent.sock') }, clients);
  await listening(server);
  const client = await connect(server.address().port);
  await new Promise(resolve => client.once('close', resolve));
  assert.equal(clients.size, 64);
  await closed(server);
}));
