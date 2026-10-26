import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { verify } from '../local-runtime/runtime.mjs';
import { IMAGE, NAME, SERIAL, docker, privateJson, safeDirectory, settings, inspectOwn, cleanup, device, relay, listen } from './core.mjs';

let c;
let created = false;
const clients = new Set();
const servers = [];
try {
  c = settings(await privateJson(process.argv[2]));
  await verify(c.release);
  await safeDirectory(c.state);
  const runtime = process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, NAME);
  if (!runtime || !path.isAbsolute(runtime)) throw new Error('runtime-directory-required');
  await safeDirectory(runtime);
  if (inspectOwn(c)) throw new Error('existing-container-refused');
  const socket = path.join(runtime, 'https.sock');
  // RuntimeDirectory is recreated by systemd for each complete service start.
  try { await lstat(socket); throw new Error('existing-socket-refused'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tlsRelay = relay({ host: '127.0.0.1', port: 18443 }, clients);
  await listen(tlsRelay, socket);
  await chmod(socket, 0o600);
  servers.push(tlsRelay);
  let network;
  try { network = JSON.parse(docker(['network', 'inspect', NAME]))[0]; }
  catch (e) { if (e.status !== 1 || !String(e.stderr).includes('not found')) throw new Error('network-inspection-failed'); }
  if (!network) {
    docker(['network', 'create', '--internal', '--label', `com.overlaykit.installation=${c.installationId}`, NAME]);
    network = JSON.parse(docker(['network', 'inspect', NAME]))[0];
  }
  if (!network.Internal || network.Labels?.['com.overlaykit.installation'] !== c.installationId || Object.keys(network.Containers || {}).length) throw new Error('foreign-or-nonempty-network-refused');
  let selected;
  const args = ['run', '-d', '--rm', '--name', NAME, '--network', NAME, '--label', `com.overlaykit.installation=${c.installationId}`, '--label', `com.overlaykit.release=${path.basename(c.release)}`, '--read-only', '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=label=disable', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--env', 'NODE_EXTRA_CA_CERTS=/overlaykit-release/ca/root.crt'];
  function mount(src, dst, readonly = true) { if (src.includes(',')) throw new Error('unsafe-mount-path'); args.push('--mount', `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`); }
  mount(c.release, '/overlaykit-release');
  mount(path.join(c.release, 'ops/companion-runtime/node22.sh'), '/app/node-runtimes/node22/bin/node');
  mount(runtime, '/bridge');
  mount(path.join(c.state, 'companion'), '/companion', false);
  mount(path.join(c.release, 'modules'), '/app/module-local-dev');
  if (c.attachDevice) {
    selected = await device();
    const ids = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
    for (const id of ids) { const v = JSON.parse(docker(['inspect', id]))[0]; if ((v.HostConfig.Devices || []).some(d => d.PathOnHost === selected.file)) throw new Error('device-already-mapped'); }
    const users = spawnSync('/usr/bin/fuser', [selected.file], { encoding: 'utf8', timeout: 5000 });
    if (users.status === 0 || users.stdout?.trim()) throw new Error('device-already-open');
    if (users.status !== 1 || users.stderr?.trim()) throw new Error('device-ownership-unknown');
  } else mount(path.join(c.state, 'empty-sys'), '/sys');
  if (selected) { args.push('--device', `${selected.file}:${selected.file}:rw`, '--group-add', '1002'); mount('/run/udev', '/run/udev'); }
  args.push('--entrypoint', '/app/node-runtimes/node22/bin/node', IMAGE, '/overlaykit-release/ops/companion-runtime/child.cjs');
  if (selected && JSON.stringify(await device()) !== JSON.stringify(selected)) throw new Error('device-changed');
  const id = docker(args).trim();
  created = true;
  let container;
  for (let attempt = 0; attempt < 200; attempt++) {
    container = inspectOwn(c);
    if (!container?.State.Running || container.Id !== id) throw new Error('container-startup-failed');
    const address = container.NetworkSettings.Networks[NAME]?.IPAddress;
    const ready = await new Promise(resolve => { const r = http.get({ host: address, port: 8000, path: '/', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); }); r.once('error', () => resolve(false)); r.once('timeout', () => r.destroy()); });
    if (ready) break;
    if (attempt === 199) throw new Error('admin-readiness-timeout');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (selected && JSON.stringify(await device()) !== JSON.stringify(selected)) throw new Error('device-changed-after-start');
  const address = container.NetworkSettings.Networks[NAME].IPAddress;
  for (const [port, targetPort] of [[c.adminPort, 8000], [c.satellitePort, 16622]]) {
    const forward = relay({ host: address, port: targetPort }, clients);
    await listen(forward, port, '127.0.0.1');
    servers.push(forward);
  }
  await writeFile(path.join(c.state, 'running.json'), JSON.stringify({ containerId: id, releaseId: path.basename(c.release), prepared: !c.attachDevice, device: selected || null, admin: `http://127.0.0.1:${c.adminPort}`, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ phase: 'running', prepared: !c.attachDevice, adminPort: c.adminPort, payloadLogging: false }));
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => { try { if (!inspectOwn(c)?.State.Running) { clearInterval(timer); reject(new Error('container-exited')); } } catch { clearInterval(timer); reject(new Error('container-monitor-failed')); } }, 2000);
    function stop() { clearInterval(timer); resolve(); }
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
} catch (error) {
  // Do not print Docker arguments/configuration or subprocess buffers.
  console.error(JSON.stringify({ phase: 'failed', reason: /^[a-z-]+$/.test(error.message) ? error.message : 'runtime-or-configuration-error' }));
  process.exitCode = 1;
} finally {
  for (const socket of clients) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  if (c && created) { try { cleanup(c); } catch { process.exitCode = 1; } }
}
