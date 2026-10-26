import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, chmod, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, sha256, verify } from '../local-runtime/runtime.mjs';
import { IMAGE, docker, privateJson } from './core.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installation = await privateJson(path.join(os.homedir(), '.config/overlaykit-local/installation.json'));
await verify(installation.release);
const destination = path.resolve(process.argv[2] || path.join(source, 'artifacts/local-companion-2026-10-24/releases'));
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(path.join(destination, '.stage-'));
const sibling = path.resolve(source, '../companion-module-overlaykit-server');
const archive = path.join(sibling, 'pkg/overlaykit-server-0.1.0.tgz');
const archiveHash = '3acfedb775a7d4a1ac1e3308de754ad3669df5c45b1f3b64539e3687a48935e7';
try {
  if (sha256(await readFile(archive)) !== archiveHash) throw new Error('Unreviewed module package');
  await mkdir(path.join(temporary, 'bin'));
  await cp(path.join(installation.release, 'bin/node'), path.join(temporary, 'bin/node24'));
  await cp(path.join(installation.release, 'bin/LICENSE'), path.join(temporary, 'bin/LICENSE-node24'));
  const container = docker(['create', '--network', 'none', IMAGE]).trim();
  try {
    docker(['cp', `${container}:/app/node-runtimes/node22/bin/node`, path.join(temporary, 'bin/node22')]);
    docker(['cp', `${container}:/app/node-runtimes/node22/LICENSE`, path.join(temporary, 'bin/LICENSE-node22')]);
  } finally { docker(['rm', container]); }
  const expectedNode22 = JSON.parse(await readFile(path.join(source, 'artifacts/local-production-2026-10-23/companion-deployment-preflight.json'))).files['companion-node22-runtime/node22'];
  if (sha256(await readFile(path.join(temporary, 'bin/node22'))) !== expectedNode22) throw new Error('Node22 binary changed');
  const moduleDirectory = path.join(temporary, 'modules/overlaykit-server');
  await mkdir(path.join(moduleDirectory, 'pkg'), { recursive: true });
  // Supported packaged-development layout used by Companion's ModuleScanner.
  // The verified distribution is unchanged; no fake SDK metadata is introduced.
  execFileSync('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', path.join(moduleDirectory, 'pkg')]);
  await writeFile(path.join(moduleDirectory, 'DEBUG-PACKAGED'), '');
  await mkdir(path.join(temporary, 'ca'));
  await cp(path.join(installation.state, 'proxy-data/caddy/pki/authorities/local/root.crt'), path.join(temporary, 'ca/root.crt'));
  await cp(path.join(source, 'ops/companion-runtime'), path.join(temporary, 'ops/companion-runtime'), { recursive: true });
  await mkdir(path.join(temporary, 'ops/local-runtime'));
  await cp(path.join(source, 'ops/local-runtime/runtime.mjs'), path.join(temporary, 'ops/local-runtime/runtime.mjs'));
  await chmod(path.join(temporary, 'ops/companion-runtime/node22.sh'), 0o755);
  for (const name of ['LICENSE', 'NOTICE']) await cp(path.join(source, name), path.join(temporary, name));
  await writeFile(path.join(temporary, 'provenance.json'), JSON.stringify({ image: IMAGE, moduleArchiveSha256: archiveHash, node22Sha256: expectedNode22, caSha256: sha256(await readFile(path.join(temporary, 'ca/root.crt'))), serverReleaseId: installation.releaseId, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), planHash: JSON.parse(await readFile(path.join(source, '.overlaykit/governance/plan.json'))).planHash }, null, 2) + '\n');
  const files = await inventory(temporary);
  const id = sha256(JSON.stringify(files));
  await writeFile(path.join(temporary, 'release.json'), JSON.stringify({ schema: 1, id, files }, null, 2) + '\n');
  const target = path.join(destination, id);
  await rename(temporary, target);
  await verify(target);
  console.log(target);
} catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
