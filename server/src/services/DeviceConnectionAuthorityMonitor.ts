import { createHash } from 'crypto';
import type {
  DeviceCredentialAuthority,
  DeviceCredentialScope,
} from '@overlaykit/protocol/device-credential' with { 'resolution-mode': 'import' };
import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};

export const DEVICE_CONNECTION_AUTHORITY_SCHEMA_VERSION =
  'overlaykit-device-connection-authority/v1' as const;
export const DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS = 5_000;
export const DEVICE_AUTHORITY_MAX_STALENESS_MS = 10_000;

const MAX_IDENTIFIER_LENGTH = 200;
const TARGET_ORDER: ReadonlyArray<ProductionBus> = ['preview', 'program'];
const SCOPE_ORDER: ReadonlyArray<DeviceCredentialScope> = [
  'feedback:read',
  'component.visibility:write',
  'cue:execute',
  'production:take',
];

export interface CanonicalDeviceConnectionAuthority {
  readonly schemaVersion: typeof DEVICE_CONNECTION_AUTHORITY_SCHEMA_VERSION;
  readonly credentialId: string;
  readonly audienceCredentialId: string;
  readonly generation: number;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<DeviceCredentialScope>;
  readonly expiresAt: number;
}

export type DeviceAuthorityInvalidationReason =
  'authority.changed' | 'authority.unavailable' | 'credential.expired';

export interface DeviceAuthorityObservationSource {
  isAvailable(): boolean;
  subscribe(
    credentialId: string,
    listener: (authority: DeviceCredentialAuthority | null) => void
  ): () => void;
  resolve(credentialId: string): Promise<DeviceCredentialAuthority | null>;
}

export interface DeviceAuthorityMonitorScheduler {
  schedule(at: number, task: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface DeviceAuthorityInvalidationTarget {
  invalidate(reason: DeviceAuthorityInvalidationReason): void | Promise<void>;
}

export interface DeviceAuthorityMonitorLease {
  readonly authorityHash: string;
  isCurrent(): boolean;
  close(): void;
}

export interface DeviceAuthorityMonitorAdmission {
  readonly authority: DeviceCredentialAuthority;
  readonly authorityHash: string;
  isCurrent(): boolean;
  activate(target: DeviceAuthorityInvalidationTarget): DeviceAuthorityMonitorLease;
  abort(): void;
}

export type DeviceAuthorityMonitorErrorCode =
  | 'INVALID_DEVICE_AUTHORITY_MONITOR'
  | 'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE'
  | 'DEVICE_AUTHORITY_CHANGED'
  | 'DEVICE_AUTHORITY_EXPIRED';

export class DeviceAuthorityMonitorError extends Error {
  constructor(
    readonly code: DeviceAuthorityMonitorErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeviceAuthorityMonitorError';
  }
}

export interface DeviceConnectionAuthorityMonitorOptions {
  readonly source: DeviceAuthorityObservationSource;
  readonly now?: () => number;
  readonly scheduler?: DeviceAuthorityMonitorScheduler;
  readonly onBackgroundError?: (error: unknown) => void;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim()
  ) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      `${label} is invalid`
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      `${label} must be a positive safe integer`
    );
  }
  return value as number;
}

function normalizedList<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  label: string
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      `${label} are invalid`
    );
  }
  if (
    value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry as T)) ||
    new Set(value).size !== value.length
  ) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      `${label} are invalid`
    );
  }
  return allowed.filter((entry) => value.includes(entry));
}

function normalizedControlIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      'Control identifiers are invalid'
    );
  }
  const controls = value.map((controlId) => requiredIdentifier(controlId, 'Control identifier'));
  if (new Set(controls).size !== controls.length) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      'Control identifiers are invalid'
    );
  }
  return controls.sort(codeUnitCompare);
}

function frozenAuthority(authority: CanonicalDeviceConnectionAuthority): DeviceCredentialAuthority {
  return Object.freeze({
    credentialId: authority.credentialId,
    audienceCredentialId: authority.audienceCredentialId,
    generation: authority.generation,
    showId: authority.showId,
    targets: Object.freeze([...authority.targets]),
    controlIds: Object.freeze([...authority.controlIds]),
    scopes: Object.freeze([...authority.scopes]),
    expiresAt: authority.expiresAt,
  });
}

