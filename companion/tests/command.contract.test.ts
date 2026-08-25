import { describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { projectCompanionActions } from '../src/catalog';
import { buildVisibilityCommandRequest } from '../src/command';
import type { CompanionActionDefinition } from '../src/types';

// AC-018 (command half) contract: a discovered Companion action, plus the operator's toggle and the
// caller's idempotency/revision context, becomes exactly the request the device visibility route
// accepts — POST /api/device/shows/:showId/production/:target/components/:componentId/visibility with
// a body of precisely { visible, operationId, expectedRevision }
// (server/src/routes/deviceControl.ts is the contract source).

const SHOW = 'show-1';

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'cred-1',
    audienceCredentialId: 'aud-1',
    generation: 1,
    showId: SHOW,
    targets: ['preview', 'program'],
    controlIds: ['scoreboard.visibility'],
    scopes: ['component.visibility:write'],
    expiresAt: 4_102_444_800_000,
  };
}

const inventory: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'program', componentId: 'scoreboard', label: 'Scoreboard' },
  ],
};

function discover(): CompanionActionDefinition[] {
  return projectCompanionActions(projectAuthorizedControlActionCatalog(inventory, authority()));
}

describe('buildVisibilityCommandRequest (AC-018 command execution)', () => {
  it('turns a discovered Preview action into the documented Control API request', () => {
    const [previewAction] = discover();
    const request = buildVisibilityCommandRequest(
      previewAction,
      { visible: false },
      { operationId: 'op-42', expectedRevision: 7 },
    );

    expect(request).toEqual({
      method: 'POST',
      path: '/api/device/shows/show-1/production/preview/components/scoreboard/visibility',
      body: { visible: false, operationId: 'op-42', expectedRevision: 7 },
    });
  });

  it('routes to Program when the discovered action targets Program', () => {
    const programAction = discover().find((action) => action.target === 'program');
    expect(programAction).toBeDefined();
    const request = buildVisibilityCommandRequest(
      programAction as CompanionActionDefinition,
      { visible: true },
      { operationId: 'op-9', expectedRevision: 3 },
    );

    expect(request.path).toBe(
      '/api/device/shows/show-1/production/program/components/scoreboard/visibility',
    );
    expect(request.body.visible).toBe(true);
  });

  it('carries exactly the three accepted body fields', () => {
    const [action] = discover();
    const { body } = buildVisibilityCommandRequest(
      action,
      { visible: true },
      { operationId: 'op-1', expectedRevision: 0 },
    );
    // The route rejects any extra or missing key, so the adapter must send precisely these three.
    expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'operationId', 'visible']);
  });

  it('URL-encodes the Show and component route identifiers', () => {
    const action: CompanionActionDefinition = {
      actionId: 'component.visibility/preview/lower%2Fthird',
      name: 'Lower Third visibility (preview)',
      showId: 'show 1',
      target: 'preview',
      componentId: 'lower/third',
      controlId: 'lower/third.visibility',
      options: [{ id: 'visible', type: 'checkbox', label: 'Visible', default: true }],
    };
    const request = buildVisibilityCommandRequest(
      action,
      { visible: false },
      { operationId: 'op-2', expectedRevision: 1 },
    );

    expect(request.path).toBe(
      '/api/device/shows/show%201/production/preview/components/lower%2Fthird/visibility',
    );
  });
});
