import { describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { projectCompanionActions } from '../src/catalog';

// AC-017 contract: the adapter discovers actions from the *real* Control API catalog. The catalog
// here is built by the protocol package's own projector — the exact projection the server exposes to
// a device — so this test runs against the shared authorized-catalog contract, not a hand-faked shape.

const SHOW = 'show-1';

function authority(overrides: Partial<DeviceCredentialAuthority> = {}): DeviceCredentialAuthority {
  return {
    credentialId: 'cred-1',
    audienceCredentialId: 'aud-1',
    generation: 1,
    showId: SHOW,
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility', 'scoreboard.visibility'],
    scopes: ['component.visibility:write'],
    expiresAt: 4_102_444_800_000,
    ...overrides,
  };
}

const inventory: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'program', componentId: 'scoreboard', label: 'Scoreboard' },
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'lower-third', label: 'Lower Third' },
  ],
};

describe('projectCompanionActions (AC-017 action discovery)', () => {
  it('surfaces every authorized visibility action in catalog order', () => {
    const catalog = projectAuthorizedControlActionCatalog(inventory, authority());
    const actions = projectCompanionActions(catalog);

    // Preview before Program, then controlId ascending — the catalog's own order is preserved.
    expect(actions.map((action) => action.actionId)).toEqual([
      'component.visibility/preview/lower-third',
      'component.visibility/preview/scoreboard',
      'component.visibility/program/scoreboard',
    ]);
    expect(actions.map((action) => action.name)).toEqual([
      'Lower Third visibility (preview)',
      'Scoreboard visibility (preview)',
      'Scoreboard visibility (program)',
    ]);
  });

  it('carries the routing coordinates and a single visible toggle per action', () => {
    const catalog = projectAuthorizedControlActionCatalog(inventory, authority());
    const [previewLowerThird] = projectCompanionActions(catalog);

    expect(previewLowerThird).toMatchObject({
      showId: SHOW,
      target: 'preview',
      componentId: 'lower-third',
      controlId: 'lower-third.visibility',
      options: [{ id: 'visible', type: 'checkbox', label: 'Visible', default: true }],
    });
  });

  it('lists only what the device token is authorized for (least privilege)', () => {
    // A token scoped to Preview and only the scoreboard control must not surface the rest.
    const catalog = projectAuthorizedControlActionCatalog(
      inventory,
      authority({ targets: ['preview'], controlIds: ['scoreboard.visibility'] }),
    );
    const actions = projectCompanionActions(catalog);

    expect(actions.map((action) => action.actionId)).toEqual([
      'component.visibility/preview/scoreboard',
    ]);
  });

  it('returns nothing when the token lacks the visibility write scope', () => {
    const catalog = projectAuthorizedControlActionCatalog(inventory, authority({ scopes: [] }));
    expect(projectCompanionActions(catalog)).toEqual([]);
  });
});
