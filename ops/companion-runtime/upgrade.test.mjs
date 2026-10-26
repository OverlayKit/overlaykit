import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, stat, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory, sha256 } from '../local-runtime/runtime.mjs';
import { SERIAL, unitText } from './core.mjs';
import { upgrade } from './upgrade.mjs';

async function tmp() { return mkdtemp(path.join(os.tmpdir(), 'ok-upgrade-test-')); }
async function makeRelease(parent, label) {
  const draft = path.join(parent, 'draft-' + label);
  await mkdir(path.join(draft, 'ops/companion-runtime'), { recursive: true });
  await mkdir(path.join(draft, 'bin'));
  await writeFile(path.join(draft, 'ops/companion-runtime/run.mjs'), label);
  await writeFile(path.join(draft, 'bin/node24'), label, { mode: 0o755 });
  const files = await inventory(draft);
  const id = sha256(JSON.stringify(files));
  await writeFile(path.join(draft, 'release.json'), JSON.stringify({ schema: 1, id, files }));
  const final = path.join(parent, id);
  await rename(draft, final);
  return final;
}
async function setup() {
  const root = await tmp();
  const home = path.join(root, 'home');
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const share = path.join(home, '.local/share/overlaykit-companion-local');
  const config = path.join(home, '.config/overlaykit-companion-local');
  const releases = path.join(share, 'releases');
  await mkdir(releases, { recursive: true });
  await mkdir(config, { recursive: true, mode: 0o700 });
  await chmod(config, 0o700);
  const first = await makeRelease(releases, 'one');
  const state = path.join(home, '.local/state/overlaykit-companion-local');
  const installation = { schema: 1, installationId: 'a'.repeat(36), release: first, state, serial: SERIAL, attachDevice: true, adminPort: 38035, satellitePort: 36623 };
  const configFile = path.join(config, 'installation.json');
  await writeFile(configFile, JSON.stringify(installation, null, 2) + '\n', { mode: 0o600 });
  const unit = path.join(home, '.config/systemd/user/overlaykit-companion-local.service');
  await mkdir(path.dirname(unit), { recursive: true });
  const unitBefore = unitText({ node: path.join(first, 'bin/node24'), ops: path.join(first, 'ops/companion-runtime'), state, configFile });
  await writeFile(unit, unitBefore, { mode: 0o600 });
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); if (args.includes('is-active')) return 'inactive\n'; return ''; };
  return { root, home, sources, releases, first, installation, configFile, unit, unitBefore, calls, run, state };
}
const mode = async file => (await stat(file)).mode & 0o777;

