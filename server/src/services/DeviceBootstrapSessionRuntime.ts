import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import type { ProductionBus, ProductionState } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};
import type {
  DeviceBootstrapSnapshotMessage,
  DeviceReadyMessage,
} from '@overlaykit/protocol/device-bootstrap' with { 'resolution-mode': 'import' };
import {
  createDeviceBootstrapReadinessCoordinator,
  type DeviceBootstrapCloseReason,
  type DeviceBootstrapReadinessCoordinator,
} from './DeviceBootstrapReadinessCoordinator';
import {
  createDeviceBootstrapSnapshotIssuer,
  type DeviceBootstrapSigningAuthority,
} from './DeviceBootstrapSnapshotIssuer';
import type { DeviceActionCatalogRuntime } from './DeviceActionCatalogRuntime';
import type { DeviceReadinessTransitionPort } from './DeviceConnectionTransitionSession';
import {
  FileCatalogGenerationStore,
  type CatalogGenerationAuthority,
  type CatalogGenerationToken,
} from './FileCatalogGenerationStore';
import type { FeedbackSequenceStore } from './FileFeedbackSequenceStore';

type DeviceBootstrapProtocolModule = typeof import('@overlaykit/protocol/device-bootstrap', {
  with: { 'resolution-mode': 'import' },
});

export interface DeviceBootstrapObservableProduction {
  getState(showId: string): ProductionState;
  subscribe(
    showId: string,
    observer: (observation: {
      readonly showId: string;
      readonly target: ProductionBus;
      readonly state: ProductionState;
    }) => void,
  ): () => void;
}

export interface DeviceBootstrapSessionTransport {
  sendSnapshot(message: DeviceBootstrapSnapshotMessage): void | Promise<void>;
  sendReady(message: DeviceReadyMessage): void | Promise<void>;
  close(reason: DeviceBootstrapCloseReason): void | Promise<void>;
}

export interface DeviceBootstrapSession {
  start(): Promise<void>;
  receive(value: unknown): Promise<void>;
  dispose(): Promise<void>;
  isReady(): boolean;
}

export interface DeviceBootstrapSessionCreateOptions {
  readonly authority: DeviceCredentialAuthority;
  readonly transitions: DeviceReadinessTransitionPort;
  readonly transport: DeviceBootstrapSessionTransport;
}

export interface DeviceBootstrapSessionFactoryPort {
  create(options: DeviceBootstrapSessionCreateOptions): Promise<DeviceBootstrapSession>;
}

export interface DeviceBootstrapSessionFactoryOptions {
  readonly production: DeviceBootstrapObservableProduction;
  readonly actionCatalog: DeviceActionCatalogRuntime;
  readonly sequences: FeedbackSequenceStore;
  readonly signing: DeviceBootstrapSigningAuthority;
  readonly createCatalogGenerations?: (audienceCredentialId: string) => CatalogGenerationAuthority;
  readonly onBackgroundError?: (error: unknown) => void;
  readonly loadProtocol?: () => Promise<DeviceBootstrapProtocolModule>;
}

async function loadDeviceBootstrapProtocol(): Promise<DeviceBootstrapProtocolModule> {
  return import('@overlaykit/protocol/device-bootstrap');
}

function sameCatalog(left: CatalogGenerationToken, right: CatalogGenerationToken): boolean {
  return left.audienceCredentialId === right.audienceCredentialId
    && left.generation === right.generation
    && left.catalogHash === right.catalogHash;
}

class MountedDeviceBootstrapSession implements DeviceBootstrapSession {
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly coordinator: DeviceBootstrapReadinessCoordinator,
    private readonly catalogGenerations: CatalogGenerationAuthority,
    subscribe: () => () => void,
  ) {
    this.unsubscribe = subscribe();
  }

  start(): Promise<void> {
    return this.coordinator.start();
  }

  receive(value: unknown): Promise<void> {
    return this.coordinator.acknowledge(value);
  }

  isReady(): boolean {
    return this.coordinator.isReady();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.coordinator.abort(new Error('Device bootstrap session disposed'));
    await this.catalogGenerations.close();
  }
}

