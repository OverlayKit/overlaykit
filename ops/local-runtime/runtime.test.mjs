import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory, sha256, verify, proxyConfiguration, systemdQuote } from './runtime.mjs';
import { absent, privateDirectory, units } from './install.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-release-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('manifest rejects tampering, extra files and symlinks', () => fixture(async root => {
  await writeFile(path.join(root, 'code'), 'original');
  const files = await inventory(root);
  const id = sha256(JSON.stringify(files));
  await writeFile(path.join(root, 'release.json'), JSON.stringify({ schema: 1, id, files }));
  await verify(root, id);
  await assert.rejects(verify(root, 'incorrect-identity'), /manifest/);
  await writeFile(path.join(root, 'code'), 'tampered');
  await assert.rejects(verify(root, id), /integrity/);
  await writeFile(path.join(root, 'code'), 'original');
  await writeFile(path.join(root, 'extra'), 'unexpected');
  await assert.rejects(verify(root, id), /integrity/);
  await symlink('/etc/passwd', path.join(root, 'link'));
  await assert.rejects(inventory(root), /symlink/);
}));
test('installation refuses existing data and unsafe ownership paths', () => fixture(async root => {
  await assert.rejects(absent(root), /overwrite/);
  await absent(path.join(root, 'new'));
  await mkdir(path.join(root, 'public'), { mode: 0o755 });
  await assert.rejects(privateDirectory(path.join(root, 'public')), /Unsafe/);
  await symlink(root, path.join(root, 'alias'));
  await assert.rejects(privateDirectory(path.join(root, 'alias')), /Unsafe/);
}));
test('systemd arguments preserve spaces and literal expansion characters', () => {
  assert.equal(systemdQuote('/a b/%x/$z'), '"/a b/%%x/$$z"');
  assert.throws(() => systemdQuote('bad\nargument'));
  const result = units('/home/a/release', '/home/a/state', '/usr/bin/docker');
  assert.match(result['overlaykit-local-server.service'], /COOKIE_SECURE=always/);
  assert.match(result['overlaykit-local-server.service'], /UnsetEnvironment=.*AUTH_FILE DEVICE_CREDENTIAL_DB/);
  assert.match(result['overlaykit-local-proxy.service'], /NoNewPrivileges=yes/);
  assert.doesNotMatch(result['overlaykit-local-proxy.service'], /docker|CAP_NET_BIND_SERVICE/);
  assert.doesNotMatch(result['overlaykit-local-server.service'], /8080/);
});
test('proxy is loopback-only, avoids credential logs and blocks API on Output', () => {
  const config = proxyConfiguration();
  assert.match(config, /default_bind 127\.0\.0\.1/);
  assert.match(config, /skip_install_trust/);
  assert.match(config, /admin off/);
  assert.doesNotMatch(config, /\blog\b|token=|output=/);
  const obs = config.slice(config.indexOf('http://127.0.0.1:18447'));
  assert.match(obs, /handle \/api\/\* \{\s+respond 404/);
  assert.doesNotMatch(obs, /handle \/device|handle \/health/);
});
