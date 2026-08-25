import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { projectCompanionActions } from '../src/catalog';
import { fetchAuthorizedCatalog } from '../src/discovery';
import { createFetchTransport } from '../src/transport';

// AC-017 over HTTP: the adapter fetches the authorized catalog from the device route
// (GET /api/device/shows/:showId/actions -> { data: catalog }) and can then project it into actions.

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

describe('fetchAuthorizedCatalog (AC-017 discovery over HTTP)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('fetches the authorized catalog over HTTP and projects it to actions', async () => {
    let received: Record<string, unknown> | undefined;
    const baseUrl = await listen((req, res) => {
      received = { method: req.method, url: req.url, authorization: req.headers.authorization };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: CATALOG }));
    });

    const result = await fetchAuthorizedCatalog(createFetchTransport(fetch), baseUrl, 'ok_device_secret', SHOW);

    expect(received).toEqual({
      method: 'GET',
      url: '/api/device/shows/show-1/actions',
      authorization: 'Bearer ok_device_secret',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(projectCompanionActions(result.catalog).map((a) => a.actionId)).toEqual([
        'component.visibility/preview/scoreboard',
      ]);
    }
  });

  it('surfaces an authorization failure as a typed result', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'DEVICE_AUTH_FORBIDDEN', message: 'Wrong Show' } }));
    });

    const result = await fetchAuthorizedCatalog(createFetchTransport(fetch), baseUrl, 'tok', SHOW);
    expect(result).toEqual({ ok: false, status: 403, code: 'DEVICE_AUTH_FORBIDDEN', message: 'Wrong Show' });
  });

  it('degrades a non-JSON body and a network rejection to typed failures', async () => {
    const nonJson = await fetchAuthorizedCatalog(
      async () => ({ status: 502, body: '<html>bad gateway</html>' }),
      'http://127.0.0.1:4000',
      'tok',
      SHOW,
    );
    expect(nonJson).toMatchObject({ ok: false, status: 502, code: 'MALFORMED_RESPONSE' });

    const rejected = await fetchAuthorizedCatalog(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      'http://127.0.0.1:4000',
      'tok',
      SHOW,
    );
    expect(rejected).toMatchObject({ ok: false, status: 0, code: 'NETWORK_ERROR' });
  });

  it('percent-encodes the Show identifier in the path', async () => {
    let path: string | undefined;
    const result = await fetchAuthorizedCatalog(
      async (request) => {
        path = request.url;
        return { status: 200, body: JSON.stringify({ data: CATALOG }) };
      },
      'http://host',
      'tok',
      'show/a b',
    );
    expect(path).toBe('http://host/api/device/shows/show%2Fa%20b/actions');
    expect(result.ok).toBe(true);
  });
});
