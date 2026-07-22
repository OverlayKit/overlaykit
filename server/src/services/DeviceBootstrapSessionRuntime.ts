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
import type { DeviceStateDeltaMessage } from '@overlaykit/protocol/device-state-sync' with {
  'resolution-mode': 'import',
};
import {
  createDeviceBootstrapReadinessCoordinator,
  type DeviceBootstrapCloseReason,
  type DeviceBootstrapReadinessCoordinator,
} from './DeviceBootstrapReadinessCoordinator';
import {
  createDeviceBootstrapSnapshotIssuer,
  type IssuedDeviceBootstrapSnapshot,
  type IssuedDeviceControlDelta,
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
import {
  DevicePostReadySyncCoordinator,
  type DevicePostReadyCloseReason,
} from './DevicePostReadySyncCoordinator';
import type {
  DeviceTargetReadinessLease,
} from './DeviceTargetReadinessRegistry';
import {
  DeviceTargetReadinessRegistry,
} from './DeviceTargetReadinessRegistry';

type DeviceBootstrapProtocolModule = typeof import('@overlaykit/protocol/device-bootstrap', {
  with: { 'resolution-mode': 'import' },
});
type DeviceStateSyncProtocolModule = typeof import('@overlaykit/protocol/device-state-sync', {
  with: { 'resolution-mode': 'import' },
});

export type DeviceStateSessionCloseReason =
  | DeviceBootstrapCloseReason
  | DevicePostReadyCloseReason;

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
  sendDelta(message: DeviceStateDeltaMessage): void | Promise<void>;
  sendReady(message: DeviceReadyMessage): void | Promise<void>;
  close(reason: DeviceStateSessionCloseReason): void | Promise<void>;
}

export interface DeviceBootstrapSession {
  start(): Promise<void>;
  receive(value: unknown): Promise<void>;
  dispose(reason?: 'transport.closed' | 'host.shutdown', graceful?: boolean): Promise<void>;
  isReady(): boolean;
  isTargetReady(target: ProductionBus): boolean;
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
  readonly loadStateProtocol?: () => Promise<DeviceStateSyncProtocolModule>;
  readonly readiness?: DeviceTargetReadinessRegistry;
}

async function loadDeviceBootstrapProtocol(): Promise<DeviceBootstrapProtocolModule> {
  return import('@overlaykit/protocol/device-bootstrap');
}

