const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEVICE_CONNECTION_CLOSE_REASONS = [
  'replaced',
  'credential.rotated',
  'credential.revoked',
  'credential.expired',
  'show.archived',
  'authority.changed',
  'authority.unavailable',
  'authority.rejected',
  'server.shutdown',
] as const;

export type DeviceConnectionCloseReason = (typeof DEVICE_CONNECTION_CLOSE_REASONS)[number];

export interface DeviceConnectionAuthority {
  readonly credentialId: string;
  readonly audienceCredentialId: string;
  readonly generation: number;
  readonly showId: string;
  readonly expiresAt: number;
}

export interface DeviceAuthorityConnection {
  readonly id: string;
  close(reason: DeviceConnectionCloseReason): void | Promise<void>;
}

export interface DeviceAuthorityScheduler {
  schedule(at: number, task: () => Promise<void>): unknown;
  cancel(handle: unknown): void;
}

export interface DeviceConnectionLease {
  readonly connectionId: string;
  readonly authority: DeviceConnectionAuthority;
}

export type DeviceConnectionAuthorityErrorCode =
  | 'INVALID_DEVICE_CONNECTION_AUTHORITY'
  | 'DEVICE_AUTHORITY_IDENTITY_CONFLICT'
  | 'DEVICE_AUTHORITY_BLOCKED'
  | 'DEVICE_AUTHORITY_EXPIRED'
  | 'DEVICE_CONNECTION_NOT_ACTIVE'
  | 'DEVICE_CONNECTION_CLOSE_FAILED'
  | 'DEVICE_AUTHORITY_SCHEDULING_FAILED';

export class DeviceConnectionAuthorityError extends Error {
  constructor(
    readonly code: DeviceConnectionAuthorityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'DeviceConnectionAuthorityError';
  }
}

export interface DeviceConnectionAuthorityCoordinatorOptions {
  readonly now?: () => number;
  readonly scheduler?: DeviceAuthorityScheduler;
  readonly onBackgroundError?: (error: unknown) => void;
}

type SlotPhase = 'active' | 'quiescing';

interface ConnectionSlot {
  readonly authority: DeviceConnectionAuthority;
  readonly connection: DeviceAuthorityConnection;
  readonly lease: DeviceConnectionLease;
  phase: SlotPhase;
  runningOperations: number;
  readonly drainWaiters: Array<() => void>;
  expiryHandle: unknown | null;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim()
  ) {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      `${label} is invalid`
    );
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      `${label} must be a positive safe integer`
    );
  }
  return value as number;
}

function normalizedAuthority(value: DeviceConnectionAuthority): DeviceConnectionAuthority {
  if (!value || typeof value !== 'object') {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      'Device connection authority is required'
    );
  }
  const credentialId = requiredIdentifier(value.credentialId, 'Credential identifier');
  const generation = positiveSafeInteger(value.generation, 'Credential generation');
  const audienceCredentialId = requiredIdentifier(
    value.audienceCredentialId,
    'Credential audience'
  );
  if (audienceCredentialId !== `${credentialId}.g${generation}`) {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      'Credential audience does not match its generation'
    );
  }
  const showId = requiredIdentifier(value.showId, 'Show identifier');
  const expiresAt = positiveSafeInteger(value.expiresAt, 'Credential expiration');
  return Object.freeze({
    credentialId,
    audienceCredentialId,
    generation,
    showId,
    expiresAt,
  });
}

function normalizedConnection(value: DeviceAuthorityConnection): DeviceAuthorityConnection {
  if (!value || typeof value !== 'object' || typeof value.close !== 'function') {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      'Device connection is invalid'
    );
  }
  const id = requiredIdentifier(value.id, 'Connection identifier');
  const close = value.close.bind(value);
  return Object.freeze({
    id,
    close: (reason: DeviceConnectionCloseReason) => close(reason),
  });
}

function normalizedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeviceConnectionAuthorityError(
      'INVALID_DEVICE_CONNECTION_AUTHORITY',
      'Authority clock must return a non-negative safe integer'
    );
  }
  return value;
}