export function canonicalDeviceConnectionAuthority(
  authority: DeviceCredentialAuthority
): CanonicalDeviceConnectionAuthority {
  if (!authority || typeof authority !== 'object') {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      'Device credential authority is required'
    );
  }
  const credentialId = requiredIdentifier(authority.credentialId, 'Credential identifier');
  const generation = positiveSafeInteger(authority.generation, 'Credential generation');
  const audienceCredentialId = requiredIdentifier(
    authority.audienceCredentialId,
    'Credential audience'
  );
  if (audienceCredentialId !== `${credentialId}.g${generation}`) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      'Credential audience does not match its generation'
    );
  }
  return Object.freeze({
    schemaVersion: DEVICE_CONNECTION_AUTHORITY_SCHEMA_VERSION,
    credentialId,
    audienceCredentialId,
    generation,
    showId: requiredIdentifier(authority.showId, 'Show identifier'),
    targets: Object.freeze(normalizedList(authority.targets, TARGET_ORDER, 'Targets')),
    controlIds: Object.freeze(normalizedControlIds(authority.controlIds)),
    scopes: Object.freeze(normalizedList(authority.scopes, SCOPE_ORDER, 'Scopes')),
    expiresAt: positiveSafeInteger(authority.expiresAt, 'Credential expiration'),
  });
}

export function deviceConnectionAuthorityHash(authority: DeviceCredentialAuthority): string {
  const payload = canonicalDeviceConnectionAuthority(authority);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeviceAuthorityMonitorError(
      'INVALID_DEVICE_AUTHORITY_MONITOR',
      'Authority monitor clock must return a non-negative safe integer'
    );
  }
  return value;
}

