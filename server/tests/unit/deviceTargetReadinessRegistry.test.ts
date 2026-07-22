import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import { describe, expect, it } from 'vitest';
import { DeviceTargetReadinessRegistry } from '../../src/services/DeviceTargetReadinessRegistry';

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: 60_000,
  };
}

describe('DeviceTargetReadinessRegistry', () => {
  it('suspends prior evidence and prevents its stale lease from resurrecting authority', () => {
    const registry = new DeviceTargetReadinessRegistry();
    const prior = registry.register(authority());
    expect(registry.isReady(authority(), 'preview')).toBe(true);

    registry.suspend(authority());
    expect(registry.isReady(authority(), 'preview')).toBe(false);
    prior.set('preview', true);
    expect(registry.isReady(authority(), 'preview')).toBe(false);

    const replacement = registry.register(authority());
    prior.close();
    expect(registry.isReady(authority(), 'preview')).toBe(true);
    replacement.set('preview', false);
    expect(registry.isReady(authority(), 'preview')).toBe(false);
    expect(registry.isReady(authority(), 'program')).toBe(true);
    replacement.close();
    expect(registry.isReady(authority(), 'program')).toBe(false);
  });
});