test('upgrade switches release, keeps everything else, and only reloads systemd', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    const result = await upgrade({ home: t.home, source: second, run: t.run });
    const target = path.join(t.releases, path.basename(second));
    assert.deepEqual(result, { previousRelease: t.first, release: target });
    const written = JSON.parse(await readFile(t.configFile, 'utf8'));
    assert.deepEqual(written, { ...t.installation, release: target });
    assert.equal(await readFile(t.unit, 'utf8'), unitText({ node: path.join(target, 'bin/node24'), ops: path.join(target, 'ops/companion-runtime'), state: t.state, configFile: t.configFile }));
    assert.equal(await mode(t.configFile), 0o600);
    assert.equal(await mode(t.unit), 0o600);
    assert.equal(await readFile(path.join(target, 'bin/node24'), 'utf8'), 'two');
    const verbs = t.calls.map(c => c.slice(0, 3).join(' '));
    assert.ok(verbs.some(v => v.startsWith('systemd-analyze --user verify')));
    assert.ok(verbs.includes('systemctl --user daemon-reload'));
    assert.ok(!t.calls.some(c => ['start', 'stop', 'restart', 'enable', 'disable'].some(x => c.includes(x))));
    assert.deepEqual((await readdir(path.dirname(t.configFile))).sort(), ['installation.json']);
    assert.deepEqual((await readdir(t.releases)).length, 2);
    // rollback restores the original configuration and unit exactly
    const back = await upgrade({ home: t.home, source: t.first, run: t.run });
    assert.equal(back.release, t.first);
    assert.deepEqual(JSON.parse(await readFile(t.configFile, 'utf8')), t.installation);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('upgrade refuses an unverified release without touching anything', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    await writeFile(path.join(second, 'ops/companion-runtime/run.mjs'), 'tampered');
    const before = await readFile(t.configFile, 'utf8');
    await assert.rejects(upgrade({ home: t.home, source: second, run: t.run }), /integrity|manifest/);
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    assert.deepEqual(await readdir(t.releases), [path.basename(t.first)]);
    assert.equal(t.calls.length, 0);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('upgrade refuses the current release without touching anything', async () => {
  const t = await setup();
  try {
    const before = await readFile(t.configFile, 'utf8');
    await assert.rejects(upgrade({ home: t.home, source: t.first, run: t.run }), /same-release-refused/);
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    assert.equal(t.calls.length, 0);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('upgrade refuses a public configuration file', async () => {
  const t = await setup();
  try {
    await chmod(t.configFile, 0o644);
    const second = await makeRelease(t.sources, 'two');
    await assert.rejects(upgrade({ home: t.home, source: second, run: t.run }), /unsafe-private-file/);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    assert.deepEqual(await readdir(t.releases), [path.basename(t.first)]);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('an existing release directory is verified and never overwritten', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    const existing = path.join(t.releases, path.basename(second));
    await mkdir(existing);
    await writeFile(path.join(existing, 'marker'), 'keep');
    const before = await readFile(t.configFile, 'utf8');
    await assert.rejects(upgrade({ home: t.home, source: second, run: t.run }), /manifest|integrity|ENOENT/);
    assert.equal(await readFile(path.join(existing, 'marker'), 'utf8'), 'keep');
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    // a genuine pre-existing copy is accepted as is
    await rm(existing, { recursive: true });
    await makeRelease(t.releases, 'two');
    const result = await upgrade({ home: t.home, source: second, run: t.run });
    assert.equal(result.release, existing);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('a failing systemd verification leaves installation and unit untouched', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    const before = await readFile(t.configFile, 'utf8');
    const run = () => { throw new Error('unit invalid'); };
    await assert.rejects(upgrade({ home: t.home, source: second, run }), /unit invalid/);
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    assert.deepEqual(await readdir(path.dirname(t.unit)), ['overlaykit-companion-local.service']);
    assert.deepEqual(await readdir(path.dirname(t.configFile)), ['installation.json']);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('an active service is refused before anything is modified', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    const before = await readFile(t.configFile, 'utf8');
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return args.includes('is-active') ? 'active\n' : ''; };
    await assert.rejects(upgrade({ home: t.home, source: second, run }), /service-active-refused/);
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await readFile(t.unit, 'utf8'), t.unitBefore);
    assert.equal((await readdir(t.releases)).length, 1);
    assert.deepEqual(await readdir(path.dirname(t.unit)), ['overlaykit-companion-local.service']);
    assert.ok(!calls.some(c => c.includes('daemon-reload') || c[0] === 'systemd-analyze'));
  } finally { await rm(t.root, { recursive: true, force: true }); }
});

test('a failing unit rename restores installation.json atomically and rethrows the original error', async () => {
  const t = await setup();
  try {
    const second = await makeRelease(t.sources, 'two');
    // A non-empty directory at the unit path makes the final rename fail after installation.json was replaced.
    await rm(t.unit);
    await mkdir(t.unit);
    await writeFile(path.join(t.unit, 'blocker'), 'x');
    const before = await readFile(t.configFile, 'utf8');
    await assert.rejects(upgrade({ home: t.home, source: second, run: t.run }), e => { assert.match(e.code, /ENOTEMPTY|EISDIR|EEXIST/); return true; });
    assert.equal(await readFile(t.configFile, 'utf8'), before);
    assert.equal(await mode(t.configFile), 0o600);
    assert.deepEqual(await readdir(path.dirname(t.configFile)), ['installation.json']);
    assert.deepEqual(await readdir(path.dirname(t.unit)), ['overlaykit-companion-local.service']);
  } finally { await rm(t.root, { recursive: true, force: true }); }
});
