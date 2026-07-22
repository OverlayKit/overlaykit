import type {
  DeviceAuthorizationRequest,
  DeviceCredential,
  DeviceCredentialAuthority,
  DeviceCredentialIssueInput,
  DeviceCredentialOwner,
  DeviceCredentialRotationInput,
  IssuedDeviceCredential,
} from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import type { DeviceAuthorityObservationSource } from '../services/DeviceConnectionAuthorityMonitor';
import type {
  DeviceCredentialLifecyclePort,
  InitializableDeviceCredentialStore,
} from './DeviceCredentialRuntime';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type AuthorityListener = (authority: DeviceCredentialAuthority | null) => void | Promise<void>;

interface ExpirationTimer {
  readonly expiresAt: number;
  readonly handle: ReturnType<typeof setTimeout>;
}

function immutableAuthority(
  credential: DeviceCredential | DeviceCredentialAuthority,
): DeviceCredentialAuthority {
  return Object.freeze({
    credentialId: credential.credentialId,
    audienceCredentialId: 'audienceCredentialId' in credential
      ? credential.audienceCredentialId
      : `${credential.credentialId}.g${credential.generation}`,
    generation: credential.generation,
    showId: credential.showId,
    targets: Object.freeze([...credential.targets]),
    controlIds: Object.freeze([...credential.controlIds]),
    scopes: Object.freeze([...credential.scopes]),
    expiresAt: credential.expiresAt,
  });
}

export interface ObservableDeviceCredentialLifecycleOptions {
  readonly lifecycle: DeviceCredentialLifecyclePort;
  readonly store: InitializableDeviceCredentialStore;
  readonly now?: () => number;
  readonly onBackgroundError?: (error: unknown) => void;
}

export class ObservableDeviceCredentialLifecycle
implements DeviceCredentialLifecyclePort, DeviceAuthorityObservationSource {
  private readonly lifecycle: DeviceCredentialLifecyclePort;
  private readonly store: InitializableDeviceCredentialStore;
  private readonly now: () => number;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly listeners = new Map<string, Set<AuthorityListener>>();
  private readonly expirationTimers = new Map<string, ExpirationTimer>();
  private queue: Promise<void> = Promise.resolve();
  private available = true;

  constructor(options: ObservableDeviceCredentialLifecycleOptions) {
    this.lifecycle = options.lifecycle;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  isAvailable(): boolean {
    return this.available;
  }

  subscribe(credentialId: string, listener: AuthorityListener): () => void {
    if (!this.available) throw new Error('Device credential authority is unavailable');
    let listeners = this.listeners.get(credentialId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(credentialId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(credentialId);
    };
  }

  async resolve(credentialId: string): Promise<DeviceCredentialAuthority | null> {
    if (!this.available) throw new Error('Device credential authority is unavailable');
    const authority = await this.lifecycle.resolveAuthority(credentialId);
    if (authority) this.scheduleExpiration(authority);
    return authority ? immutableAuthority(authority) : null;
  }

  issue(
    owner: DeviceCredentialOwner,
    input: DeviceCredentialIssueInput,
  ): Promise<IssuedDeviceCredential> {
    return this.exclusive(async () => {
      const issued = await this.lifecycle.issue(owner, input);
      const authority = immutableAuthority(issued.credential);
      this.scheduleExpiration(authority);
      await this.publish(authority.credentialId, authority);
      return issued;
    });
  }

  rotate(
    owner: DeviceCredentialOwner,
    credentialId: string,
    input: DeviceCredentialRotationInput = {},
  ): Promise<IssuedDeviceCredential> {
    return this.exclusive(async () => {
      const issued = await this.lifecycle.rotate(owner, credentialId, input);
      const authority = immutableAuthority(issued.credential);
      this.scheduleExpiration(authority);
      await this.publish(authority.credentialId, authority);
      return issued;
    });
  }

  revoke(owner: DeviceCredentialOwner, credentialId: string): Promise<DeviceCredential> {
    return this.exclusive(async () => {
      const credential = await this.lifecycle.revoke(owner, credentialId);
      this.cancelExpiration(credential.credentialId);
      await this.publish(credential.credentialId, null);
      return credential;
    });
  }

  authenticate(token: unknown): Promise<DeviceCredentialAuthority | null> {
    if (!this.available) return Promise.resolve(null);
    return this.lifecycle.authenticate(token);
  }

  authorize(
    token: unknown,
    request: DeviceAuthorizationRequest,
  ): Promise<DeviceCredentialAuthority> {
    if (!this.available) return Promise.reject(new Error('Device credential authority is unavailable'));
    return this.lifecycle.authorize(token, request);
  }

  resolveAuthority(credentialId: string): Promise<DeviceCredentialAuthority | null> {
    return this.resolve(credentialId);
  }

  async close(): Promise<void> {
    if (!this.available) return;
    this.available = false;
    for (const credentialId of [...this.expirationTimers.keys()]) {
      this.cancelExpiration(credentialId);
    }
    const invalidations = [...this.listeners.entries()].map(([credentialId]) =>
      this.publish(credentialId, null),
    );
    await Promise.allSettled(invalidations);
    this.listeners.clear();
    await this.store.close?.();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.available) return Promise.reject(new Error('Device credential authority is unavailable'));
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async publish(
    credentialId: string,
    authority: DeviceCredentialAuthority | null,
  ): Promise<void> {
    const listeners = [...(this.listeners.get(credentialId) ?? [])];
    const outcomes = await Promise.allSettled(
      listeners.map((listener) => Promise.resolve().then(() => listener(authority))),
    );
    if (authority === null || outcomes.every((outcome) => outcome.status === 'fulfilled')) return;

    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') this.onBackgroundError(outcome.reason);
    }
    await Promise.allSettled(
      listeners.map((listener) => Promise.resolve().then(() => listener(null))),
    );
  }

  private scheduleExpiration(authority: DeviceCredentialAuthority): void {
    const current = this.expirationTimers.get(authority.credentialId);
    if (current?.expiresAt === authority.expiresAt) return;
    this.cancelExpiration(authority.credentialId);
    const delay = Math.max(0, Math.min(authority.expiresAt - this.now(), MAX_TIMER_DELAY_MS));
    const handle = setTimeout(() => {
      this.expirationTimers.delete(authority.credentialId);
      void this.exclusive(async () => {
        const effective = await this.lifecycle.resolveAuthority(authority.credentialId);
        if (effective) {
          this.scheduleExpiration(effective);
          return;
        }
        await this.publish(authority.credentialId, null);
      }).catch(this.onBackgroundError);
    }, delay);
    handle.unref();
    this.expirationTimers.set(authority.credentialId, {
      expiresAt: authority.expiresAt,
      handle,
    });
  }

  private cancelExpiration(credentialId: string): void {
    const timer = this.expirationTimers.get(credentialId);
    if (!timer) return;
    clearTimeout(timer.handle);
    this.expirationTimers.delete(credentialId);
  }
}
