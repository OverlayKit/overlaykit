import type {
  DeviceAuthorizationRequest,
  DeviceCredential,
  DeviceCredentialAuthority,
  DeviceCredentialIssueInput,
  DeviceCredentialLifecycleOptions,
  DeviceCredentialOwner,
  DeviceCredentialRotationInput,
  DeviceCredentialStore,
  IssuedDeviceCredential,
} from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import { createDeviceCredentialCryptoOptions } from './DeviceCredentialCrypto';
import { ObservableDeviceCredentialLifecycle } from './ObservableDeviceCredentialLifecycle';
import { SqliteDeviceCredentialStore } from './SqliteDeviceCredentialStore';
import type { DeviceCredentialEventLogPort } from './SqliteDeviceCredentialEventLog';
import { logger } from '../utils/logger';
import type { DeviceAuthorityObservationSource } from '../services/DeviceConnectionAuthorityMonitor';
import type { DeviceTransitionLedgerPort } from '../services/SqliteDeviceTransitionLedger';
import type { ProductionStatePersistencePort } from '../services/SqliteProductionStateStore';
import type { DeviceSigningAuthority } from './SqliteDeviceSigningAuthority';

type DeviceCredentialProtocolModule = typeof import(
  '@overlaykit/protocol/device-credential',
  { with: { 'resolution-mode': 'import' } }
);

export interface InitializableDeviceCredentialStore extends DeviceCredentialStore {
  init(): Promise<void>;
  close?(): void | Promise<void>;
}

export interface DeviceCredentialLifecyclePort {
  issue(
    owner: DeviceCredentialOwner,
    input: DeviceCredentialIssueInput,
  ): Promise<IssuedDeviceCredential>;
  rotate(
    owner: DeviceCredentialOwner,
    credentialId: string,
    input?: DeviceCredentialRotationInput,
  ): Promise<IssuedDeviceCredential>;
  revoke(owner: DeviceCredentialOwner, credentialId: string): Promise<DeviceCredential>;
  authenticate(token: unknown): Promise<DeviceCredentialAuthority | null>;
  authorize(
    token: unknown,
    request: DeviceAuthorizationRequest,
  ): Promise<DeviceCredentialAuthority>;
  resolveAuthority(credentialId: string): Promise<DeviceCredentialAuthority | null>;
}

export interface DeviceCredentialRuntime {
  readonly lifecycle: DeviceCredentialLifecyclePort;
  readonly authoritySource: DeviceAuthorityObservationSource;
  readonly store: Pick<InitializableDeviceCredentialStore, 'get' | 'listByShow'>;
  readonly transitionLedger: DeviceTransitionLedgerPort | null;
  readonly productionState: ProductionStatePersistencePort | null;
  readonly events: DeviceCredentialEventLogPort | null;
  readonly signing: DeviceSigningAuthority | null;
  close(): Promise<void>;
}

export interface DeviceCredentialRuntimeOptions {
  readonly databasePath?: string;
  readonly legacyFilePath?: string;
  readonly store?: InitializableDeviceCredentialStore;
  readonly lifecycleOptions?: DeviceCredentialLifecycleOptions;
  readonly transitionLedger?: DeviceTransitionLedgerPort;
  readonly productionState?: ProductionStatePersistencePort;
  readonly events?: DeviceCredentialEventLogPort;
  readonly loadProtocol?: () => Promise<DeviceCredentialProtocolModule>;
}

async function loadDeviceCredentialProtocol(): Promise<DeviceCredentialProtocolModule> {
  return import('@overlaykit/protocol/device-credential');
}

export async function createDeviceCredentialRuntime(
  options: DeviceCredentialRuntimeOptions = {},
): Promise<DeviceCredentialRuntime> {
  const protocol = await (options.loadProtocol ?? loadDeviceCredentialProtocol)();
  const store = options.store ?? new SqliteDeviceCredentialStore({
    databasePath: options.databasePath,
    legacyFilePath: options.legacyFilePath,
  });
  await store.init();
  const lifecycleOptions = options.lifecycleOptions ?? createDeviceCredentialCryptoOptions();
  const persistedLifecycle = new protocol.DeviceCredentialLifecycle(
    store,
    lifecycleOptions,
  );
  // The event log must exist before the lifecycle so mutations can record into it; the SQLite
  // store owns the shared connection, so the log is created off it when nothing was injected.
  const events =
    options.events ??
    (store instanceof SqliteDeviceCredentialStore ? store.createCredentialEventLog() : null);
  const lifecycle = new ObservableDeviceCredentialLifecycle({
    lifecycle: persistedLifecycle,
    store,
    now: lifecycleOptions.now,
    recordEvent: events
      ? async (event) => {
          await events.record(event);
        }
      : undefined,
    // A dropped audit event must never fail the credential mutation, but it must not vanish
    // silently either — surface it so gaps in the append-only log are detectable.
    onBackgroundError: (error) =>
      logger.error('Device credential event recording failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  let transitionLedger = options.transitionLedger ?? null;
  let productionState = options.productionState ?? null;
  const signing = store instanceof SqliteDeviceCredentialStore
    ? store.getSigningAuthority()
    : null;
  if (!transitionLedger && store instanceof SqliteDeviceCredentialStore) {
    try {
      transitionLedger = store.createTransitionLedger();
      transitionLedger.startHostEpoch();
    } catch (error) {
      await store.close?.();
      throw error;
    }
  }
  if (!productionState && store instanceof SqliteDeviceCredentialStore) {
    productionState = store.createProductionStateStore();
  }
  return {
    lifecycle,
    authoritySource: lifecycle,
    store,
    transitionLedger,
    productionState,
    events,
    signing,
    close: async () => {
      let ledgerError: unknown;
      if (transitionLedger?.getState().activeHostEpochId) {
        try {
          transitionLedger.stopHostEpoch();
        } catch (error) {
          ledgerError = error;
        }
      }
      await lifecycle.close();
      if (ledgerError) throw ledgerError;
    },
  };
}
