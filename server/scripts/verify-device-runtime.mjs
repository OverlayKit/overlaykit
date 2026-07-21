import { createRequire } from 'node:module';
import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimePath = fileURLToPath(
  new URL('../dist/auth/DeviceCredentialRuntime.js', import.meta.url)
);
const catalogRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceActionCatalogRuntime.js', import.meta.url)
);
const feedbackRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceFeedbackIssuer.js', import.meta.url)
);
const bootstrapRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceBootstrapReadinessCoordinator.js', import.meta.url)
);
const bootstrapIssuerRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceBootstrapSnapshotIssuer.js', import.meta.url)
);
const channelManagerPath = fileURLToPath(
  new URL('../dist/services/ChannelManager.js', import.meta.url)
);
const productionServicePath = fileURLToPath(
  new URL('../dist/services/ProductionService.js', import.meta.url)
);
const compiled = await readFile(runtimePath, 'utf8');
const compiledCatalog = await readFile(catalogRuntimePath, 'utf8');
const compiledFeedback = await readFile(feedbackRuntimePath, 'utf8');
const compiledBootstrap = await readFile(bootstrapRuntimePath, 'utf8');
const compiledBootstrapIssuer = await readFile(bootstrapIssuerRuntimePath, 'utf8');
const protocolSpecifier = '@overlaykit/protocol/device-credential';
const catalogProtocolSpecifier = '@overlaykit/protocol/control-action-catalog';
const feedbackProtocolSpecifiers = [
  '@overlaykit/protocol/control-feedback-authority',
  '@overlaykit/protocol/control-visibility-feedback',
];
const bootstrapProtocolSpecifier = '@overlaykit/protocol/device-bootstrap';
const bootstrapIssuerProtocolSpecifiers = [
  '@overlaykit/protocol/device-control-frame',
  '@overlaykit/protocol/control-visibility-feedback',
];

if (!new RegExp(`import\\(['\"]${protocolSpecifier}['\"]\\)`).test(compiled)) {
  throw new Error('Compiled device runtime does not preserve native dynamic import');
}
if (new RegExp(`require\\(['\"]${protocolSpecifier}['\"]\\)`).test(compiled)) {
  throw new Error('Compiled device runtime rewrites the ESM protocol import to require');
}

const catalogImportsProtocol =
  compiledCatalog.includes(`import('${catalogProtocolSpecifier}')`) ||
  compiledCatalog.includes(`import("${catalogProtocolSpecifier}")`);
const catalogRequiresProtocol =
  compiledCatalog.includes(`require('${catalogProtocolSpecifier}')`) ||
  compiledCatalog.includes(`require("${catalogProtocolSpecifier}")`);

if (!catalogImportsProtocol) {
  throw new Error('Compiled action catalog runtime does not preserve native dynamic import');
}
if (catalogRequiresProtocol) {
  throw new Error('Compiled action catalog runtime rewrites the ESM protocol import to require');
}

for (const specifier of feedbackProtocolSpecifiers) {
  const importsProtocol =
    compiledFeedback.includes(`import('${specifier}')`) ||
    compiledFeedback.includes(`import("${specifier}")`);
  const requiresProtocol =
    compiledFeedback.includes(`require('${specifier}')`) ||
    compiledFeedback.includes(`require("${specifier}")`);
  if (!importsProtocol) {
    throw new Error(`Compiled feedback runtime does not dynamically import ${specifier}`);
  }
  if (requiresProtocol) {
    throw new Error(`Compiled feedback runtime rewrites ${specifier} to require`);
  }
}

const bootstrapImportsProtocol =
  compiledBootstrap.includes(`import('${bootstrapProtocolSpecifier}')`) ||
  compiledBootstrap.includes(`import("${bootstrapProtocolSpecifier}")`);
const bootstrapRequiresProtocol =
  compiledBootstrap.includes(`require('${bootstrapProtocolSpecifier}')`) ||
  compiledBootstrap.includes(`require("${bootstrapProtocolSpecifier}")`);
if (!bootstrapImportsProtocol) {
  throw new Error('Compiled bootstrap readiness runtime does not preserve native dynamic import');
}
if (bootstrapRequiresProtocol) {
  throw new Error(
    'Compiled bootstrap readiness runtime rewrites the ESM protocol import to require'
  );
}

