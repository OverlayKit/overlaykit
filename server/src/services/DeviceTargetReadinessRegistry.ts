import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import type { ProductionBus } from '@overlaykit/protocol/production' with {
  'resolution-mode': 'import',
};

export interface DeviceTargetReadinessPort {
  isReady(authority: DeviceCredentialAuthority, target: ProductionBus): boolean;
}

export interface DeviceTargetReadinessLease {
  set(target: ProductionBus, ready: boolean): void;
  close(): void;
}

interface ReadinessEntry {
  readonly token: symbol;
  readonly showId: string;
  readonly generation: number;
  readonly targets: Map<ProductionBus, boolean>;
}

function validAuthority(authority: DeviceCredentialAuthority): boolean {
  return Boolean(
    authority
    && typeof authority === 'object'
    && typeof authority.audienceCredentialId === 'string'
    && authority.audienceCredentialId.length > 0
    && typeof authority.showId === 'string'
    && authority.showId.length > 0
    && Number.isSafeInteger(authority.generation)
    && authority.generation > 0
    && Array.isArray(authority.targets)
    && authority.targets.length > 0
    && authority.targets.every((target) => target === 'preview' || target === 'program')
  );
}

export class DeviceTargetReadinessRegistry implements DeviceTargetReadinessPort {
  private readonly entries = new Map<string, ReadinessEntry>();

  suspend(authority: DeviceCredentialAuthority): void {
    if (!validAuthority(authority)) {
      throw new Error('Device target readiness authority is invalid');
    }
    const current = this.entries.get(authority.audienceCredentialId);
    if (
      current
      && current.showId === authority.showId
      && current.generation === authority.generation
    ) {
      this.entries.delete(authority.audienceCredentialId);
    }
  }

  register(authority: DeviceCredentialAuthority): DeviceTargetReadinessLease {
    if (!validAuthority(authority)) {
      throw new Error('Device target readiness authority is invalid');
    }
    const token = Symbol(authority.audienceCredentialId);
    const entry: ReadinessEntry = {
      token,
      showId: authority.showId,
      generation: authority.generation,
      targets: new Map(authority.targets.map((target) => [target, true])),
    };
    this.entries.set(authority.audienceCredentialId, entry);
    let closed = false;
    return Object.freeze({
      set: (target: ProductionBus, ready: boolean): void => {
        if (closed || this.entries.get(authority.audienceCredentialId)?.token !== token) return;
        if (!entry.targets.has(target) || typeof ready !== 'boolean') {
          throw new Error('Device target readiness update is invalid');
        }
        entry.targets.set(target, ready);
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        if (this.entries.get(authority.audienceCredentialId)?.token === token) {
          this.entries.delete(authority.audienceCredentialId);
        }
      },
    });
  }

  isReady(authority: DeviceCredentialAuthority, target: ProductionBus): boolean {
    if (!validAuthority(authority) || (target !== 'preview' && target !== 'program')) return false;
    const entry = this.entries.get(authority.audienceCredentialId);
    return Boolean(
      entry
      && entry.showId === authority.showId
      && entry.generation === authority.generation
      && entry.targets.get(target) === true
    );
  }
}
