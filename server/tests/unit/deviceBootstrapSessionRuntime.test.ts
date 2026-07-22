import { generateKeyPairSync, sign } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import {
  DEVICE_BOOTSTRAP_ACK_TYPE,
  DEVICE_BOOTSTRAP_ACK_VERSION,
  parseDeviceBootstrapSnapshotMessage,
  type DeviceBootstrapSnapshotMessage,
  type DeviceReadyMessage,
} from '@overlaykit/protocol/device-bootstrap';
import type {
  ProductionBus,
  ProductionSnapshot,
  ProductionState,
} from '@overlaykit/protocol/production';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { createDeviceActionCatalogRuntime } from '../../src/services/DeviceActionCatalogRuntime';
import {
  DeviceBootstrapSessionFactory,
  type DeviceBootstrapObservableProduction,
} from '../../src/services/DeviceBootstrapSessionRuntime';
import { DeviceConnectionTransitionSession } from '../../src/services/DeviceConnectionTransitionSession';
import type {
  CatalogGenerationAuthority,
  CatalogGenerationStoreState,
  CatalogGenerationToken,
} from '../../src/services/FileCatalogGenerationStore';
import type { FeedbackSequenceStore } from '../../src/services/FileFeedbackSequenceStore';

const stores: SqliteDeviceCredentialStore[] = [];

function emptySnapshot(showId: string, bus: ProductionBus): ProductionSnapshot {
  return {
    showId,
    bus,
    revision: 0,
    scene: null,
    elements: [],
    variables: {},
    controls: [],
    orientation: 'landscape',
    updatedAt: null,
  };
}

function element(id: string) {
  return {
    id,
    tag: 'div',
    content: id,
    styles: { display: '' },
  };
}

class ObservableProduction implements DeviceBootstrapObservableProduction {
  state: ProductionState = {
    showId: 'show-1',
    preview: emptySnapshot('show-1', 'preview'),
    program: emptySnapshot('show-1', 'program'),
    lastTake: null,
  };
  private readonly observers = new Set<Parameters<DeviceBootstrapObservableProduction['subscribe']>[1]>();

  getState(): ProductionState {
    return structuredClone(this.state);
  }

  subscribe(
    _showId: string,
    observer: Parameters<DeviceBootstrapObservableProduction['subscribe']>[1],
  ): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  change(target: ProductionBus, elements = this.state[target].elements): void {
    const current = this.state[target];
    this.state = {
      ...this.state,
      [target]: {
        ...current,
        revision: current.revision + 1,
        elements: structuredClone(elements),
        updatedAt: Date.now(),
      },
    };
    const observation = {
      showId: this.state.showId,
      target,
      state: this.getState(),
    };
    for (const observer of [...this.observers]) observer(observation);
  }
}

class MemoryCatalogGenerations implements CatalogGenerationAuthority {
  private generation = 0;
  private hash: string | null = null;
  private durable: CatalogGenerationToken | null = null;
  closed = false;

  async init(): Promise<void> {}

  observe(catalogHash: string): CatalogGenerationToken {
    if (catalogHash !== this.hash) {
      this.generation += 1;
      this.hash = catalogHash;
    }
    return Object.freeze({
      audienceCredentialId: 'device-1.g1',
      generation: this.generation,
      catalogHash,
    });
  }

  async confirm(token: CatalogGenerationToken): Promise<void> {
    if (!this.isObserved(token)) throw new Error('stale catalog generation');
    this.durable = token;
  }

  isCurrent(token: CatalogGenerationToken): boolean {
    return this.isObserved(token)
      && this.durable?.generation === token.generation
      && this.durable.catalogHash === token.catalogHash;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  getState(): CatalogGenerationStoreState {
    return {
      phase: this.closed ? 'closed' : 'ready',
      durability: 'process_restart_resilient',
      authorityHeld: !this.closed,
      currentGeneration: this.generation || null,
      durableGeneration: this.durable?.generation ?? null,
      lastErrorCode: null,
    };
  }

  private isObserved(token: CatalogGenerationToken): boolean {
    return token.audienceCredentialId === 'device-1.g1'
      && token.generation === this.generation
      && token.catalogHash === this.hash;
  }
}

class MemorySequences implements FeedbackSequenceStore {
  value = 0;
  async init(): Promise<void> {}
  async reserve(
    _issuerKeyId: string,
    _audienceCredentialId: string,
    count: number,
  ): Promise<ReadonlyArray<number>> {
    return Array.from({ length: count }, () => {
      this.value += 1;
      return this.value;
    });
  }
}

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: Date.now() + 60_000,
  };
}