for (const specifier of bootstrapIssuerProtocolSpecifiers) {
  const importsProtocol =
    compiledBootstrapIssuer.includes(`import('${specifier}')`) ||
    compiledBootstrapIssuer.includes(`import("${specifier}")`);
  const requiresProtocol =
    compiledBootstrapIssuer.includes(`require('${specifier}')`) ||
    compiledBootstrapIssuer.includes(`require("${specifier}")`);
  if (!importsProtocol) {
    throw new Error(`Compiled bootstrap issuer does not dynamically import ${specifier}`);
  }
  if (requiresProtocol) {
    throw new Error(`Compiled bootstrap issuer rewrites ${specifier} to require`);
  }
}

const { createDeviceCredentialRuntime } = require(runtimePath);
const { createDeviceActionCatalogRuntime } = require(catalogRuntimePath);
const { createDeviceFeedbackIssuerRuntime } = require(feedbackRuntimePath);
const { createDeviceBootstrapReadinessCoordinator } = require(bootstrapRuntimePath);
const { createDeviceBootstrapSnapshotIssuer } = require(bootstrapIssuerRuntimePath);
const { ChannelManager } = require(channelManagerPath);
const { ProductionService } = require(productionServicePath);
const records = new Map();
let initCalls = 0;
const store = {
  async init() {
    initCalls += 1;
  },
  async get(credentialId) {
    return records.get(credentialId) ?? null;
  },
  async create(record) {
    if (records.has(record.credentialId)) return false;
    records.set(record.credentialId, record);
    return true;
  },
  async replace(record, expectedGeneration) {
    const current = records.get(record.credentialId);
    if (!current || current.generation !== expectedGeneration) return false;
    records.set(record.credentialId, record);
    return true;
  },
};