function defaultScheduler(now: () => number): DeviceAuthorityScheduler {
  return {
    schedule(at, task) {
      const delay = Math.min(Math.max(0, at - normalizedNow(now)), MAX_TIMER_DELAY_MS);
      return setTimeout(() => {
        void task().catch(() => undefined);
      }, delay);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function closeFailure(): DeviceConnectionAuthorityError {
  return new DeviceConnectionAuthorityError(
    'DEVICE_CONNECTION_CLOSE_FAILED',
    'Device connection did not close cleanly'
  );
}

function schedulingFailure(): DeviceConnectionAuthorityError {
  return new DeviceConnectionAuthorityError(
    'DEVICE_AUTHORITY_SCHEDULING_FAILED',
    'Device authority expiration could not be scheduled'
  );
}

export class DeviceConnectionAuthorityCoordinator {
  private readonly now: () => number;
  private readonly scheduler: DeviceAuthorityScheduler;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly slots = new Map<string, ConnectionSlot>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly transitionCounts = new Map<string, number>();
  private readonly credentialShows = new Map<string, string>();
  private readonly audienceExpirations = new Map<string, number>();
  private readonly retiredGenerations = new Map<string, number>();
  private readonly revokedCredentials = new Set<string>();
  private readonly archivedShows = new Set<string>();
  private accepting = true;

  constructor(options: DeviceConnectionAuthorityCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
    this.scheduler = options.scheduler ?? defaultScheduler(this.now);
    normalizedNow(this.now);
  }

  async connect(
    authorityInput: DeviceConnectionAuthority,
    connectionInput: DeviceAuthorityConnection,
    authorityIsCurrentInput?: () => boolean
  ): Promise<DeviceConnectionLease> {
    const connection = normalizedConnection(connectionInput);
    if (!this.accepting) {
      return this.rejectIncoming(
        connection,
        new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_BLOCKED',
          'Device authority is shutting down'
        ),
        'server.shutdown'
      );
    }
    if (authorityIsCurrentInput !== undefined && typeof authorityIsCurrentInput !== 'function') {
      return this.rejectIncoming(
        connection,
        new DeviceConnectionAuthorityError(
          'INVALID_DEVICE_CONNECTION_AUTHORITY',
          'Device authority currency witness is invalid'
        )
      );
    }
    const authorityIsCurrent = (): boolean => {
      try {
        return authorityIsCurrentInput?.() ?? true;
      } catch {
        return false;
      }
    };

    let authority: DeviceConnectionAuthority;
    try {
      authority = normalizedAuthority(authorityInput);
    } catch (error) {
      return this.rejectIncoming(connection, error);
    }
    if (!authorityIsCurrent()) {
      return this.rejectIncoming(
        connection,
        new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_BLOCKED',
          'Device authority changed during admission'
        ),
        'authority.changed'
      );
    }

    const immediateBlock = this.authorityBlock(authority);
    if (immediateBlock) {
      return this.rejectIncoming(connection, immediateBlock.error, immediateBlock.reason);
    }
    return this.enqueue(authority.credentialId, async () => {
      if (!this.accepting) {
        return this.rejectIncoming(
          connection,
          new DeviceConnectionAuthorityError(
            'DEVICE_AUTHORITY_BLOCKED',
            'Device authority is shutting down'
          ),
          'server.shutdown'
        );
      }
      if (!authorityIsCurrent()) {
        return this.rejectIncoming(
          connection,
          new DeviceConnectionAuthorityError(
            'DEVICE_AUTHORITY_BLOCKED',
            'Device authority changed during admission'
          ),
          'authority.changed'
        );
      }
      const blockedBeforeReplacement = this.authorityBlock(authority);
      if (blockedBeforeReplacement) {
        return this.rejectIncoming(
          connection,
          blockedBeforeReplacement.error,
          blockedBeforeReplacement.reason
        );
      }
      try {
        this.assertAuthorityIdentity(authority);
      } catch (error) {
        return this.rejectIncoming(connection, error);
      }

      const current = this.slots.get(authority.credentialId);
      if (current) {
        try {
          await this.closeSlot(current, 'replaced');
        } catch (error) {
          await this.closeRejected(connection);
          throw error;
        }
      }

      const blockedAfterReplacement = this.authorityBlock(authority);
      if (blockedAfterReplacement) {
        return this.rejectIncoming(
          connection,
          blockedAfterReplacement.error,
          blockedAfterReplacement.reason
        );
      }
      if (!authorityIsCurrent()) {
        return this.rejectIncoming(
          connection,
          new DeviceConnectionAuthorityError(
            'DEVICE_AUTHORITY_BLOCKED',
            'Device authority changed during admission'
          ),
          'authority.changed'
        );
      }
      this.rememberAuthorityIdentity(authority);

      const lease = Object.freeze({
        connectionId: connection.id,
        authority,
      });
      const slot: ConnectionSlot = {
        authority,
        connection,
        lease,
        phase: 'active',
        runningOperations: 0,
        drainWaiters: [],
        expiryHandle: null,
      };
      this.slots.set(authority.credentialId, slot);
      try {
        this.scheduleExpiry(slot);
      } catch {
        await this.closeSlot(slot, 'authority.rejected');
        throw schedulingFailure();
      }
      return lease;
    });
  }

  async execute<T>(lease: DeviceConnectionLease, operation: () => T | Promise<T>): Promise<T> {
    if (typeof operation !== 'function') {
      throw new DeviceConnectionAuthorityError(
        'INVALID_DEVICE_CONNECTION_AUTHORITY',
        'Device operation is required'
      );
    }
    const slot = this.requireEffectiveSlot(lease);
    slot.runningOperations += 1;
    try {
      return await operation();
    } finally {
      this.releaseOperation(slot);
    }
  }

  isEffective(lease: DeviceConnectionLease): boolean {
    try {
      this.requireEffectiveSlot(lease);
      return true;
    } catch {
      return false;
    }
  }

  retire(lease: DeviceConnectionLease, reason: DeviceConnectionCloseReason): Promise<void> {
    if (!lease || typeof lease !== 'object' || !DEVICE_CONNECTION_CLOSE_REASONS.includes(reason)) {
      return Promise.reject(
        new DeviceConnectionAuthorityError(
          'INVALID_DEVICE_CONNECTION_AUTHORITY',
          'Device connection retirement is invalid'
        )
      );
    }
    const credentialId = lease.authority?.credentialId;
    const current = typeof credentialId === 'string' ? this.slots.get(credentialId) : undefined;
    if (!current || current.lease !== lease || current.phase !== 'active') {
      return Promise.resolve();
    }
    current.phase = 'quiescing';
    return this.enqueue(credentialId, async () => {
      const slot = this.slots.get(credentialId);
      if (slot?.lease === lease) await this.closeSlot(slot, reason);
    });
  }

  rotateCredential(credentialIdInput: string, retiredGenerationInput: number): Promise<void> {
    const credentialId = requiredIdentifier(credentialIdInput, 'Credential identifier');
    const retiredGeneration = positiveSafeInteger(
      retiredGenerationInput,
      'Retired credential generation'
    );
    this.retiredGenerations.set(
      credentialId,
      Math.max(this.retiredGenerations.get(credentialId) ?? 0, retiredGeneration)
    );
    return this.enqueue(credentialId, async () => {
      const current = this.slots.get(credentialId);
      if (current && current.authority.generation <= retiredGeneration) {
        await this.closeSlot(current, 'credential.rotated');
      }
    });
  }

  revokeCredential(credentialIdInput: string): Promise<void> {
    const credentialId = requiredIdentifier(credentialIdInput, 'Credential identifier');
    this.revokedCredentials.add(credentialId);
    return this.enqueue(credentialId, async () => {
      const current = this.slots.get(credentialId);
      if (current) await this.closeSlot(current, 'credential.revoked');
    });
  }

  async archiveShow(showIdInput: string): Promise<void> {
    const showId = requiredIdentifier(showIdInput, 'Show identifier');
    this.archivedShows.add(showId);
    const affectedCredentialIds = [...this.credentialShows.entries()]
      .filter(([, credentialShowId]) => credentialShowId === showId)
      .map(([credentialId]) => credentialId)
      .sort();

    const outcomes = await Promise.all(
      affectedCredentialIds.map((credentialId) =>
        this.enqueue(credentialId, async () => {
          const current = this.slots.get(credentialId);
          if (current && current.authority.showId === showId) {
            await this.closeSlot(current, 'show.archived');
          }
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        )
      )
    );
    const failure = outcomes.find((outcome) => !outcome.ok);
    if (failure && !failure.ok) throw failure.error;
  }

  async shutdown(): Promise<void> {
    if (!this.accepting && this.slots.size === 0) return;
    this.accepting = false;
    const slots = [...this.slots.values()];
    for (const slot of slots) slot.phase = 'quiescing';
    const outcomes = await Promise.allSettled(
      slots.map((slot) => this.enqueue(slot.authority.credentialId, async () => {
        if (this.slots.get(slot.authority.credentialId) === slot) {
          await this.closeSlot(slot, 'server.shutdown');
        }
      }))
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private assertAuthorityIdentity(authority: DeviceConnectionAuthority): void {
    const currentShow = this.credentialShows.get(authority.credentialId);
    const currentExpiration = this.audienceExpirations.get(authority.audienceCredentialId);
    if (
      (currentShow && currentShow !== authority.showId) ||
      (currentExpiration !== undefined && currentExpiration !== authority.expiresAt)
    ) {
      throw new DeviceConnectionAuthorityError(
        'DEVICE_AUTHORITY_IDENTITY_CONFLICT',
        'Credential authority identity conflicts with an earlier connection'
      );
    }
  }

  private rememberAuthorityIdentity(authority: DeviceConnectionAuthority): void {
    this.credentialShows.set(authority.credentialId, authority.showId);
    this.audienceExpirations.set(authority.audienceCredentialId, authority.expiresAt);
  }

  private authorityBlock(authority: DeviceConnectionAuthority): {
    readonly error: DeviceConnectionAuthorityError;
    readonly reason: DeviceConnectionCloseReason;
  } | null {
    if (this.revokedCredentials.has(authority.credentialId)) {
      return {
        error: new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_BLOCKED',
          'Device credential is revoked'
        ),
        reason: 'credential.revoked',
      };
    }
    if (this.archivedShows.has(authority.showId)) {
      return {
        error: new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_BLOCKED',
          'Device Show is archived'
        ),
        reason: 'show.archived',
      };
    }
    if (authority.generation <= (this.retiredGenerations.get(authority.credentialId) ?? 0)) {
      return {
        error: new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_BLOCKED',
          'Device credential generation is retired'
        ),
        reason: 'credential.rotated',
      };
    }
    if (authority.expiresAt <= normalizedNow(this.now)) {
      return {
        error: new DeviceConnectionAuthorityError(
          'DEVICE_AUTHORITY_EXPIRED',
          'Device credential is expired'
        ),
        reason: 'credential.expired',
      };
    }
    return null;
  }

  private requireEffectiveSlot(lease: DeviceConnectionLease): ConnectionSlot {
    if (!lease || typeof lease !== 'object') {
      throw new DeviceConnectionAuthorityError(
        'DEVICE_CONNECTION_NOT_ACTIVE',
        'Device connection lease is not active'
      );
    }
    const credentialId = lease.authority?.credentialId;
    const slot = typeof credentialId === 'string' ? this.slots.get(credentialId) : undefined;
    if (
      !slot ||
      slot.lease !== lease ||
      slot.phase !== 'active' ||
      (this.transitionCounts.get(credentialId) ?? 0) > 0 ||
      this.revokedCredentials.has(credentialId) ||
      this.archivedShows.has(slot.authority.showId) ||
      slot.authority.generation <= (this.retiredGenerations.get(credentialId) ?? 0)
    ) {
      throw new DeviceConnectionAuthorityError(
        'DEVICE_CONNECTION_NOT_ACTIVE',
        'Device connection lease is not active'
      );
    }
    if (slot.authority.expiresAt <= normalizedNow(this.now)) {
      this.expireSlot(slot);
      throw new DeviceConnectionAuthorityError(
        'DEVICE_AUTHORITY_EXPIRED',
        'Device credential is expired'
      );
    }
    return slot;
  }

  private expireSlot(slot: ConnectionSlot): void {
    void this.enqueue(slot.authority.credentialId, async () => {
      if (
        this.slots.get(slot.authority.credentialId) === slot &&
        slot.authority.expiresAt <= normalizedNow(this.now)
      ) {
        await this.closeSlot(slot, 'credential.expired');
      }
    }).catch(this.onBackgroundError);
  }

  private scheduleExpiry(slot: ConnectionSlot): void {
    slot.expiryHandle = this.scheduler.schedule(slot.authority.expiresAt, async () => {
      try {
        if (this.slots.get(slot.authority.credentialId) !== slot || slot.phase !== 'active') return;
        if (slot.authority.expiresAt > normalizedNow(this.now)) {
          this.scheduleExpiry(slot);
          return;
        }
        await this.enqueue(slot.authority.credentialId, async () => {
          if (this.slots.get(slot.authority.credentialId) === slot) {
            await this.closeSlot(slot, 'credential.expired');
          }
        });
      } catch (error) {
        this.onBackgroundError(error);
        if (this.slots.get(slot.authority.credentialId) === slot && slot.phase === 'active') {
          try {
            await this.enqueue(slot.authority.credentialId, async () => {
              if (this.slots.get(slot.authority.credentialId) === slot) {
                await this.closeSlot(slot, 'authority.rejected');
              }
            });
          } catch (closeError) {
            this.onBackgroundError(closeError);
          }
        }
      }
    });
  }

  private cancelExpiry(slot: ConnectionSlot): void {
    if (slot.expiryHandle === null) return;
    this.scheduler.cancel(slot.expiryHandle);
    slot.expiryHandle = null;
  }

  private async closeSlot(
    slot: ConnectionSlot,
    reason: DeviceConnectionCloseReason
  ): Promise<void> {
    if (this.slots.get(slot.authority.credentialId) !== slot) return;
    slot.phase = 'quiescing';
    this.cancelExpiry(slot);

    let closePromise: Promise<void>;
    try {
      closePromise = Promise.resolve(slot.connection.close(reason));
    } catch {
      closePromise = Promise.reject(closeFailure());
    }

    const [closeOutcome] = await Promise.all([
      closePromise.then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const })
      ),
      this.waitForDrain(slot),
    ]);
    if (!closeOutcome.ok) throw closeFailure();

    if (this.slots.get(slot.authority.credentialId) === slot) {
      this.slots.delete(slot.authority.credentialId);
    }
  }

  private waitForDrain(slot: ConnectionSlot): Promise<void> {
    if (slot.runningOperations === 0) return Promise.resolve();
    return new Promise((resolve) => {
      slot.drainWaiters.push(resolve);
    });
  }

  private releaseOperation(slot: ConnectionSlot): void {
    slot.runningOperations -= 1;
    if (slot.runningOperations !== 0) return;
    for (const resolve of slot.drainWaiters.splice(0)) resolve();
  }

  private enqueue<T>(credentialId: string, task: () => Promise<T>): Promise<T> {
    this.transitionCounts.set(credentialId, (this.transitionCounts.get(credentialId) ?? 0) + 1);
    const previous = this.queueTails.get(credentialId) ?? Promise.resolve();
    const result = previous.then(async () => {
      try {
        return await task();
      } finally {
        const remaining = (this.transitionCounts.get(credentialId) ?? 1) - 1;
        if (remaining === 0) this.transitionCounts.delete(credentialId);
        else this.transitionCounts.set(credentialId, remaining);
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queueTails.set(credentialId, tail);
    void tail.then(() => {
      if (this.queueTails.get(credentialId) === tail) this.queueTails.delete(credentialId);
    });
    return result;
  }

  private async rejectIncoming(
    connection: DeviceAuthorityConnection,
    error: unknown,
    reason: DeviceConnectionCloseReason = 'authority.rejected'
  ): Promise<never> {
    try {
      await connection.close(reason);
    } catch {
      throw closeFailure();
    }
    throw error;
  }

  private async closeRejected(connection: DeviceAuthorityConnection): Promise<void> {
    try {
      await connection.close('authority.rejected');
    } catch {
      throw closeFailure();
    }
  }
}