function defaultScheduler(now: () => number): DeviceAuthorityMonitorScheduler {
  return {
    schedule(at, task) {
      const delay = Math.max(0, Math.min(at - normalizedNow(now), 2_147_483_647));
      return setTimeout(task, delay);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

type MonitorPhase = 'new' | 'preparing' | 'prepared' | 'active' | 'invalidated' | 'closed';

class AuthorityMonitorSession implements DeviceAuthorityMonitorAdmission {
  readonly authority: DeviceCredentialAuthority;
  readonly authorityHash: string;
  private phase: MonitorPhase = 'new';
  private confirmationAt: number | null = null;
  private pollHandle: unknown | null = null;
  private staleHandle: unknown | null = null;
  private unsubscribe: (() => void) | null = null;
  private target: DeviceAuthorityInvalidationTarget | null = null;
  private invalidationError: DeviceAuthorityMonitorError | null = null;
  private resolveInvalidation!: () => void;
  private readonly invalidationSignal = new Promise<void>((resolve) => {
    this.resolveInvalidation = resolve;
  });

  constructor(
    authority: DeviceCredentialAuthority,
    private readonly source: DeviceAuthorityObservationSource,
    private readonly now: () => number,
    private readonly scheduler: DeviceAuthorityMonitorScheduler,
    private readonly onBackgroundError: (error: unknown) => void
  ) {
    const canonical = canonicalDeviceConnectionAuthority(authority);
    this.authority = frozenAuthority(canonical);
    this.authorityHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  async prepare(): Promise<void> {
    if (this.phase !== 'new') {
      throw new DeviceAuthorityMonitorError(
        'INVALID_DEVICE_AUTHORITY_MONITOR',
        'Authority monitor admission has already started'
      );
    }
    this.phase = 'preparing';
    try {
      const unsubscribe = this.source.subscribe(this.authority.credentialId, (authority) =>
        this.observeNotification(authority)
      );
      if (typeof unsubscribe !== 'function') {
        throw new Error('Authority subscription did not return a release function');
      }
      this.unsubscribe = unsubscribe;
      if (this.isTerminal()) this.cleanup();
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority subscription is unavailable'
      );
    }
    if (this.isTerminal()) throw this.requiredInvalidationError();

    let observedAt: number;
    try {
      observedAt = normalizedNow(this.now);
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority clock is unavailable'
      );
      throw this.requiredInvalidationError();
    }
    try {
      this.scheduleStale(observedAt);
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority timeout could not be scheduled'
      );
      throw this.requiredInvalidationError();
    }
    const initialCheck = this.resolveCurrent(observedAt);
    await Promise.race([
      initialCheck,
      this.invalidationSignal.then(() => {
        throw this.requiredInvalidationError();
      }),
    ]);
    if (this.isTerminal()) throw this.requiredInvalidationError();
    if (this.confirmationAt === null) {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority could not be confirmed'
      );
      throw this.requiredInvalidationError();
    }
    this.phase = 'prepared';
  }

  isCurrent(): boolean {
    if (this.phase !== 'prepared' && this.phase !== 'active') return false;
    if (this.confirmationAt === null) return false;
    try {
      const now = normalizedNow(this.now);
      return (
        now < this.confirmationAt + DEVICE_AUTHORITY_MAX_STALENESS_MS &&
        now < this.authority.expiresAt
      );
    } catch {
      return false;
    }
  }

  activate(target: DeviceAuthorityInvalidationTarget): DeviceAuthorityMonitorLease {
    if (!target || typeof target !== 'object' || typeof target.invalidate !== 'function') {
      throw new DeviceAuthorityMonitorError(
        'INVALID_DEVICE_AUTHORITY_MONITOR',
        'Authority invalidation target is required'
      );
    }
    if (this.phase !== 'prepared' || !this.isCurrent()) {
      this.invalidate(
        'authority.changed',
        'DEVICE_AUTHORITY_CHANGED',
        'Device authority changed before activation'
      );
      throw this.requiredInvalidationError();
    }
    this.target = Object.freeze({
      invalidate: target.invalidate.bind(target),
    });
    this.phase = 'active';
    return Object.freeze({
      authorityHash: this.authorityHash,
      isCurrent: () => this.isCurrent(),
      close: () => this.close(),
    });
  }

  abort(): void {
    if (this.phase === 'active') {
      throw new DeviceAuthorityMonitorError(
        'INVALID_DEVICE_AUTHORITY_MONITOR',
        'An active authority monitor must close through its lease'
      );
    }
    this.close();
  }

  private observeNotification(authority: DeviceCredentialAuthority | null): void {
    if (this.isTerminal()) return;
    let observedAt: number;
    try {
      observedAt = normalizedNow(this.now);
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority clock is unavailable'
      );
      return;
    }
    if (!this.observationMatches(authority, observedAt)) return;
    void this.resolveCurrent(observedAt).catch(this.onBackgroundError);
  }

  private async resolveCurrent(observedAt: number): Promise<void> {
    if (this.isTerminal()) return;
    let authority: DeviceCredentialAuthority | null;
    try {
      if (!this.source.isAvailable()) throw new Error('Authority source is unavailable');
      authority = await this.source.resolve(this.authority.credentialId);
      if (!this.source.isAvailable()) throw new Error('Authority source is unavailable');
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority revalidation is unavailable'
      );
      return;
    }
    if (this.isTerminal()) return;
    this.acceptObservation(authority, observedAt);
  }

  private acceptObservation(authority: DeviceCredentialAuthority | null, observedAt: number): void {
    if (!this.observationMatches(authority, observedAt)) return;
    this.confirm(observedAt);
  }

  private observationMatches(
    authority: DeviceCredentialAuthority | null,
    observedAt: number
  ): boolean {
    if (this.isTerminal()) return false;
    if (!authority) {
      this.invalidate(
        'authority.changed',
        'DEVICE_AUTHORITY_CHANGED',
        'Device authority is no longer effective'
      );
      return false;
    }
    let canonical: CanonicalDeviceConnectionAuthority;
    try {
      canonical = canonicalDeviceConnectionAuthority(authority);
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority observation is malformed'
      );
      return false;
    }
    if (canonical.expiresAt <= observedAt) {
      this.invalidate(
        'credential.expired',
        'DEVICE_AUTHORITY_EXPIRED',
        'Device authority is expired'
      );
      return false;
    }
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    if (hash !== this.authorityHash) {
      this.invalidate('authority.changed', 'DEVICE_AUTHORITY_CHANGED', 'Device authority changed');
      return false;
    }
    return true;
  }

  private confirm(observedAt: number): void {
    if (this.isTerminal()) return;
    if (this.confirmationAt !== null && observedAt <= this.confirmationAt) return;
    this.confirmationAt = observedAt;
    this.cancelTimers();
    try {
      this.pollHandle = this.scheduler.schedule(
        observedAt + DEVICE_AUTHORITY_REVALIDATION_INTERVAL_MS,
        () => {
          this.pollHandle = null;
          let startedAt: number;
          try {
            startedAt = normalizedNow(this.now);
          } catch {
            this.invalidate(
              'authority.unavailable',
              'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
              'Device authority clock is unavailable'
            );
            return;
          }
          void this.resolveCurrent(startedAt).catch(this.onBackgroundError);
        }
      );
      this.scheduleStale(observedAt);
    } catch {
      this.invalidate(
        'authority.unavailable',
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority revalidation could not be scheduled'
      );
    }
  }

  private scheduleStale(observedAt: number): void {
    if (this.staleHandle !== null) this.scheduler.cancel(this.staleHandle);
    this.staleHandle = this.scheduler.schedule(
      observedAt + DEVICE_AUTHORITY_MAX_STALENESS_MS,
      () => {
        this.staleHandle = null;
        if (this.confirmationAt !== null && this.confirmationAt > observedAt) return;
        this.invalidate(
          'authority.unavailable',
          'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
          'Device authority revalidation timed out'
        );
      }
    );
  }

  private invalidate(
    reason: DeviceAuthorityInvalidationReason,
    code: DeviceAuthorityMonitorErrorCode,
    message: string
  ): void {
    if (this.isTerminal()) return;
    this.phase = 'invalidated';
    this.invalidationError = new DeviceAuthorityMonitorError(code, message);
    this.cleanup();
    this.resolveInvalidation();
    if (!this.target) return;
    try {
      void Promise.resolve(this.target.invalidate(reason)).catch(this.onBackgroundError);
    } catch (error) {
      this.onBackgroundError(error);
    }
  }

  private close(): void {
    if (this.isTerminal()) return;
    this.phase = 'closed';
    this.cleanup();
  }

  private cleanup(): void {
    this.cancelTimers();
    if (!this.unsubscribe) return;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try {
      unsubscribe();
    } catch (error) {
      this.onBackgroundError(error);
    }
  }

  private cancelTimers(): void {
    if (this.pollHandle !== null) {
      try {
        this.scheduler.cancel(this.pollHandle);
      } catch (error) {
        this.onBackgroundError(error);
      }
    }
    if (this.staleHandle !== null) {
      try {
        this.scheduler.cancel(this.staleHandle);
      } catch (error) {
        this.onBackgroundError(error);
      }
    }
    this.pollHandle = null;
    this.staleHandle = null;
  }

  private isTerminal(): boolean {
    return this.phase === 'invalidated' || this.phase === 'closed';
  }

  private requiredInvalidationError(): DeviceAuthorityMonitorError {
    return (
      this.invalidationError ??
      new DeviceAuthorityMonitorError(
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority monitor is unavailable'
      )
    );
  }
}

