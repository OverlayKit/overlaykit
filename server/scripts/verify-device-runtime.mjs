import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimePath = fileURLToPath(
  new URL('../dist/auth/DeviceCredentialRuntime.js', import.meta.url),
);
const catalogRuntimePath = fileURLToPath(
  new URL('../dist/services/DeviceActionCatalogRuntime.js', import.meta.url),
);
const compiled = await readFile(runtimePath, 'utf8');
const compiledCatalog = await readFile(catalogRuntimePath, 'utf8');
const protocolSpecifier = '@overlaykit/protocol/device-credential';
const catalogProtocolSpecifier = '@overlaykit/protocol/control-action-catalog';

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

const { createDeviceCredentialRuntime } = require(runtimePath);
const { createDeviceActionCatalogRuntime } = require(catalogRuntimePath);
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
    scopes: ['component.visibility:write'],
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

if (
  initCalls !== 1
  || authority?.showId !== 'build-show'
  || catalog.actions[0]?.subject.controlId !== 'build.visibility'
) {
  throw new Error('Compiled device runtime did not compose executable protocol authority and catalog');
}

process.stdout.write('[verify-device-runtime] native ESM protocol composition verified\n');
