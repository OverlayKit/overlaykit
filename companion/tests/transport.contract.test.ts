import { describe, expect, it } from 'vitest';
import { buildVisibilityCommandRequest } from '../src/command';
import { executeVisibilityCommand, type ControlApiHttpRequest } from '../src/transport';
import type { CompanionActionDefinition } from '../src/types';

// AC-018 (command dispatch) contract: the executor sends the built request to the Control API with a
// Bearer credential and translates the response envelope into a typed outcome. The transport is
// injected so this proves the HTTP wiring without a live server (server/src/routes/deviceControl.ts
// returns { data: { receipt, command, state } } on success and { error: { code, message } } on error).

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

describe('executeVisibilityCommand (AC-018 command dispatch)', () => {
  it('dispatches the built request with Bearer auth and returns the command outcome', async () => {
    const request = buildVisibilityCommandRequest(
      ACTION,
      { visible: false },
      { operationId: 'op-42', expectedRevision: 7 },
    );

    let sent: ControlApiHttpRequest | undefined;
    const result = await executeVisibilityCommand(
      async (httpRequest) => {
        sent = httpRequest;
        return {
          status: 200,
          body: JSON.stringify({ data: { receipt: {}, command: APPLIED_COMMAND, state: {} } }),
        };
      },
      'http://127.0.0.1:4000',
      'ok_device_secret',
      request,
    );

    expect(sent).toEqual({
      method: 'POST',
      url: 'http://127.0.0.1:4000/api/device/shows/show-1/production/preview/components/scoreboard/visibility',
      headers: {
        Authorization: 'Bearer ok_device_secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ visible: false, operationId: 'op-42', expectedRevision: 7 }),
    });
    expect(result).toEqual({ ok: true, outcome: APPLIED_COMMAND });
  });

  it('surfaces a Control API error response as a typed failure', async () => {
    const request = buildVisibilityCommandRequest(
      ACTION,
      { visible: true },
      { operationId: 'op-9', expectedRevision: 2 },
    );

    const result = await executeVisibilityCommand(
      async () => ({
        status: 409,
        body: JSON.stringify({
          error: { code: 'TARGET_REVISION_CONFLICT', message: 'Preview changed before the command' },
        }),
      }),
      'http://127.0.0.1:4000',
      'ok_device_secret',
      request,
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      code: 'TARGET_REVISION_CONFLICT',
      message: 'Preview changed before the command',
    });
  });

  const REQUEST = buildVisibilityCommandRequest(
    ACTION,
    { visible: true },
    { operationId: 'op-1', expectedRevision: 0 },
  );

  it('degrades a non-JSON body (proxy/gateway error page) to a typed failure instead of throwing', async () => {
    const result = await executeVisibilityCommand(
      async () => ({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' }),
      'http://127.0.0.1:4000',
      'tok',
      REQUEST,
    );
    expect(result).toEqual({
      ok: false,
      status: 502,
      code: 'MALFORMED_RESPONSE',
      message: 'Control API returned a non-JSON body (status 502)',
    });
  });

  it('degrades an empty body to a typed failure', async () => {
    const result = await executeVisibilityCommand(
      async () => ({ status: 504, body: '' }),
      'http://127.0.0.1:4000',
      'tok',
      REQUEST,
    );
    expect(result).toMatchObject({ ok: false, status: 504, code: 'MALFORMED_RESPONSE' });
  });

  it('converts a transport (network) rejection into a typed failure', async () => {
    const result = await executeVisibilityCommand(
      async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
      },
      'http://127.0.0.1:4000',
      'tok',
      REQUEST,
    );
    expect(result).toEqual({
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'connect ECONNREFUSED 127.0.0.1:4000',
    });
  });

  it('treats a 2xx envelope without a command as a failure, never { ok: true, outcome: undefined }', async () => {
    const result = await executeVisibilityCommand(
      async () => ({ status: 200, body: JSON.stringify({ data: { receipt: {}, state: {} } }) }),
      'http://127.0.0.1:4000',
      'tok',
      REQUEST,
    );
    expect(result).toMatchObject({ ok: false, status: 200 });
  });

  it('falls back to a default code and message when a non-2xx body omits the error object', async () => {
    const result = await executeVisibilityCommand(
      async () => ({ status: 500, body: '{}' }),
      'http://127.0.0.1:4000',
      'tok',
      REQUEST,
    );
    expect(result).toEqual({
      ok: false,
      status: 500,
      code: 'UNKNOWN',
      message: 'Control API request failed',
    });
  });
});
