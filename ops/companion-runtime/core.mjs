import { execFileSync } from 'node:child_process';
import { chmod, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { systemdQuote as q } from '../local-runtime/runtime.mjs';
export const IMAGE = 'ghcr.io/bitfocus/companion/companion:v4.3.3@sha256:2ff41215ab2ed77b5ec3dd74c5e6ec3b01354f57a7ca301b16017444d395544e';
export const NAME = 'overlaykit-companion-local';
export const OBS_PORT = 4455;
export const SERIAL = 'A00SA5492OQMLF';
export function docker(args) { return execFileSync('/usr/bin/docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
export async function privateJson(file) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077) throw new Error('unsafe-private-file');
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function safeDirectory(directory) {
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || await realpath(directory) !== directory) throw new Error('unsafe-private-directory');
}
export function settings(c) {
  if (c?.schema !== 1 || !/^[a-f0-9-]{36}$/.test(c.installationId) || !/^[a-f0-9]{64}$/.test(path.basename(c.release || '')) || !path.isAbsolute(c.release || '') || !path.isAbsolute(c.state || '') || typeof c.attachDevice !== 'boolean' || c.serial !== SERIAL || ![38035, 38036].includes(c.adminPort) || ![36623, 36624].includes(c.satellitePort)) throw new Error('invalid-installation');
  if (c.attachDevice && (c.adminPort !== 38035 || c.satellitePort !== 36623)) throw new Error('invalid-production-ports');
  if (!c.attachDevice && (c.adminPort !== 38036 || c.satellitePort !== 36624)) throw new Error('invalid-preparation-ports');
  return c;
}
export function upgradedInstallation(current, release) {
  settings(current);
  const next = settings({ ...current, release });
  if (path.basename(release) === path.basename(current.release)) throw new Error('same-release-refused');
  return next;
}
export function unitText({ node, ops, state, configFile }) {
  return `[Unit]\nDescription=OverlayKit local Companion controller\nWants=overlaykit-local-server.service overlaykit-local-proxy.service\nAfter=overlaykit-local-server.service overlaykit-local-proxy.service\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nRuntimeDirectory=overlaykit-companion-local\nRuntimeDirectoryMode=0700\nWorkingDirectory=${state.replaceAll('%', '%%')}\nEnvironment=XDG_RUNTIME_DIR=%t\nUnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS\nExecStartPre=${q(node)} ${q(path.join(ops, 'verify.mjs'))}\nExecStart=/usr/bin/flock --exclusive --nonblock --no-fork ${q(path.join(state, 'owner.lock'))} ${q(node)} ${q(path.join(ops, 'run.mjs'))} ${q(configFile)}\nExecStopPost=${q(node)} ${q(path.join(ops, 'cleanup.mjs'))} ${q(configFile)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=40\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nUMask=0077\nReadWritePaths=${q(state)} %t/overlaykit-companion-local\n\n[Install]\nWantedBy=default.target\n`;
}
export function owned(container, c) {
  return container?.Name === '/' + NAME && container.Config?.Image === IMAGE && container.Config?.Labels?.['com.overlaykit.installation'] === c.installationId && container.Config?.Labels?.['com.overlaykit.release'] === path.basename(c.release);
}
export function inspectOwn(c) {
  let value;
  try { value = JSON.parse(docker(['container', 'inspect', NAME]))[0]; }
  catch (e) { if (e.status === 1 && /no such (object|container)/.test(String(e.stderr).toLowerCase())) return null; throw new Error('container-inspection-failed'); }
  if (!owned(value, c)) throw new Error('foreign-container-refused');
  return value;
}
export function cleanup(c) {
  const value = inspectOwn(c);
  if (!value) return;
  if (value.State.Running) docker(['stop', '--time', '20', value.Id]);
  // --rm normally removed it already; removal is restricted to the inspected ID.
  try { docker(['rm', value.Id]); } catch (e) { if (!String(e.stderr).toLowerCase().includes('no such container')) throw e; }
}
export async function device({ sys = '/sys/class/hidraw', dev = '/dev' } = {}) {
  const found = [];
  for (const name of await readdir(sys)) {
    if (!/^hidraw\d+$/.test(name)) continue;
    const properties = Object.fromEntries((await readFile(path.join(sys, name, 'device/uevent'), 'utf8')).trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (!/^0003:00000FD9:/i.test(properties.HID_ID || '')) continue;
    found.push({ name, serial: properties.HID_UNIQ, id: properties.HID_ID.toUpperCase() });
  }
  if (found.length !== 1 || found[0].serial !== SERIAL || found[0].id !== '0003:00000FD9:00000080') throw new Error('unique-approved-device-required');
  const file = path.join(dev, found[0].name);
  const s = await stat(file, { bigint: true });
  if (!s.isCharacterDevice()) throw new Error('character-device-required');
  return { file, serial: SERIAL, rdev: String(s.rdev), inode: String(s.ino) };
}
// Opaque, bounded pipes. No application parsing or payload/frame logging.
export function relay(target, clients = new Set(), maximum = 64) {
  return net.createServer(client => {
    if (clients.size >= maximum) return client.destroy();
    const upstream = net.connect(target);
    clients.add(client); clients.add(upstream);
    const timer = setTimeout(() => { client.destroy(); upstream.destroy(); }, 5000);
    upstream.once('connect', () => clearTimeout(timer));
    const finish = () => { clearTimeout(timer); client.destroy(); upstream.destroy(); clients.delete(client); clients.delete(upstream); };
    client.on('error', finish); upstream.on('error', finish);
    client.on('close', finish); upstream.on('close', finish);
    client.pipe(upstream).pipe(client);
  });
}
export function listen(server, ...args) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(...args, resolve); }); }
// Opens the opaque Unix-socket relays. Each server is pushed to `servers` right after listen resolves
// (before chmod) so the caller's finally can always close it, also when a later step throws.
export async function openSocketRelays(runtime, clients, servers, { chmod: change = chmod, specs = [['https.sock', 18443], ['obs.sock', OBS_PORT]] } = {}) {
  for (const [name, port] of specs) {
    const socket = path.join(runtime, name);
    try { await lstat(socket); throw new Error('existing-socket-refused'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const unixRelay = relay({ host: '127.0.0.1', port }, clients);
    await listen(unixRelay, socket);
    servers.push(unixRelay);
    await change(socket, 0o600);
  }
}
