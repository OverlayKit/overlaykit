import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const protocolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tscPath = path.resolve(protocolRoot, '../node_modules/typescript/bin/tsc');
const PUBLIC_SUBPATHS = [
  '',
  '/element',
  '/scene',
  '/messages',
  '/production',
  '/control-action-catalog',
  '/control-feedback',
  '/control-feedback-authority',
  '/control-visibility-feedback',
  '/device-control-frame',
  '/device-bootstrap',
  '/device-state-sync',
  '/device-credential',
] as const;

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

let temporaryDirectory = '';
let consumerDirectory = '';
let packed: PackResult;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-protocol-package-'));
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--json', '--silent', '--pack-destination', temporaryDirectory],
    { cwd: protocolRoot }
  );
  [packed] = JSON.parse(stdout) as PackResult[];
  await writeFile(
    path.join(temporaryDirectory, 'package.json'),
    JSON.stringify({ private: true }),
    'utf8'
  );
  await execFileAsync(
    'npm',
    [
      'install',
      '--silent',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(temporaryDirectory, packed.filename),
    ],
    { cwd: temporaryDirectory }
  );
  consumerDirectory = temporaryDirectory;
}, 30_000);

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('published protocol package', () => {
  it('packs only compiled artifacts and resolves every declared target', async () => {
    const paths = packed.files.map((file) => file.path);
    expect(paths.some((file) => file.startsWith('src/'))).toBe(false);
    expect(paths.some((file) => file.startsWith('tests/'))).toBe(false);
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('NOTICE');
    expect(paths).toContain('README.md');

    const manifest = JSON.parse(
      await readFile(
        path.join(consumerDirectory, 'node_modules/@overlaykit/protocol/package.json'),
        'utf8'
      )
    ) as {
      bugs: { url: string };
      author: { name: string; url: string };
      engines: { node: string };
      files: string[];
      homepage: string;
      license: string;
      exports: Record<string, { types: string; import: string }>;
      publishConfig: { access: string };
      repository: { type: string; url: string; directory: string };
    };
    expect(manifest.files).toEqual(['dist', 'LICENSE', 'NOTICE']);
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.author).toEqual({
      name: 'Rodrigo Vicente',
      url: 'https://x.com/rodrigoteamx',
    });
    expect(manifest.engines.node).toBe('>=24');
    expect(manifest.publishConfig.access).toBe('public');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/OverlayKit/overlaykit.git',
      directory: 'protocol',
    });
    expect(manifest.homepage).toBe('https://github.com/OverlayKit/overlaykit#readme');
    expect(manifest.bugs.url).toBe('https://github.com/OverlayKit/overlaykit/issues');
    expect(JSON.stringify(manifest.exports)).not.toContain('/src/');
    expect(Object.keys(manifest.exports)).toEqual([
      '.',
      './element',
      './scene',
      './messages',
      './production',
      './control-action-catalog',
      './control-feedback',
      './control-feedback-authority',
      './control-visibility-feedback',
      './device-control-frame',
      './device-bootstrap',
      './device-state-sync',
      './device-credential',
    ]);
    for (const target of Object.values(manifest.exports).flatMap((entry) => [
      entry.types,
      entry.import,
    ])) {
      expect(paths).toContain(target.slice(2));
    }
  });

  it('loads every public subpath from a fresh ESM consumer', async () => {
    const specifiers = PUBLIC_SUBPATHS.map((subpath) => `@overlaykit/protocol${subpath}`);
    const runtime = [
      `for (const specifier of ${JSON.stringify(specifiers)}) await import(specifier);`,
      "const { generateKeyPairSync, sign, verify } = await import('node:crypto');",
      "const { DeviceCredentialLifecycle, MemoryDeviceCredentialStore } = await import('@overlaykit/protocol/device-credential');",
      'const lifecycle = new DeviceCredentialLifecycle(new MemoryDeviceCredentialStore(), {',
      '  now: () => 1000,',
      "  generateCredentialId: () => 'device-1',",
      "  generateSecret: () => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',",
      '  secretCodec: {',
      '    seal: (token) => `sealed:${token}` ,',
      '    matches: (token, sealed) => sealed === `sealed:${token}` ,',
      '  },',
      '});',
      'const issued = await lifecycle.issue(',
      "  { principalId: 'owner-1', roles: ['owner'] },",
      '  {',
      "    label: 'Production desk',",
      "    showId: 'show-1',",
      "    targets: ['program'],",
      "    controlIds: ['lower-third.visibility'],",
      "    scopes: ['feedback:read', 'component.visibility:write'],",
      '    expiresAt: 10000,',
      '  },',
      ');',
      'const authenticated = await lifecycle.authenticate(issued.token);',
      'if (!authenticated) process.exit(1);',
      "const { projectAuthorizedControlActionCatalog } = await import('@overlaykit/protocol/control-action-catalog');",
      'const catalog = projectAuthorizedControlActionCatalog(',
      "  { showId: 'show-1', capabilities: [{ kind: 'component.visibility', target: 'program', componentId: 'lower-third', label: 'Lower third' }] },",
      '  authenticated,',
      ');',
      'if (catalog.actions.length !== 1) process.exit(1);',
      "const { projectServerVisibilityFeedback } = await import('@overlaykit/protocol/control-visibility-feedback');",
      'const feedback = projectServerVisibilityFeedback(',
      "  { showId: 'show-1', bus: 'program', revision: 3, scene: null, elements: [{ id: 'lower-third', tag: 'div', styles: {} }], variables: {}, controls: [], orientation: 'landscape', updatedAt: 1000 },",
      '  catalog,',
      '  1001,',
      ');',
      "if (feedback.observations[0]?.value !== 'active' || feedback.observations[0]?.revision !== 3) process.exit(1);",
      "const { DEVICE_CONTROL_FRAME_ENVELOPE_VERSION, admitDeviceControlFrame, buildDeviceControlBootstrapFrame, deviceControlFramePayloadBytes, reduceDeviceControlFrame, projectDeviceControl } = await import('@overlaykit/protocol/device-control-frame');",
      'const frame = await buildDeviceControlBootstrapFrame({',
      "  showId: 'show-1',",
      "  target: 'program',",
      '  revision: 3,',
      '  catalogGeneration: 1,',
      '  confirmedAt: 1001,',
      '  catalog,',
      '  observations: feedback.observations,',
      '});',
      "const keys = generateKeyPairSync('ed25519');",
      'const payloadBytes = deviceControlFramePayloadBytes({',
      '  schemaVersion: DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,',
      "  issuerKeyId: 'server-key-1',",
      '  audienceCredentialId: authenticated.audienceCredentialId,',
      '  sequence: 1,',
      '  baseIssuerKeyId: null,',
      '  baseSequence: null,',
      '  baseSha256: null,',
      '  frame,',
      '});',
      "const signature = sign(null, payloadBytes, keys.privateKey).toString('base64url');",
      'const admitted = await admitDeviceControlFrame(',
      '  payloadBytes,',
      '  signature,',
      "  { ...authenticated, issuerKeyId: 'server-key-1', lastAcceptedSequence: 0 },",
      "  (bytes, detached) => verify(null, bytes, keys.publicKey, Buffer.from(detached, 'base64url')),",
      ');',
      'if (admitted.frame.catalogGeneration !== 1 || admitted.acceptedSequence !== 1) process.exit(1);',
      'const frameState = await reduceDeviceControlFrame(null, frame);',
      "const frameView = projectDeviceControl(frameState, { showId: 'show-1', target: 'program', controlId: 'lower-third.visibility' }, 1002);",
      "if (!frameView.available || frameView.buttonState !== 'active') process.exit(1);",
      "const { buildDeviceBootstrapSnapshotMessage, buildDeviceReadyMessage, parseDeviceBootstrapAck, parseDeviceBootstrapSnapshotMessage } = await import('@overlaykit/protocol/device-bootstrap');",
      'const acknowledgement = parseDeviceBootstrapAck({',
      "  schemaVersion: 'overlaykit-device-state-ack/v1',",
      "  type: 'device.state.ack',",
      "  mode: 'bootstrap',",
      "  target: 'program',",
      "  issuerKeyId: 'server-key-1',",
      '  sequence: 1,',
      "  sha256: 'a'.repeat(64),",
      "  status: 'applied',",
      '});',
      "if (acknowledgement.status !== 'applied' || !Object.isFrozen(acknowledgement)) process.exit(1);",
      "const snapshotDigest = await crypto.subtle.digest('SHA-256', payloadBytes);",
      "const snapshotHash = [...new Uint8Array(snapshotDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');",
      'const snapshotMessage = await buildDeviceBootstrapSnapshotMessage({',
      "  target: 'program',",
      "  issuerKeyId: 'server-key-1',",
      '  sequence: 2,',
      '  sha256: snapshotHash,',
      '  payloadBytes,',
      "  signature: 'detached-signature',",
      '});',
      'const parsedSnapshot = await parseDeviceBootstrapSnapshotMessage(snapshotMessage);',
      'if (parsedSnapshot.payloadBytes.length !== payloadBytes.length) process.exit(1);',
      "const { buildDeviceStateDeltaMessage, parseDeviceStateDeltaMessage } = await import('@overlaykit/protocol/device-state-sync');",
      'const deltaMessage = await buildDeviceStateDeltaMessage({',
      "  target: 'program',",
      "  issuerKeyId: 'server-key-1',",
      '  sequence: 2,',
      '  sha256: snapshotHash,',
      '  payloadBytes,',
      "  signature: 'detached-signature',",
      '});',
      'const parsedDelta = await parseDeviceStateDeltaMessage(deltaMessage);',
      "if (parsedDelta.message.type !== 'device.state.delta' || parsedDelta.payloadBytes.length !== payloadBytes.length) process.exit(1);",
      'const ready = buildDeviceReadyMessage();',
      "if (ready.type !== 'device.ready' || 'recordHash' in ready || 'globalSequence' in ready) process.exit(1);",
    ].join('\n');
    await expect(
      execFileAsync(process.execPath, ['--input-type=module', '--eval', runtime], {
        cwd: consumerDirectory,
      })
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('loads from CommonJS through import() and rejects synchronous require()', async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          '--eval',
          "import('@overlaykit/protocol/device-credential').then((value) => { if (typeof value.DeviceCredentialLifecycle !== 'function') process.exit(1); });",
        ],
        { cwd: consumerDirectory }
      )
    ).resolves.toMatchObject({ stderr: '' });

    await expect(
      execFileAsync(
        process.execPath,
        [
          '--eval',
          "try { require('@overlaykit/protocol/device-credential'); process.exit(1); } catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error.code !== 'ERR_REQUIRE_ESM') process.exit(2); }",
        ],
        { cwd: consumerDirectory }
      )
    ).resolves.toMatchObject({ stderr: '' });
  });

  it('resolves declarations for ESM and CommonJS TypeScript consumers', async () => {
    const esmConsumer = path.join(consumerDirectory, 'consumer.mts');
    const commonJsConsumer = path.join(consumerDirectory, 'consumer.cts');
    await writeFile(
      esmConsumer,
      [
        "import { DeviceCredentialLifecycle } from '@overlaykit/protocol';",
        "import type { DeviceCredentialStore } from '@overlaykit/protocol/device-credential';",
        "import type { ServerVisibilityFeedbackProjection } from '@overlaykit/protocol/control-visibility-feedback';",
        "import type { DeviceControlFrameState } from '@overlaykit/protocol/device-control-frame';",
        "import type { DeviceBootstrapAck, DeviceBootstrapSnapshotMessage, DeviceReadyMessage } from '@overlaykit/protocol/device-bootstrap';",
        "import type { DeviceStateAck, DeviceStateDeltaMessage } from '@overlaykit/protocol/device-state-sync';",
        'const lifecycle: typeof DeviceCredentialLifecycle = DeviceCredentialLifecycle;',
        'const store: DeviceCredentialStore | null = null;',
        'const feedback: ServerVisibilityFeedbackProjection | null = null;',
        'const frameState: DeviceControlFrameState | null = null;',
        'const bootstrapAck: DeviceBootstrapAck | null = null;',
        'const bootstrapSnapshot: DeviceBootstrapSnapshotMessage | null = null;',
        'const readyMessage: DeviceReadyMessage | null = null;',
        'const stateAck: DeviceStateAck | null = null;',
        'const deltaMessage: DeviceStateDeltaMessage | null = null;',
        'void lifecycle;',
        'void store;',
        'void feedback;',
        'void frameState;',
        'void bootstrapAck;',
        'void bootstrapSnapshot;',
        'void readyMessage;',
        'void stateAck;',
        'void deltaMessage;',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      commonJsConsumer,
      [
        'async function load() {',
        "  const protocol = await import('@overlaykit/protocol/device-credential');",
        '  return protocol.DeviceCredentialLifecycle;',
        '}',
        'void load;',
      ].join('\n'),
      'utf8'
    );

    await expect(
      execFileAsync(
        process.execPath,
        [
          tscPath,
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'Node16',
          '--moduleResolution',
          'Node16',
          esmConsumer,
          commonJsConsumer,
        ],
        { cwd: consumerDirectory }
      )
    ).resolves.toMatchObject({ stderr: '' });
  });
});
