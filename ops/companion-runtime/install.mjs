import { execFileSync } from 'node:child_process';
import { cp, mkdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { verify, systemdQuote as q } from '../local-runtime/runtime.mjs';
import { safeDirectory, SERIAL } from './core.mjs';

async function absent(file) { try { await lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; } throw new Error('Existing installation refused'); }
const source = await realpath(process.argv[2]);
const receipt = await verify(source);
const home = os.homedir();
const share = path.join(home, '.local/share/overlaykit-companion-local');
const state = path.join(home, '.local/state/overlaykit-companion-local');
const config = path.join(home, '.config/overlaykit-companion-local');
const configFile = path.join(config, 'installation.json');
const unit = path.join(home, '.config/systemd/user/overlaykit-companion-local.service');
for (const file of [share, state, configFile, unit]) await absent(file);
await safeDirectory(config);
for (const directory of [share, state, path.join(state, 'companion'), path.join(state, 'empty-sys')]) await mkdir(directory, { recursive: true, mode: 0o700 });
const release = path.join(share, 'releases', receipt.id);
await cp(source, release, { recursive: true, errorOnExist: true, force: false });
await verify(release);
const installation = { schema: 1, installationId: randomUUID(), release, state, serial: SERIAL, attachDevice: false, adminPort: 38036, satellitePort: 36624 };
await writeFile(configFile, JSON.stringify(installation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const node = path.join(release, 'bin/node24');
const ops = path.join(release, 'ops/companion-runtime');
const text = `[Unit]\nDescription=OverlayKit local Companion controller\nWants=overlaykit-local-server.service overlaykit-local-proxy.service\nAfter=overlaykit-local-server.service overlaykit-local-proxy.service\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nRuntimeDirectory=overlaykit-companion-local\nRuntimeDirectoryMode=0700\nWorkingDirectory=${state.replaceAll('%', '%%')}\nEnvironment=XDG_RUNTIME_DIR=%t\nUnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS\nExecStartPre=${q(node)} ${q(path.join(ops, 'verify.mjs'))}\nExecStart=/usr/bin/flock --exclusive --nonblock --no-fork ${q(path.join(state, 'owner.lock'))} ${q(node)} ${q(path.join(ops, 'run.mjs'))} ${q(configFile)}\nExecStopPost=${q(node)} ${q(path.join(ops, 'cleanup.mjs'))} ${q(configFile)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=40\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=read-only\nUMask=0077\nReadWritePaths=${q(state)} %t/overlaykit-companion-local\n\n[Install]\nWantedBy=default.target\n`;
await writeFile(unit, text, { flag: 'wx', mode: 0o600 });
execFileSync('systemd-analyze', ['--user', 'verify', unit], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
// Deliberately not enabled until actual app readiness and controlled HID cutover.
execFileSync('systemctl', ['--user', 'start', 'overlaykit-companion-local'], { stdio: 'inherit' });
console.log(JSON.stringify({ prepared: true, releaseId: receipt.id, enabled: false, admin: 'http://127.0.0.1:38036' }));