export class DeviceConnectionAuthorityMonitor {
  private readonly source: DeviceAuthorityObservationSource;
  private readonly now: () => number;
  private readonly scheduler: DeviceAuthorityMonitorScheduler;
  private readonly onBackgroundError: (error: unknown) => void;

  constructor(options: DeviceConnectionAuthorityMonitorOptions) {
    if (
      !options?.source ||
      typeof options.source.isAvailable !== 'function' ||
      typeof options.source.subscribe !== 'function' ||
      typeof options.source.resolve !== 'function'
    ) {
      throw new DeviceAuthorityMonitorError(
        'INVALID_DEVICE_AUTHORITY_MONITOR',
        'Device authority observation source is required'
      );
    }
    this.source = options.source;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler(this.now);
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    normalizedNow(this.now);
  }

  isAvailable(): boolean {
    try {
      return this.source.isAvailable() === true;
    } catch {
      return false;
    }
  }

  async prepare(authority: DeviceCredentialAuthority): Promise<DeviceAuthorityMonitorAdmission> {
    if (!this.isAvailable()) {
      throw new DeviceAuthorityMonitorError(
        'DEVICE_AUTHORITY_MONITOR_UNAVAILABLE',
        'Device authority monitor is unavailable'
      );
    }
    const session = new AuthorityMonitorSession(
      authority,
      this.source,
      this.now,
      this.scheduler,
      this.onBackgroundError
    );
    await session.prepare();
    return session;
  }
}