async function waitFor(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function context(withElements = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-bootstrap-session-'));
  const store = new SqliteDeviceCredentialStore({
    databasePath: path.join(directory, 'authority.sqlite'),
  });
  stores.push(store);
  await store.init();
  const ledger = store.createTransitionLedger({ hostEpochId: `host-${stores.length}` });
  ledger.startHostEpoch();
  const transitions = new DeviceConnectionTransitionSession({
    ledger,
    connectionId: `connection-${stores.length}`,
    authority: {
      credentialId: 'device-1',
      audienceCredentialId: 'device-1.g1',
      generation: 1,
      showId: 'show-1',
      expiresAt: authority().expiresAt,
      authorityHash: 'd'.repeat(64),
    },
    targets: authority().targets,
    onFatal: (error) => { throw error; },
  });
  transitions.startNotReady();
  const production = new ObservableProduction();
  if (withElements) {
    production.state.preview.elements = [element('lower-third')];
    production.state.program.elements = [element('lower-third')];
  }
  const catalog = new MemoryCatalogGenerations();
  const { privateKey } = generateKeyPairSync('ed25519');
  const factory = new DeviceBootstrapSessionFactory({
    production,
    actionCatalog: await createDeviceActionCatalogRuntime(),
    sequences: new MemorySequences(),
    signing: {
      current: () => ({
        issuerKeyId: 'server-key-1',
        sign: (bytes) => sign(null, bytes, privateKey).toString('base64'),
      }),
    },
    createCatalogGenerations: () => catalog,
  });
  const snapshots: DeviceBootstrapSnapshotMessage[] = [];
  const ready: DeviceReadyMessage[] = [];
  const closes: string[] = [];
  const session = await factory.create({
    authority: authority(),
    transitions,
    transport: {
      sendSnapshot(message) { snapshots.push(message); },
      sendReady(message) { ready.push(message); },
      close(reason) { closes.push(reason); },
    },
  });
  return { store, ledger, transitions, production, catalog, session, snapshots, ready, closes };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('DeviceBootstrapSessionRuntime', () => {
  it('mounts exact signed snapshots and commits ready before its notification', async () => {
    const current = await context();
    await current.session.start();
    await waitFor(() => current.snapshots.length === 2, 'Initial snapshots were not sent');

    for (const message of current.snapshots) {
      const parsed = await parseDeviceBootstrapSnapshotMessage(message);
      expect(parsed.payloadBytes.byteLength).toBeGreaterThan(0);
      await current.session.receive({
        schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
        type: DEVICE_BOOTSTRAP_ACK_TYPE,
        target: message.target,
        sha256: message.sha256,
        status: 'applied',
      });
    }
    await waitFor(() => current.ready.length === 1, 'Ready notification was not sent');

    expect(current.session.isReady()).toBe(true);
    expect(current.transitions.getPhase()).toBe('ready');
    expect(current.ledger.readRecords().map(({ kind }) => kind)).toEqual([
      'host.started',
      'device.connection.not_ready',
      'device.connection.ready',
    ]);
    expect(current.ready[0]).toEqual({
      schemaVersion: 'overlaykit-device-ready/v1',
      type: 'device.ready',
    });
    expect(current.ready[0]).not.toHaveProperty('recordHash');
    expect(current.closes).toEqual([]);
    await current.session.receive({
      schemaVersion: 'overlaykit-device-command/v1',
      type: 'device.command',
      recordHash: current.ledger.getState().globalHash,
    });
    expect(current.closes).toEqual(['bootstrap.protocol_violation']);
    expect(current.transitions.getPhase()).toBe('closed');
    expect(current.ledger.readRecords().map(({ kind }) => kind)).toEqual([
      'host.started',
      'device.connection.not_ready',
      'device.connection.ready',
      'device.connection.quiescing',
      'device.connection.closed',
    ]);
    await current.session.dispose();
    current.ledger.stopHostEpoch();
  });

  it('reissues one target for local revision change and all targets for shared catalog change', async () => {
    const local = await context();
    await local.session.start();
    await waitFor(() => local.snapshots.length === 2, 'Local initial snapshots were not sent');
    local.production.change('preview');
    await waitFor(() => local.snapshots.length === 3, 'Local target was not reissued');
    expect(local.snapshots.map(({ target }) => target)).toEqual(['preview', 'program', 'preview']);
    local.transitions.close('test.completed');
    await local.session.dispose();
    local.ledger.stopHostEpoch();

    const shared = await context(true);
    await shared.session.start();
    await waitFor(() => shared.snapshots.length === 2, 'Shared initial snapshots were not sent');
    shared.production.change('preview', []);
    await waitFor(() => shared.snapshots.length === 4, 'Shared targets were not reissued');
    expect(shared.snapshots.map(({ target }) => target)).toEqual([
      'preview',
      'program',
      'preview',
      'program',
    ]);
    shared.transitions.close('test.completed');
    await shared.session.dispose();
    shared.ledger.stopHostEpoch();
  });
});
