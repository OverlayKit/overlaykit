import { describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { createCompanionAdapter } from '../src/adapter';
import { projectCompanionActions } from '../src/catalog';
import type { ControlApiHttpRequest } from '../src/transport';

// The facade holds one { baseUrl, token, transport } and turns the pieces into the two calls a
// Companion module makes: discover (fetch catalog then project) and execute (build then dispatch).

const SHOW = 'show-1';

const AUTHORITY: DeviceCredentialAuthority = {
  credentialId: 'cred-1',
  audienceCredentialId: 'aud-1',
  generation: 1,
  showId: SHOW,
  targets: ['preview'],
  controlIds: ['scoreboard.visibility'],
  scopes: ['component.visibility:write'],
  expiresAt: 4_102_444_800_000,
};

const INVENTORY: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
  ],
};

const CATALOG = projectAuthorizedControlActionCatalog(INVENTORY, AUTHORITY);
const APPLIED_COMMAND = {
  status: 'applied',
  resultCode: 'APPLIED',
  globalSequence: 5,
  operationId: 'op-1',
  intentHash: 'sha256:a',
  authorityGeneration: 1,
  expectedRevision: 5,
  previousRevision: 5,
  resultingRevision: 6,
  resultingSnapshotHash: 'sha256:b',
  committedAt: 1_700_000_000_000,
  replayed: false,
};

const CONFIG = { baseUrl: 'http://ctrl:4000', token: 'ok_device_secret' } as const;

describe('createCompanionAdapter', () => {
  it('discover fetches the catalog then projects it, using the configured base URL and token', async () => {
    let sent: ControlApiHttpRequest | undefined;
    const adapter = createCompanionAdapter({
      ...CONFIG,
      transport: async (request) => {
        sent = request;
        return { status: 200, body: JSON.stringify({ data: CATALOG }) };
      },
    });

    const result = await adapter.discover(SHOW);

    expect(sent).toMatchObject({
      method: 'GET',
      url: 'http://ctrl:4000/api/device/shows/show-1/actions',
      headers: { Authorization: 'Bearer ok_device_secret' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actions).toEqual(projectCompanionActions(CATALOG));
    }
  });

  it('discover passes a fetch failure through unchanged', async () => {
    const adapter = createCompanionAdapter({
      ...CONFIG,
      transport: async () => ({
        status: 403,
        body: JSON.stringify({ error: { code: 'DEVICE_AUTH_FORBIDDEN', message: 'Wrong Show' } }),
      }),
    });

    const result = await adapter.discover(SHOW);
    expect(result).toEqual({ ok: false, status: 403, code: 'DEVICE_AUTH_FORBIDDEN', message: 'Wrong Show' });
  });

  it('execute builds the command then dispatches it with the configured base URL and token', async () => {
    let sent: ControlApiHttpRequest | undefined;
    const adapter = createCompanionAdapter({
      ...CONFIG,
      transport: async (request) => {
        sent = request;
        return { status: 200, body: JSON.stringify({ data: { receipt: {}, command: APPLIED_COMMAND, state: {} } }) };
      },
    });
    const [action] = projectCompanionActions(CATALOG);

    const result = await adapter.execute(action, { visible: false }, { operationId: 'op-1', expectedRevision: 5 });

    expect(sent).toEqual({
      method: 'POST',
      url: 'http://ctrl:4000/api/device/shows/show-1/production/preview/components/scoreboard/visibility',
      headers: { Authorization: 'Bearer ok_device_secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible: false, operationId: 'op-1', expectedRevision: 5 }),
    });
    expect(result).toEqual({ ok: true, outcome: APPLIED_COMMAND });
  });
});