async function loadDeviceStateSyncProtocol(): Promise<DeviceStateSyncProtocolModule> {
  return import('@overlaykit/protocol/device-state-sync');
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
    private readonly receiveFrame: (value: unknown) => Promise<void>,
    private readonly postReady: () => DevicePostReadySyncCoordinator | null,
    private readonly postReadyActivated: () => boolean,
    private readonly readinessLease: () => DeviceTargetReadinessLease | null,
  ) {
    this.unsubscribe = subscribe();
  }

  start(): Promise<void> {
    return this.coordinator.start();
  }

  receive(value: unknown): Promise<void> {
    return this.receiveFrame(value);
  }

  isReady(): boolean {
    return this.coordinator.isReady()
      && this.postReady() !== null
      && this.postReadyActivated();
  }

  isTargetReady(target: ProductionBus): boolean {
    return this.postReadyActivated()
      ? this.postReady()?.isTargetReady(target) ?? false
      : false;
  }

  async dispose(
    reason: 'transport.closed' | 'host.shutdown' = 'transport.closed',
    graceful = false,
  ): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    let failure: unknown = null;
    try {
      const postReady = this.postReady();
      if (postReady) {
        await postReady.dispose(reason, graceful);
      } else {
        await this.coordinator.abort(new Error('Device bootstrap session disposed'));
      }
    } catch (error) {
      failure = error;
    }
    try {
      this.readinessLease()?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.catalogGenerations.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
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
  private readonly loadStateProtocol: () => Promise<DeviceStateSyncProtocolModule>;
  private readonly readiness: DeviceTargetReadinessRegistry;

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
    this.loadStateProtocol = options.loadStateProtocol ?? loadDeviceStateSyncProtocol;
    this.readiness = options.readiness ?? new DeviceTargetReadinessRegistry();
  }

  async create(options: DeviceBootstrapSessionCreateOptions): Promise<DeviceBootstrapSession> {
    if (
      !options
      || !options.authority
      || !options.transitions
      || !options.transport
      || typeof options.transport.sendSnapshot !== 'function'
      || typeof options.transport.sendDelta !== 'function'
      || typeof options.transport.sendReady !== 'function'
      || typeof options.transport.close !== 'function'
    ) {
      throw new Error('Device bootstrap session options are invalid');
    }
    this.readiness.suspend(options.authority);
    const [protocol, stateProtocol] = await Promise.all([
      this.loadProtocol(),
      this.loadStateProtocol(),
    ]);
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
    let postReady: DevicePostReadySyncCoordinator | null = null;
    let postReadyActivated = false;
    let readinessLease: DeviceTargetReadinessLease | null = null;
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
      onReady: async (_witness, appliedTargets) => {
        const initialBases = appliedTargets.map((applied) => {
          const issued = applied.snapshot.currency as IssuedDeviceBootstrapSnapshot;
          if (
            !issued
            || typeof issued !== 'object'
            || issued.state?.target !== applied.target
            || issued.issuerKeyId !== applied.issuerKeyId
            || issued.sequence !== applied.sequence
          ) {
            throw new Error('Applied bootstrap target lacks exact issued state');
          }
          return {
            target: applied.target,
            identity: {
              issuerKeyId: applied.issuerKeyId,
              sequence: applied.sequence,
              sha256: applied.sha256,
            },
            state: issued.state,
            appliedAt: applied.appliedAt,
          };
        });
        try {
          await options.transport.sendReady(protocol.buildDeviceReadyMessage());
          postReady = new DevicePostReadySyncCoordinator({
            initialBases,
            snapshotFactory: {
              async create(base) {
                const delta = await issuer.createDelta({
                  identity: base.identity,
                  state: base.state,
                });
                return {
                  issuerKeyId: delta.issuerKeyId,
                  sequence: delta.sequence,
                  bytes: delta.bytes,
                  signature: delta.signature,
                  base: delta.base,
                  state: delta.state,
                  currency: delta,
                  evidence: {
                    targetRevision: delta.freshness.targetRevision,
                    catalogGeneration: delta.freshness.catalog.generation,
                    confirmedAt: delta.freshness.confirmedAt,
                  },
                };
              },
              isCurrent: (snapshot) => issuer.isCurrent(
                snapshot.currency as IssuedDeviceControlDelta,
              ),
              currentIssuerKeyId: () => issuer.currentIssuerKeyId(),
            },
            transport: {
              async send(emission) {
                const message = await stateProtocol.buildDeviceStateDeltaMessage({
                  target: emission.target,
                  issuerKeyId: emission.issuerKeyId,
                  sequence: emission.sequence,
                  sha256: emission.sha256,
                  payloadBytes: emission.bytes.slice(),
                  signature: emission.signature,
                });
                await options.transport.sendDelta(message);
              },
              close: (reason) => options.transport.close(reason),
            },
            parseAck: stateProtocol.parseDeviceStateAck,
            onTargetReadinessChanged: (target, ready) => readinessLease?.set(target, ready),
            onCheckpoint: (reason, targets, occurredAt) => {
              options.transitions.checkpoint(occurredAt, reason, targets);
            },
            onBackgroundError: this.onBackgroundError,
          });
          for (const applied of appliedTargets) {
            if (!issuer.isCurrent(applied.snapshot.currency as IssuedDeviceBootstrapSnapshot)) {
              await postReady.notifyStateChanged(applied.target);
            }
          }
          readinessLease = this.readiness.register(options.authority);
          for (const target of options.authority.targets) {
            readinessLease.set(target, postReady.isTargetReady(target));
          }
          postReadyActivated = true;
        } catch (error) {
          postReadyActivated = false;
          readinessLease?.close();
          readinessLease = null;
          const failedPostReady = postReady;
          postReady = null;
          if (failedPostReady) {
            await failedPostReady.dispose('transport.closed', false).catch(this.onBackgroundError);
          }
          throw error;
        }
      },
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
            const active = postReady;
            const notification = active
              ? active.notifyStateChanged(affectedTarget)
              : coordinator.notifyStateChanged(affectedTarget);
            void notification.catch((error) => {
              this.onBackgroundError(error);
              if (active) void active.abort(error);
              else void coordinator.abort(error);
            });
          }
        } catch (error) {
          this.onBackgroundError(error);
          if (postReady) void postReady.abort(error);
          else void coordinator.abort(error);
        }
      },
    );

    const receiveFrame = (value: unknown): Promise<void> => {
      let acknowledgement;
      try {
        acknowledgement = stateProtocol.parseDeviceStateAck(value);
      } catch {
        return postReady
          ? postReady.acknowledge(value)
          : coordinator.acknowledge(value);
      }
      if (acknowledgement.mode === 'bootstrap') {
        return coordinator.acknowledge(acknowledgement);
      }
      return postReady
        ? postReady.acknowledge(acknowledgement)
        : coordinator.acknowledge(acknowledgement);
    };

    return new MountedDeviceBootstrapSession(
      coordinator,
      catalogGenerations,
      subscription,
      receiveFrame,
      () => postReady,
      () => postReadyActivated,
      () => readinessLease,
    );
  }
}
