import { createRequire } from 'node:module';
import {
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimePath = fileURLToPath(
  new URL('../dist/auth/DeviceCredentialRuntime.js', import.meta.url),
);
const catalogRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceActionCatalogRuntime.js', import.meta.url),
);
const feedbackRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceFeedbackIssuer.js', import.meta.url),
);
const channelManagerPath = fileURLToPath(
  new URL('../dist/services/ChannelManager.js', import.meta.url),
);
const productionServicePath = fileURLToPath(
  new URL('../dist/services/ProductionService.js', import.meta.url),
);
const compiled = await readFile(runtimePath, 'utf8');
const compiledCatalog = await readFile(catalogRuntimePath, 'utf8');
const compiledFeedback = await readFile(feedbackRuntimePath, 'utf8');
const protocolSpecifier = '@overlaykit/protocol/device-credential';
const catalogProtocolSpecifier = '@overlaykit/protocol/control-action-catalog';
const feedbackProtocolSpecifiers = [
  '@overlaykit/protocol/control-feedback-authority',
  '@overlaykit/protocol/control-visibility-feedback',
];

if (!new RegExp(`import\\(['\"]${protocolSpecifier}['\"]\\)`).test(compiled)) {
  throw new Error('Compiled device runtime does not preserve native dynamic import');
}
if (new RegExp(`require\\(['\"]${protocolSpecifier}['\"]\\)`).test(compiled)) {
  throw new Error('Compiled device runtime rewrites the ESM protocol import to require');
}

const catalogImportsProtocol = compiledCatalog.includes(`import('${catalogProtocolSpecifier}')`)
  || compiledCatalog.includes(`import("${catalogProtocolSpecifier}")`);
const catalogRequiresProtocol = compiledCatalog.includes(`require('${catalogProtocolSpecifier}')`)
  || compiledCatalog.includes(`require("${catalogProtocolSpecifier}")`);

if (!catalogImportsProtocol) {
  throw new Error('Compiled action catalog runtime does not preserve native dynamic import');
}
if (catalogRequiresProtocol) {
  throw new Error('Compiled action catalog runtime rewrites the ESM protocol import to require');
}

for (const specifier of feedbackProtocolSpecifiers) {
  const importsProtocol = compiledFeedback.includes(`import('${specifier}')`)
    || compiledFeedback.includes(`import("${specifier}")`);
  const requiresProtocol = compiledFeedback.includes(`require('${specifier}')`)
    || compiledFeedback.includes(`require("${specifier}")`);
  if (!importsProtocol) {
    throw new Error(`Compiled feedback runtime does not dynamically import ${specifier}`);
  }
  if (requiresProtocol) {
    throw new Error(`Compiled feedback runtime rewrites ${specifier} to require`);
  }
}

const { createDeviceCredentialRuntime } = require(runtimePath);
const { createDeviceActionCatalogRuntime } = require(catalogRuntimePath);
const { createDeviceFeedbackIssuerRuntime } = require(feedbackRuntimePath);
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
  },
);
const authority = await runtime.lifecycle.authenticate(issued.token);
const catalogRuntime = await createDeviceActionCatalogRuntime();
const catalog = catalogRuntime.projectAuthorizedControlActionCatalog(
  {
    showId: 'build-show',
    capabilities: [{
      kind: 'component.visibility',
      target: 'preview',
      componentId: 'build',
      label: 'Build',
    }],
  },
  authority,
);
const production = new ProductionService(new ChannelManager());
production.loadPreview('build-show', {
  id: 'build-scene',
  name: 'Build scene',
  elements: [{
    id: 'build',
    tag: 'div',
    content: 'Build',
    styles: {},
  }],
});
let feedbackSequence = 0;
let sequenceInitCalls = 0;
const sequenceStore = {
  async init() {
    sequenceInitCalls += 1;
  },
  async reserve(issuerKeyId, audienceCredentialId, count) {
    if (
      issuerKeyId !== 'build-server-key'
      || audienceCredentialId !== authority.audienceCredentialId
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
  (bytes, signature) => verifyBytes(
    null,
    bytes,
    keys.publicKey,
    Buffer.from(signature, 'base64url'),
  ),
);

if (
  initCalls !== 1
  || sequenceInitCalls !== 1
  || authority?.showId !== 'build-show'
  || catalog.actions[0]?.subject.controlId !== 'build.visibility'
  || feedback?.event?.value !== 'active'
  || admitted.acceptedSequence !== 1
) {
  throw new Error('Compiled device runtime did not compose executable authority, catalog, and feedback');
}

process.stdout.write('[verify-device-runtime] native ESM authority, catalog, and feedback verified\n');
