import { describe, expect, it } from 'vitest';
import {
  CONTROL_ACTION_CATALOG_VERSION,
  ControlActionCatalogError,
  componentVisibilityControlId,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
} from '../src/control-action-catalog';
import type { DeviceCredentialAuthority } from '../src/device-credential';

const INVENTORY: ControlActionInventory = {
  showId: 'show-1',
  capabilities: [
    {
      kind: 'component.visibility',
      target: 'program',
      componentId: 'scoreboard',
      label: 'Scoreboard',
    },
    {
      kind: 'component.visibility',
      target: 'preview',
      componentId: 'lower-third',
      label: 'Lower third',
    },
    {
      kind: 'component.visibility',
      target: 'preview',
      componentId: 'scoreboard',
      label: 'Scoreboard',
    },
  ],
};

function authority(
  overrides: Partial<DeviceCredentialAuthority> = {},
): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g4',
    generation: 4,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: 10_000,
    ...overrides,
  };
}

describe('authorized control action catalog', () => {
  it('emits only the exact available authority intersection with typed input semantics', () => {
    const catalog = projectAuthorizedControlActionCatalog(INVENTORY, authority({
      targets: ['preview'],
      controlIds: ['lower-third.visibility'],
    }));

    expect(catalog).toEqual({
      schemaVersion: CONTROL_ACTION_CATALOG_VERSION,
      showId: 'show-1',
      actions: [
        {
          actionId: 'component.visibility/preview/lower-third',
          kind: 'component.visibility',
          subject: {
            showId: 'show-1',
            target: 'preview',
            controlId: 'lower-third.visibility',
          },
          componentId: 'lower-third',
          label: 'Lower third',
          input: {
            visible: { type: 'boolean', required: true },
          },
        },
      ],
    });
  });

  it('canonicalizes output ordering without mutating inventory or authority', () => {
    const inventoryBefore = JSON.stringify(INVENTORY);
    const granted = authority({
      targets: ['program', 'preview'],
      controlIds: ['scoreboard.visibility', 'lower-third.visibility'],
    });
    const authorityBefore = JSON.stringify(granted);
    const first = projectAuthorizedControlActionCatalog(INVENTORY, granted);
    const second = projectAuthorizedControlActionCatalog({
      ...INVENTORY,
      capabilities: [...INVENTORY.capabilities].reverse(),
    }, authority({
      targets: ['preview', 'program'],
      controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
    }));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.actions.map((action) => action.actionId)).toEqual([
      'component.visibility/preview/lower-third',
      'component.visibility/preview/scoreboard',
      'component.visibility/program/scoreboard',
    ]);
    expect(JSON.stringify(INVENTORY)).toBe(inventoryBefore);
    expect(JSON.stringify(granted)).toBe(authorityBefore);
  });

  it('requires scope, target, control, and available capability simultaneously', () => {
    expect(projectAuthorizedControlActionCatalog(INVENTORY, authority({
      scopes: ['feedback:read'],
    })).actions).toEqual([]);
    expect(projectAuthorizedControlActionCatalog(INVENTORY, authority({
      targets: ['program'],
      controlIds: ['lower-third.visibility'],
    })).actions).toEqual([]);
    expect(projectAuthorizedControlActionCatalog(INVENTORY, authority({
      controlIds: ['missing.visibility'],
    })).actions).toEqual([]);
    expect(projectAuthorizedControlActionCatalog(INVENTORY, authority({
      targets: ['preview'],
      controlIds: ['scoreboard.visibility'],
    })).actions.map((action) => action.actionId)).toEqual([
      'component.visibility/preview/scoreboard',
    ]);
  });

  it('fails closed when inventory and authority name different Shows', () => {
    expect(() => projectAuthorizedControlActionCatalog(
      INVENTORY,
      authority({ showId: 'show-2' }),
    )).toThrowError(expect.objectContaining({
      code: 'AUTHORITY_SHOW_MISMATCH',
    }));
  });

  it('rejects malformed, unsupported, duplicate, and over-limit capabilities', () => {
    const invalidCapabilities = [
      [{ ...INVENTORY.capabilities[0], kind: 'production.take' }],
      [{ ...INVENTORY.capabilities[0], target: 'live' }],
      [{ ...INVENTORY.capabilities[0], componentId: ' component ' }],
      [{ ...INVENTORY.capabilities[0], label: '' }],
      [INVENTORY.capabilities[0], { ...INVENTORY.capabilities[0] }],
    ];

    for (const capabilities of invalidCapabilities) {
      expect(() => projectAuthorizedControlActionCatalog(
        { showId: 'show-1', capabilities } as ControlActionInventory,
        authority(),
      )).toThrowError(ControlActionCatalogError);
    }
    expect(() => projectAuthorizedControlActionCatalog({
      showId: 'show-1',
      capabilities: Array.from({ length: 1_001 }, (_, index) => ({
        kind: 'component.visibility' as const,
        target: 'preview' as const,
        componentId: `component-${index}`,
        label: `Component ${index}`,
      })),
    }, authority())).toThrowError(expect.objectContaining({
      code: 'INVALID_ACTION_INVENTORY',
    }));
  });

  it('rejects malformed runtime authority instead of projecting partial grants', () => {
    expect(() => projectAuthorizedControlActionCatalog(
      INVENTORY,
      { ...authority(), targets: ['preview', 'invalid'] } as DeviceCredentialAuthority,
    )).toThrowError(expect.objectContaining({
      code: 'INVALID_DEVICE_AUTHORITY',
    }));
  });

  it('exposes no credential, scope, verifier, revision, or current-state fields', () => {
    const serialized = JSON.stringify(projectAuthorizedControlActionCatalog(INVENTORY, authority()));
    for (const forbidden of [
      'credentialId',
      'audienceCredentialId',
      'generation',
      'scopes',
      'expiresAt',
      'sealedSecret',
      'revision',
      'active',
      'inactive',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('defines one canonical control identifier without accepting non-canonical component IDs', () => {
    expect(componentVisibilityControlId('lower-third')).toBe('lower-third.visibility');
    expect(() => componentVisibilityControlId(' lower-third')).toThrowError(expect.objectContaining({
      code: 'INVALID_ACTION_INVENTORY',
    }));
  });
});