const runtime = await createDeviceCredentialRuntime({ store });
const issued = await runtime.lifecycle.issue(
  { principalId: 'build-owner', roles: ['owner'] },
  {
    label: 'Build verifier',
    showId: 'build-show',
    targets: ['preview'],
    controlIds: ['build.visibility'],
    scopes: ['component.visibility:write', 'feedback:read'],
    expiresAt: Date.now() + 60_000,
  }
);
const authority = await runtime.lifecycle.authenticate(issued.token);
const catalogRuntime = await createDeviceActionCatalogRuntime();
const catalog = catalogRuntime.projectAuthorizedControlActionCatalog(
  {
    showId: 'build-show',
    capabilities: [
      {
        kind: 'component.visibility',
        target: 'preview',
        componentId: 'build',
        label: 'Build',
      },
    ],
  },
  authority
);
const production = new ProductionService(new ChannelManager());
production.loadPreview('build-show', {
  id: 'build-scene',
  name: 'Build scene',
  elements: [
    {
      id: 'build',
      tag: 'div',
      content: 'Build',
      styles: {},
    },
  ],
});
let feedbackSequence = 0;
let sequenceInitCalls = 0;
const sequenceStore = {
  async init() {
    sequenceInitCalls += 1;
  },
  async reserve(issuerKeyId, audienceCredentialId, count) {
    if (
      issuerKeyId !== 'build-server-key' ||
      audienceCredentialId !== authority.audienceCredentialId
    ) {
      throw new Error('Compiled feedback runtime reserved the wrong sequence authority');
    }
    return Array.from({ length: count }, () => {
      feedbackSequence += 1;
      return feedbackSequence;
    });
  },
};
const keys = generateKeyPairSync('ed25519');
const feedbackIssuer = await createDeviceFeedbackIssuerRuntime({
  production,
  credentials: runtime.lifecycle,
  actionCatalog: catalogRuntime,
  signer: {
    issuerKeyId: 'build-server-key',
    sign: (bytes) => signBytes(null, bytes, keys.privateKey).toString('base64url'),
  },
  sequenceStore,
});
const snapshot = production.getSnapshot('build-show', 'preview');
const [feedback] = await feedbackIssuer.issueVisibility({
  token: issued.token,
  showId: 'build-show',
  target: 'preview',
  observedAt: snapshot.updatedAt,
});
const feedbackProtocol = await import('@overlaykit/protocol/control-feedback-authority');
const admitted = await feedbackProtocol.admitControlFeedback(
  feedback,
  {
    issuerKeyId: 'build-server-key',
    audienceCredentialId: authority.audienceCredentialId,
    showId: authority.showId,
    targets: authority.targets,
    controlIds: authority.controlIds,
    scopes: ['feedback:read'],
    lastAcceptedSequence: 0,
  },
  (bytes, signature) =>
    verifyBytes(null, bytes, keys.publicKey, Buffer.from(signature, 'base64url'))
);
let currentCatalogGeneration = null;
let durableCatalogGeneration = null;
let catalogGenerationInitCalls = 0;
const catalogGenerations = {
  async init() {
    catalogGenerationInitCalls += 1;
  },
  observe(catalogHash) {
    if (currentCatalogGeneration?.catalogHash === catalogHash) return currentCatalogGeneration;
    currentCatalogGeneration = Object.freeze({
      audienceCredentialId: authority.audienceCredentialId,
      generation: (currentCatalogGeneration?.generation ?? 0) + 1,
      catalogHash,
    });
    return currentCatalogGeneration;
  },
  async confirm(token) {
    if (token !== currentCatalogGeneration) throw new Error('Compiled catalog generation is stale');
    durableCatalogGeneration = token;
  },
  isCurrent(token) {
    return token === currentCatalogGeneration && token === durableCatalogGeneration;
  },
  async close() {},
  getState() {
    return {
      phase: currentCatalogGeneration === durableCatalogGeneration ? 'ready' : 'blocked',
      durability: 'power_loss_resilient',
      authorityHeld: true,
      currentGeneration: currentCatalogGeneration?.generation ?? null,
      durableGeneration: durableCatalogGeneration?.generation ?? null,
      lastErrorCode: null,
    };
  },
};
const bootstrapIssuer = await createDeviceBootstrapSnapshotIssuer({
  authority,
  production,
  actionCatalog: catalogRuntime,
  catalogGenerations,
  sequences: sequenceStore,
  signing: {
    current: () => ({
      issuerKeyId: 'build-server-key',
      sign: (bytes) => signBytes(null, bytes, keys.privateKey).toString('base64url'),
    }),
  },
  now: () => snapshot.updatedAt + 1,
});
let bootstrapEmission = null;
let bootstrapCloseReason = null;
const bootstrap = await createDeviceBootstrapReadinessCoordinator({
  targets: ['preview'],
  snapshotFactory: bootstrapIssuer,
  transport: {
    send: (emission) => {
      bootstrapEmission = emission;
    },
    close: (reason) => {
      bootstrapCloseReason = reason;
    },
  },
});
await bootstrap.start();
for (let attempt = 0; attempt < 100 && !bootstrapEmission; attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
if (!bootstrapEmission) {
  throw new Error('Compiled bootstrap readiness runtime did not emit a snapshot');
}
const frameProtocol = await import('@overlaykit/protocol/device-control-frame');
const admittedBootstrap = await frameProtocol.admitDeviceControlFrame(
  bootstrapEmission.bytes,
  bootstrapEmission.signature,
  {
    issuerKeyId: 'build-server-key',
    audienceCredentialId: authority.audienceCredentialId,
    showId: authority.showId,
    targets: authority.targets,
    controlIds: authority.controlIds,
    scopes: ['feedback:read', 'component.visibility:write'],
    lastAcceptedSequence: admitted.acceptedSequence,
  },
  (bytes, signature) =>
    verifyBytes(null, bytes, keys.publicKey, Buffer.from(signature, 'base64url'))
);
await bootstrap.acknowledge({
  schemaVersion: 'overlaykit-device-bootstrap-ack/v1',
  type: 'device.bootstrap.ack',
  target: bootstrapEmission.target,
  sha256: bootstrapEmission.sha256,
  status: 'applied',
});
for (let attempt = 0; attempt < 100 && !bootstrap.isReady(); attempt += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}

if (
  initCalls !== 1 ||
  sequenceInitCalls !== 2 ||
  catalogGenerationInitCalls !== 1 ||
  authority?.showId !== 'build-show' ||
  catalog.actions[0]?.subject.controlId !== 'build.visibility' ||
  feedback?.event?.value !== 'active' ||
  admitted.acceptedSequence !== 1 ||
  admittedBootstrap.acceptedSequence !== 2 ||
  admittedBootstrap.frame.catalogGeneration !== 1 ||
  bootstrapEmission.issuerKeyId !== 'build-server-key' ||
  !bootstrap.isReady() ||
  bootstrapCloseReason !== null
) {
  throw new Error(
    'Compiled device runtime did not compose executable authority, catalog, feedback, and bootstrap readiness'
  );
}

process.stdout.write(
  '[verify-device-runtime] native ESM authority, catalog, feedback, and bootstrap readiness verified\n'
);
