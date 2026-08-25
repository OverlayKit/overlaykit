import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVisibilityCommandRequest } from '../src/command';
import { createFetchTransport, executeVisibilityCommand } from '../src/transport';
import type { CompanionActionDefinition } from '../src/types';

// A real HTTP round-trip: the fetch-backed transport issues an actual request to a local server and
// executeVisibilityCommand interprets the real response. This proves the adapter can talk to a
// Control API over HTTP, not just to an injected stub.

const ACTION: CompanionActionDefinition = {
  actionId: 'component.visibility/preview/scoreboard',
  name: 'Scoreboard visibility (preview)',
  showId: 'show-1',
  target: 'preview',
  componentId: 'scoreboard',
  controlId: 'scoreboard.visibility',
  options: [{ id: 'visible', type: 'checkbox', label: 'Visible', default: true }],
};

const APPLIED_COMMAND = {
  status: 'applied',
  resultCode: 'APPLIED',
  globalSequence: 12,
  operationId: 'op-42',
  intentHash: 'sha256:abc',
  authorityGeneration: 1,
  expectedRevision: 7,
  previousRevision: 7,
  resultingRevision: 8,
  resultingSnapshotHash: 'sha256:def',
  committedAt: 1_700_000_000_000,
  replayed: false,
};

describe('createFetchTransport (real HTTP round-trip)', () => {
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

  it('sends the built request over HTTP and returns the applied outcome', async () => {
    let received: Record<string, unknown> | undefined;
    const baseUrl = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          body,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { receipt: {}, command: APPLIED_COMMAND, state: {} } }));
      });
    });

    const request = buildVisibilityCommandRequest(
      ACTION,
      { visible: false },
      { operationId: 'op-42', expectedRevision: 7 },
    );
    const result = await executeVisibilityCommand(
      createFetchTransport(fetch),
      baseUrl,
      'ok_device_secret',
      request,
    );

    expect(received).toEqual({
      method: 'POST',
      url: '/api/device/shows/show-1/production/preview/components/scoreboard/visibility',
      authorization: 'Bearer ok_device_secret',
      contentType: 'application/json',
      body: JSON.stringify({ visible: false, operationId: 'op-42', expectedRevision: 7 }),
    });
    expect(result).toEqual({ ok: true, outcome: APPLIED_COMMAND });
  });

  it('maps a Control API error status to a typed failure', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'TARGET_REVISION_CONFLICT', message: 'Preview changed' } }));
    });

    const request = buildVisibilityCommandRequest(
      ACTION,
      { visible: true },
      { operationId: 'op-9', expectedRevision: 2 },
    );
    const result = await executeVisibilityCommand(createFetchTransport(fetch), baseUrl, 'tok', request);

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'TARGET_REVISION_CONFLICT',
      message: 'Preview changed',
    });
  });

  it('turns a refused connection into a typed NETWORK_ERROR failure', async () => {
    // Bind a server, capture its port, then close it — that port now refuses connections.
    const baseUrl = await listen(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const request = buildVisibilityCommandRequest(
      ACTION,
      { visible: false },
      { operationId: 'op-x', expectedRevision: 1 },
    );
    const result = await executeVisibilityCommand(createFetchTransport(fetch), baseUrl, 'tok', request);

    expect(result).toMatchObject({ ok: false, status: 0, code: 'NETWORK_ERROR' });
  });
});
