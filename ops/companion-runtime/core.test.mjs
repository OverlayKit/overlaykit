import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { settings, owned, IMAGE, NAME, SERIAL, privateJson } from './core.mjs';
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
