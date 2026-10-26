import { execFileSync } from 'node:child_process';
import { cp, mkdir, lstat, realpath, rename, rm, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { verify } from '../local-runtime/runtime.mjs';
import { NAME, privateJson, safeDirectory, settings, unitText, upgradedInstallation } from './core.mjs';

const defaultRun = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

// Switches the installation to another verified release. Never stops, starts or enables the service.
// Everything is validated and staged before the two renames that change the live files.
export async function upgrade({ home = os.homedir(), source, run = defaultRun, warn = message => console.error(message) }) {
  const share = path.join(home, '.local/share/overlaykit-companion-local');
  const config = path.join(home, '.config/overlaykit-companion-local');
  const configFile = path.join(config, 'installation.json');
  const unitDirectory = path.join(home, '.config/systemd/user');
  const unit = path.join(unitDirectory, NAME + '.service');
  const releases = path.join(share, 'releases');

  const sourceDirectory = await realpath(source);
  const receipt = await verify(sourceDirectory);
  await safeDirectory(config);
  const currentText = await readFile(configFile, 'utf8');
  const current = settings(await privateJson(configFile));
  const release = path.join(releases, receipt.id);
  const next = upgradedInstallation(current, release);

  await mkdir(unitDirectory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(unitDirectory, '.upgrade-'));
  const stagedConfig = path.join(config, `.installation.json.${randomUUID()}.tmp`);
  let installed = false;
  try {
    if (await exists(release)) await verify(release);
    else {
      await mkdir(releases, { recursive: true, mode: 0o700 });
      const copy = path.join(releases, `.${receipt.id}.${randomUUID()}.tmp`);
      try {
        await cp(sourceDirectory, copy, { recursive: true, errorOnExist: true, force: false });
        await verify(copy, receipt.id);
        await rename(copy, release);
      } catch (e) { await rm(copy, { recursive: true, force: true }); throw e; }
    }
    const text = unitText({ node: path.join(release, 'bin/node24'), ops: path.join(release, 'ops/companion-runtime'), state: next.state, configFile });
    const stagedUnit = path.join(staging, NAME + '.service');
    await writeFile(stagedUnit, text, { flag: 'wx', mode: 0o600 });
    await writeFile(stagedConfig, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    run('systemd-analyze', ['--user', 'verify', stagedUnit]);
    await rename(stagedConfig, configFile);
    installed = true;
    await rename(stagedUnit, unit);
  } catch (e) {
    if (installed) {
      const restore = path.join(config, `.installation.json.${randomUUID()}.restore`);
      try { await writeFile(restore, currentText, { flag: 'wx', mode: 0o600 }); await rename(restore, configFile); }
      catch (restoreError) { await rm(restore, { force: true }); console.error(`restore of installation.json failed: ${restoreError.message}`); }
    }
    throw e;
  } finally {
    await rm(stagedConfig, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
  run('systemctl', ['--user', 'daemon-reload']);
  let active = false;
  try { active = run('systemctl', ['--user', 'is-active', NAME]).trim() === 'active'; } catch { /* inactive */ }
  if (active) warn(`${NAME} is still running the previous release; restart it to apply the change.`);
  return { previousRelease: current.release, release };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('upgrade failed: usage: upgrade.mjs <release-dir>'); process.exit(1); }
  try { console.log(JSON.stringify(await upgrade({ source: process.argv[2] }))); }
  catch (e) { console.error(`upgrade failed: ${e.message}`); process.exitCode = 1; }
}
