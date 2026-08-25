import { describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { buildTakeCommandRequest, projectCompanionTakeActions } from '../src/take';

const SHOW = 'show-1';

function authority(overrides: Partial<DeviceCredentialAuthority> = {}): DeviceCredentialAuthority {
  return {
    credentialId: 'cred-1',
    audienceCredentialId: 'aud-1',
    generation: 1,
    showId: SHOW,
    targets: ['preview', 'program'],
    controlIds: ['scoreboard.visibility'],
    scopes: ['component.visibility:write'],
    expiresAt: 4_102_444_800_000,
    ...overrides,
  };
}

const inventory: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
  ],
};

describe('projectCompanionTakeActions (AC-017 Take discovery)', () => {
  it('surfaces a Take action only when the catalog carries showActions', () => {
    const withTake = projectAuthorizedControlActionCatalog(
      inventory,
      authority({ scopes: ['component.visibility:write', 'production:take'] }),
    );
    expect(projectCompanionTakeActions(withTake)).toEqual([
      { actionId: 'production.take/show-1', name: 'Take Preview to Program', showId: SHOW },
    ]);
  });

  it('returns nothing for a catalog without showActions', () => {
    const withoutTake = projectAuthorizedControlActionCatalog(inventory, authority());
    expect(projectCompanionTakeActions(withoutTake)).toEqual([]);
  });
});

describe('buildTakeCommandRequest (AC-018 Take execution)', () => {
  it('builds the documented device Take request', () => {
    const request = buildTakeCommandRequest(SHOW, { operationId: 'op-7', expectedPreviewRevision: 3 });
    expect(request).toEqual({
      method: 'POST',
      path: '/api/device/shows/show-1/production/take',
      body: { operationId: 'op-7', expectedPreviewRevision: 3 },
    });
  });

  it('percent-encodes the Show identifier and carries exactly the two accepted body fields', () => {
    const request = buildTakeCommandRequest('show/a b', { operationId: 'op-1', expectedPreviewRevision: 0 });
    expect(request.path).toBe('/api/device/shows/show%2Fa%20b/production/take');
    expect(Object.keys(request.body).sort()).toEqual(['expectedPreviewRevision', 'operationId']);
  });
});
