import type {
  DeviceAuthorizationRequest,
  DeviceCredential,
  DeviceCredentialAuthority,
  DeviceCredentialIssueInput,
  DeviceCredentialLifecycleOptions,
  DeviceCredentialOwner,
  DeviceCredentialStore,
  IssuedDeviceCredential,
} from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import { createDeviceCredentialCryptoOptions } from './DeviceCredentialCrypto';
import { FileDeviceCredentialStore } from './FileDeviceCredentialStore';

type DeviceCredentialProtocolModule = typeof import(
  '@overlaykit/protocol/device-credential',
  { with: { 'resolution-mode': 'import' } }
);

export interface InitializableDeviceCredentialStore extends DeviceCredentialStore {
  init(): Promise<void>;
}

export interface DeviceCredentialLifecyclePort {
  issue(
    owner: DeviceCredentialOwner,
    input: DeviceCredentialIssueInput,
  ): Promise<IssuedDeviceCredential>;
  rotate(owner: DeviceCredentialOwner, credentialId: string): Promise<IssuedDeviceCredential>;
  revoke(owner: DeviceCredentialOwner, credentialId: string): Promise<DeviceCredential>;
  authenticate(token: unknown): Promise<DeviceCredentialAuthority | null>;
  authorize(
    token: unknown,
    request: DeviceAuthorizationRequest,
  ): Promise<DeviceCredentialAuthority>;
}

export interface DeviceCredentialRuntime {
  readonly lifecycle: DeviceCredentialLifecyclePort;
  readonly store: InitializableDeviceCredentialStore;
}

export interface DeviceCredentialRuntimeOptions {
  readonly filePath?: string;
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
  const store = options.store ?? new FileDeviceCredentialStore(options.filePath);
  await store.init();
  const lifecycle = new protocol.DeviceCredentialLifecycle(
    store,
    options.lifecycleOptions ?? createDeviceCredentialCryptoOptions(),
  );
  return { lifecycle, store };
}
