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
const settle = async (clients, size) => { for (let i = 0; i < 100 && clients.size !== size; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(clients.size, size); };
test('bridge pipes bytes both ways to the unix socket', () => fixture(async directory => {
  const socketPath = path.join(directory, 'echo.sock');
  const echo = net.createServer(s => s.pipe(s));
  await new Promise(resolve => echo.listen(socketPath, resolve));
  const clients = new Set();
  const server = bridge({ port: 0, socketPath }, clients);
  await listening(server);
  const client = await connect(server.address().port);
  const reply = new Promise(resolve => client.once('data', resolve));
  client.write('ping');
  assert.equal((await reply).toString(), 'ping');
  client.destroy(); await settle(clients, 0); await closed(server); await closed(echo);
}));
test('bridge closes the client when the socket target is absent', () => fixture(async directory => {
  const clients = new Set();
  const server = bridge({ port: 0, socketPath: path.join(directory, 'absent.sock') }, clients);
  await listening(server);
  const port = server.address().port;
  for (let i = 0; i < 2; i++) {
    const client = await connect(port);
    const started = Date.now();
    await new Promise(resolve => client.once('close', resolve));
    assert.ok(Date.now() - started < 5000);
  }
  assert.equal(server.listening, true);
  await settle(clients, 0);
  await closed(server);
}));
test('bridge refuses clients beyond 64 and accepts below the cap', () => fixture(async directory => {
  const socketPath = path.join(directory, 'echo.sock');
  let accepted = 0;
  const echo = net.createServer(s => { accepted++; s.pipe(s); });
  await new Promise(resolve => echo.listen(socketPath, resolve));
  const full = new Set(Array.from({ length: 64 }, () => ({})));
  const refusing = bridge({ port: 0, socketPath }, full);
  await listening(refusing);
  const refused = await connect(refusing.address().port);
  assert.equal(await Promise.race([new Promise(resolve => refused.once('close', () => resolve('closed'))), new Promise(resolve => setTimeout(() => resolve('open'), 1000))]), 'closed');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(accepted, 0);
  assert.equal(full.size, 64);
  const below = new Set(Array.from({ length: 63 }, () => ({})));
  const accepting = bridge({ port: 0, socketPath }, below);
  await listening(accepting);
  const client = await connect(accepting.address().port);
  const reply = new Promise(resolve => client.once('data', resolve));
  client.write('ping');
  assert.equal((await reply).toString(), 'ping');
  assert.equal(accepted, 1);
  client.destroy(); await settle(below, 63);
  await closed(refusing); await closed(accepting); await closed(echo);
}));
