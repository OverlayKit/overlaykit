import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { origins, ports, proxyImage, systemdQuote as q, verify } from './runtime.mjs';

export async function absent(file) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite existing path: ${file}`);
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`Unsafe private directory: ${directory}`);
  if (await realpath(directory) !== directory) throw new Error(`Symlinked private path: ${directory}`);
}

export function units(release, state) {
  const node = path.join(release, 'bin/node');
  const pre = `ExecStartPre=${q(node)} ${q(path.join(release, 'ops/verify.mjs'))}\n`;
  const hardening = 'NoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nRestrictSUIDSGID=yes\nUMask=0077\nUnsetEnvironment=NODE_OPTIONS NODE_PATH AUTH_FILE DEVICE_CREDENTIAL_DB DEVICE_CREDENTIAL_FILE FEEDBACK_SEQUENCE_FILE\n';
  const server = `[Unit]\nDescription=OverlayKit local production server\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${state.replaceAll('%', '%%')}\n${pre}ExecStart=${q(node)} ${q(path.join(release, 'server/dist/index.js'))}\nEnvironment=NODE_ENV=production\nEnvironment=HOST=127.0.0.1 WS_HOST=127.0.0.1 REST_PORT=${ports.rest} WS_PORT=${ports.ws}\nEnvironment=COOKIE_SECURE=always TRUST_PROXY=1 LOG_LEVEL=info\nEnvironment=${q(`CORS_ORIGIN=${[...origins, 'http://127.0.0.1:18447'].join(',')}`)}\nEnvironment=${q(`DATA_DIR=${path.join(state, 'server')}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\n${hardening}ReadWritePaths=${q(state)}\n\n[Install]\nWantedBy=default.target\n`;
  const proxy = `[Unit]\nDescription=OverlayKit loopback HTTPS proxy\nWants=overlaykit-local-server.service\nAfter=overlaykit-local-server.service\n\n[Service]\nType=simple\n${pre}ExecStart=${q(path.join(release, 'bin/caddy'))} run --config ${q(path.join(release, 'Caddyfile'))} --adapter caddyfile\nEnvironment=${q(`OVERLAYKIT_RELEASE=${release}`)}\nEnvironment=${q(`XDG_DATA_HOME=${path.join(state, 'proxy-data')}`)}\nEnvironment=${q(`XDG_CONFIG_HOME=${path.join(state, 'proxy-config')}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\n${hardening}ReadWritePaths=${q(state)}\n\n[Install]\nWantedBy=default.target\n`;
  return { 'overlaykit-local-server.service': server, 'overlaykit-local-proxy.service': proxy };
}

async function portAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function install(candidate) {
  const source = await realpath(candidate);
  const receipt = await verify(source);
  const home = os.homedir();
  const share = path.join(home, '.local/share/overlaykit-local');
  const state = path.join(home, '.local/state/overlaykit-local');
  const config = path.join(home, '.config/overlaykit-local');
  const unitDirectory = path.join(home, '.config/systemd/user');
  const names = ['overlaykit-local-server.service', 'overlaykit-local-proxy.service'];
  for (const file of [share, state, config, ...names.map(name => path.join(unitDirectory, name))]) await absent(file);
  for (const port of Object.values(ports)) await portAvailable(port);
  for (const directory of [share, state, config]) await privateDirectory(directory);
  for (const name of ['server', 'proxy-data', 'proxy-config']) await privateDirectory(path.join(state, name));
  const release = path.join(share, 'releases', receipt.id);
  await cp(source, release, { recursive: true, errorOnExist: true, force: false });
  await verify(release);
  await mkdir(unitDirectory, { recursive: true });
  for (const [name, text] of Object.entries(units(release, state))) await writeFile(path.join(unitDirectory, name), text, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(config, 'installation.json'), JSON.stringify({ schema: 1, release, releaseId: receipt.id, state, proxyImage, studio: origins[0], installedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  execFileSync('systemd-analyze', ['--user', 'verify', ...names.map(name => path.join(unitDirectory, name))], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', ...names], { stdio: 'inherit' });
  console.log(JSON.stringify({ releaseId: receipt.id, studio: origins[0], state }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node ops/local-runtime/install.mjs ABSOLUTE_RELEASE');
  await install(process.argv[2]);
}
