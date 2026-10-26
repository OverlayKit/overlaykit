import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inventory, proxyConfiguration, origins, sha256, proxyImage } from './runtime.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Stage with Node24');
const destination = path.resolve(process.argv[2] || path.join(source, 'artifacts/local-production-2026-10-23/releases'));
await mkdir(destination, { recursive: true });
const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(destination, '.stage-')));
function run(command, args, env = {}) {
  execFileSync(command, args, { cwd: source, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
}
try {
  await mkdir(path.join(temporary, 'bin'));
  await cp(await realpath(process.execPath), path.join(temporary, 'bin/node'));
  await cp(path.resolve(await realpath(process.execPath), '../../LICENSE'), path.join(temporary, 'bin/LICENSE'));
  const container = execFileSync('docker', ['create', '--network', 'none', proxyImage], { encoding: 'utf8' }).trim();
  try {
    run('docker', ['cp', `${container}:/usr/bin/caddy`, path.join(temporary, 'bin/caddy')]);
  } finally { run('docker', ['rm', container]); }
  // Copying file contents drops the image's file capabilities. No extra privilege
  // is needed for the exclusively high-port loopback listeners.
  const caddy = await readFile(path.join(temporary, 'bin/caddy'));
  await rm(path.join(temporary, 'bin/caddy'));
  await writeFile(path.join(temporary, 'bin/caddy'), caddy, { mode: 0o755 });
  const caddyVersion = execFileSync(path.join(temporary, 'bin/caddy'), ['version'], { encoding: 'utf8' }).trim();
  if (!caddyVersion.startsWith('v2.11.7 ')) throw new Error('Unexpected pinned Caddy version');
  for (const name of ['LICENSE', 'NOTICE', 'package-lock.json']) await cp(path.join(source, name), path.join(temporary, name));
  await cp(path.join(source, 'ops/local-runtime'), path.join(temporary, 'ops'), { recursive: true });
  for (const name of ['dist', 'public', 'package.json']) await cp(path.join(source, 'server', name), path.join(temporary, 'server', name), { recursive: true });
  const dependencies = execFileSync('npm', ['ls', '--omit=dev', '--all', '--workspace', '@overlaykit/server', '--parseable'], { cwd: source, encoding: 'utf8' }).trim().split('\n');
  for (const dependency of dependencies) {
    const relative = path.relative(source, dependency);
    if (!relative || relative === 'node_modules/@overlaykit/server') continue;
    if (!relative.startsWith('node_modules/') || relative.includes('../')) throw new Error('Unexpected runtime dependency path');
    const target = path.join(temporary, relative);
    if (relative === 'node_modules/@overlaykit/protocol') {
      const packDirectory = path.join(temporary, '.pack');
      await mkdir(packDirectory);
      run('npm', ['pack', '--workspace', '@overlaykit/protocol', '--ignore-scripts', '--pack-destination', packDirectory]);
      const packed = (await import('node:fs/promises')).readdir(packDirectory);
      const names = await packed;
      if (names.length !== 1) throw new Error('Unexpected protocol package');
      await mkdir(target, { recursive: true });
      run('tar', ['-xzf', path.join(packDirectory, names[0]), '--strip-components=1', '-C', target]);
      await rm(packDirectory, { recursive: true });
    } else {
      const actual = await realpath(dependency);
      if (actual !== dependency) throw new Error(`Unexpected runtime symlink: ${relative}`);
      await cp(dependency, target, { recursive: true, filter: entry => entry === dependency || !path.relative(dependency, entry).split(path.sep).includes('node_modules') });
    }
  }
  const environment = { VITE_API_URL: origins[0], VITE_STUDIO_URL: origins[0], VITE_EDITOR_URL: origins[1], VITE_OVERLAY_URL: origins[2], VITE_WS_URL: `wss://localhost:18443/ws`, NODE_ENV: 'production' };
  for (const [directory, workspace] of [['studio', 'studio'], ['editor', 'editor'], ['output', 'client'], ['panel', 'panel'], ['obs', 'client']]) {
    const env = { ...environment };
    if (directory === 'output' || directory === 'obs') env.VITE_WS_URL = '';
    if (directory === 'obs') env.VITE_API_URL = 'http://127.0.0.1:18447';
    run('npm', ['run', 'build', '--workspace', workspace], env);
    await cp(path.join(source, workspace, 'dist'), path.join(temporary, 'web', directory), { recursive: true, filter: entry => !entry.endsWith('.map') });
  }
  // Preserve third-party notices for browser bundles as well as server dependencies.
  async function legal(directory) {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await legal(file);
      else if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name) || entry.name === 'package.json') {
        const target = path.join(temporary, 'third-party', path.relative(path.join(source, 'node_modules'), file));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(file, target);
      }
    }
  }
  await legal(path.join(source, 'node_modules'));
  await writeFile(path.join(temporary, 'Caddyfile'), proxyConfiguration());
  await writeFile(path.join(temporary, 'provenance.json'), JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), sourceDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD'], { cwd: source })), node: process.version, platform: `${os.platform()}-${os.arch()}`, proxyImage, caddyVersion, environment, dependencyLockSha256: sha256(await readFile(path.join(source, 'package-lock.json'))) }, null, 2) + '\n');
  const files = await inventory(temporary);
  const id = sha256(JSON.stringify(files));
  await writeFile(path.join(temporary, 'release.json'), JSON.stringify({ schema: 1, id, files }, null, 2) + '\n');
  const release = path.join(destination, id);
  await rename(temporary, release);
  console.log(release);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