export class DeviceBootstrapSessionFactory implements DeviceBootstrapSessionFactoryPort {
  private readonly production: DeviceBootstrapObservableProduction;
  private readonly actionCatalog: DeviceActionCatalogRuntime;
  private readonly sequences: FeedbackSequenceStore;
  private readonly signing: DeviceBootstrapSigningAuthority;
  private readonly createCatalogGenerations: (
    audienceCredentialId: string,
  ) => CatalogGenerationAuthority;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly loadProtocol: () => Promise<DeviceBootstrapProtocolModule>;

  constructor(options: DeviceBootstrapSessionFactoryOptions) {
    if (
      !options
      || !options.production
      || typeof options.production.getState !== 'function'
      || typeof options.production.subscribe !== 'function'
      || !options.actionCatalog
      || !options.sequences
      || !options.signing
    ) {
      throw new Error('Device bootstrap session factory dependencies are invalid');
    }
    this.production = options.production;
    this.actionCatalog = options.actionCatalog;
    this.sequences = options.sequences;
    this.signing = options.signing;
    this.createCatalogGenerations = options.createCatalogGenerations
      ?? ((audienceCredentialId) => new FileCatalogGenerationStore(audienceCredentialId));
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.loadProtocol = options.loadProtocol ?? loadDeviceBootstrapProtocol;
  }

  async create(options: DeviceBootstrapSessionCreateOptions): Promise<DeviceBootstrapSession> {
    if (
      !options
      || !options.authority
      || !options.transitions
      || !options.transport
      || typeof options.transport.sendSnapshot !== 'function'
      || typeof options.transport.sendReady !== 'function'
      || typeof options.transport.close !== 'function'
    ) {
      throw new Error('Device bootstrap session options are invalid');
    }
    const protocol = await this.loadProtocol();
    const catalogGenerations = this.createCatalogGenerations(
      options.authority.audienceCredentialId,
    );
    let issuer;
    try {
      issuer = await createDeviceBootstrapSnapshotIssuer({
        authority: options.authority,
        production: this.production,
        actionCatalog: this.actionCatalog,
        catalogGenerations,
        sequences: this.sequences,
        signing: this.signing,
      });
    } catch (error) {
      await catalogGenerations.close().catch(() => undefined);
      throw error;
    }

    let observedCatalog = issuer.observeCurrentProductionState();
    const coordinator = await createDeviceBootstrapReadinessCoordinator({
      targets: options.authority.targets,
      snapshotFactory: {
        async create(target) {
          const snapshot = await issuer.create(target);
          return {
            issuerKeyId: snapshot.issuerKeyId,
            sequence: snapshot.sequence,
            bytes: snapshot.bytes,
            signature: snapshot.signature,
            currency: snapshot,
            evidence: {
              targetRevision: snapshot.freshness.targetRevision,
              catalogGeneration: snapshot.freshness.catalog.generation,
              confirmedAt: snapshot.freshness.confirmedAt,
            },
          };
        },
        isCurrent: (snapshot) => issuer.isCurrent(
          snapshot.currency as Parameters<typeof issuer.isCurrent>[0],
        ),
      },
      transport: {
        async send(emission) {
          const message = await protocol.buildDeviceBootstrapSnapshotMessage({
            target: emission.target,
            issuerKeyId: emission.issuerKeyId,
            sequence: emission.sequence,
            sha256: emission.sha256,
            payloadBytes: emission.bytes.slice(),
            signature: emission.signature,
          });
          await options.transport.sendSnapshot(message);
        },
        close: (reason) => options.transport.close(reason),
      },
      transitions: options.transitions,
      onReady: () => options.transport.sendReady(protocol.buildDeviceReadyMessage()),
      onBackgroundError: this.onBackgroundError,
    });
    const subscription = () => this.production.subscribe(
      options.authority.showId,
      ({ target, state }) => {
        try {
          const nextCatalog = issuer.observeProductionState(state);
          const affected = sameCatalog(nextCatalog, observedCatalog)
            ? [target]
            : [...options.authority.targets];
          observedCatalog = nextCatalog;
          for (const affectedTarget of affected) {
            void coordinator.notifyStateChanged(affectedTarget).catch((error) => {
              this.onBackgroundError(error);
              void coordinator.abort(error);
            });
          }
        } catch (error) {
          this.onBackgroundError(error);
          void coordinator.abort(error);
        }
      },
    );

    return new MountedDeviceBootstrapSession(coordinator, catalogGenerations, subscription);
  }
}
