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
import type { DeviceAuthorityObservationSource } from '../services/DeviceConnectionAuthorityMonitor';

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
  readonly store: Pick<InitializableDeviceCredentialStore, 'get'>;
  close(): Promise<void>;
}

export interface DeviceCredentialRuntimeOptions {
  readonly databasePath?: string;
  readonly legacyFilePath?: string;
  readonly store?: InitializableDeviceCredentialStore;
  readonly lifecycleOptions?: DeviceCredentialLifecycleOptions;
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
  const lifecycle = new ObservableDeviceCredentialLifecycle({
    lifecycle: persistedLifecycle,
    store,
    now: lifecycleOptions.now,
  });
  return {
    lifecycle,
    authoritySource: lifecycle,
    store,
    close: () => lifecycle.close(),
  };
}
