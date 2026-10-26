import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm, stat, lstat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { settings, owned, IMAGE, NAME, SERIAL, privateJson, unitText, upgradedInstallation, relay, listen, openSocketRelays } from './core.mjs';
const c = { schema: 1, installationId: 'a'.repeat(36), release: '/private/releases/' + 'a'.repeat(64), state: '/private/state', serial: SERIAL, attachDevice: false, adminPort: 38036, satellitePort: 36624 };
test('only explicit private-mode ports are accepted', () => {
  assert.equal(settings(c), c);
  assert.throws(() => settings({ ...c, adminPort: 8000 }));
  assert.throws(() => settings({ ...c, attachDevice: true }));
  assert.throws(() => settings({ ...c, serial: 'another device' }));
  assert.doesNotThrow(() => settings({ ...c, attachDevice: true, adminPort: 38035, satellitePort: 36623 }));
});
test('cleanup ownership requires exact container, image, installation and release', () => {
  const value = { Name: '/' + NAME, Config: { Image: IMAGE, Labels: { 'com.overlaykit.installation': c.installationId, 'com.overlaykit.release': path.basename(c.release) } } };
  assert.equal(owned(value, c), true);
  assert.equal(owned({ ...value, Name: '/unrelated' }, c), false);
  assert.equal(owned({ ...value, Config: { ...value.Config, Image: 'latest' } }, c), false);
  assert.equal(owned(value, { ...c, installationId: 'b'.repeat(36) }), false);
  assert.equal(owned(value, { ...c, release: '/different' }), false);
});
test('private configuration refuses public and symbolic files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ok-companion-test-'));
  try {
    const file = path.join(directory, 'config');
    await writeFile(file, JSON.stringify(c), { mode: 0o600 });
    assert.deepEqual(await privateJson(file), c);
    await chmod(file, 0o644);
    await assert.rejects(privateJson(file), /unsafe/);
    await chmod(file, 0o600);
    await symlink(file, path.join(directory, 'link'));
    await assert.rejects(privateJson(path.join(directory, 'link')), /unsafe/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Captured from install.mjs before unitText was extracted; must never drift.
const UNIT_FIXTURE = "[Unit]\nDescription=OverlayKit local Companion controller\nWants=overlaykit-local-server.service overlaykit-local-proxy.service\nAfter=overlaykit-local-server.service overlaykit-local-proxy.service\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nRuntimeDirectory=overlaykit-companion-local\nRuntimeDirectoryMode=0700\nWorkingDirectory=/home/u/.local/state/overlaykit-companion-local\nEnvironment=XDG_RUNTIME_DIR=%t\nUnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS\nExecStartPre=\"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/node24\" \"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ops/companion-runtime/verify.mjs\"\nExecStart=/usr/bin/flock --exclusive --nonblock --no-fork \"/home/u/.local/state/overlaykit-companion-local/owner.lock\" \"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/node24\" \"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ops/companion-runtime/run.mjs\" \"/home/u/.config/overlaykit-companion-local/installation.json\"\nExecStopPost=\"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/node24\" \"/home/u/.local/share/overlaykit-companion-local/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ops/companion-runtime/cleanup.mjs\" \"/home/u/.config/overlaykit-companion-local/installation.json\"\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=40\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nUMask=0077\nReadWritePaths=\"/home/u/.local/state/overlaykit-companion-local\" %t/overlaykit-companion-local\n\n[Install]\nWantedBy=default.target\n";
const unitInput = { node: '/home/u/.local/share/overlaykit-companion-local/releases/' + 'a'.repeat(64) + '/bin/node24', ops: '/home/u/.local/share/overlaykit-companion-local/releases/' + 'a'.repeat(64) + '/ops/companion-runtime', state: '/home/u/.local/state/overlaykit-companion-local', configFile: '/home/u/.config/overlaykit-companion-local/installation.json' };
test('unitText matches the installed unit format', () => {
  const text = unitText(unitInput);
  assert.ok(text.includes('ExecStart=/usr/bin/flock --exclusive --nonblock --no-fork'));
  assert.ok(text.includes('ReadWritePaths='));
  assert.ok(text.includes('WantedBy=default.target'));
  assert.equal(text, UNIT_FIXTURE);
});
const production = { ...c, attachDevice: true, adminPort: 38035, satellitePort: 36623 };
const other = '/private/releases/' + 'b'.repeat(64);
test('upgradedInstallation keeps identity, ports and state', () => {
  const next = upgradedInstallation(production, other);
  assert.deepEqual(next, { ...production, release: other });
  assert.equal(production.release, c.release);
});
test('upgradedInstallation refuses the same release and invalid releases', () => {
  assert.throws(() => upgradedInstallation(production, production.release), /same-release-refused/);
  assert.throws(() => upgradedInstallation(production, '/private/releases/not-a-sha'), /invalid-installation/);
  assert.throws(() => upgradedInstallation(production, 'relative/' + 'b'.repeat(64)), /invalid-installation/);
  assert.throws(() => upgradedInstallation({ ...production, adminPort: 1 }, other), /invalid-/);
});
test('upgrade then rollback restores the original installation', () => {
  assert.deepEqual(upgradedInstallation(upgradedInstallation(production, other), production.release), production);
});

async function closedPort() {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  return port;
}
const closeAll = servers => Promise.all(servers.map(s => new Promise(r => s.close(r))));
test('relay to a closed target closes the client quickly, keeps listening and drains clients', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ok-relay-closed-'));
  const clients = new Set();
  const server = relay({ host: '127.0.0.1', port: await closedPort() }, clients);
  try {
    const sock = path.join(dir, 'obs.sock');
    await listen(server, sock);
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const client = net.connect(sock);
      client.on('error', () => {});
      await new Promise(r => client.once('close', r));
      assert.ok(Date.now() - started < 5000);
      assert.equal(server.listening, true);
    }
    await new Promise(r => setTimeout(r, 50));
    assert.equal(clients.size, 0);
  } finally { await closeAll([server]); await rm(dir, { recursive: true, force: true }); }
});
test('openSocketRelays opens both sockets with mode 0600', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ok-sockets-'));
  const servers = [];
  try {
    await openSocketRelays(dir, new Set(), servers);
    assert.equal(servers.length, 2);
    for (const name of ['https.sock', 'obs.sock']) assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600);
  } finally { await closeAll(servers); await rm(dir, { recursive: true, force: true }); }
});
test('openSocketRelays refuses a pre-existing socket and closes the ones already opened', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ok-sockets-'));
  const servers = [];
  try {
    await writeFile(path.join(dir, 'obs.sock'), '');
    await assert.rejects(openSocketRelays(dir, new Set(), servers), /existing-socket-refused/);
    assert.equal(servers.length, 1);
    await closeAll(servers);
    assert.equal(servers[0].listening, false);
    await assert.rejects(lstat(path.join(dir, 'https.sock')), { code: 'ENOENT' });
  } finally { await closeAll([]); await rm(dir, { recursive: true, force: true }); }
});
test('openSocketRelays registers a server before chmod so a chmod failure leaves it closable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ok-sockets-'));
  const servers = [];
  try {
    await assert.rejects(openSocketRelays(dir, new Set(), servers, { chmod: async () => { throw new Error('chmod-failed'); } }), /chmod-failed/);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].listening, true);
    await closeAll(servers);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
