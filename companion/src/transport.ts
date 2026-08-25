import type { ProductionCommandOutcome } from '@overlaykit/protocol';
import type { ControlApiRequest } from './command.js';

/** One outgoing HTTP call, fully materialized. Injecting this keeps the adapter testable and free of
 *  any particular HTTP client — a runtime slice supplies a fetch-backed implementation. */
export interface ControlApiHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ControlApiHttpResponse {
  readonly status: number;
  readonly body: string;
}

export type ControlApiTransport = (
  request: ControlApiHttpRequest,
) => Promise<ControlApiHttpResponse>;

/**
 * The subset of the global fetch function the adapter uses, declared structurally so the package
 * needs no DOM or Node fetch type dependency. A runtime slice passes the platform fetch.
 */
export interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ readonly status: number; text(): Promise<string> }>;
}

/**
 * Back a ControlApiTransport with a fetch implementation. The response body is read as text and left
 * unparsed here; executeVisibilityCommand owns interpreting the envelope, so a non-JSON body from a
 * proxy or gateway does not throw inside the transport.
 */
export function createFetchTransport(fetchImpl: FetchLike): ControlApiTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    });
    return { status: response.status, body: await response.text() };
  };
}

/** The command applied (or was replayed / rejected) — the server's ProductionCommandOutcome. */
export interface CommandSuccess {
  readonly ok: true;
  readonly outcome: ProductionCommandOutcome;
}

/** The Control API refused the command; the operator-facing code and message are preserved. */
export interface CommandFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type CommandResult = CommandSuccess | CommandFailure;

interface VisibilityResponseBody {
  readonly data?: { readonly command: ProductionCommandOutcome };
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Send a built visibility command to the Control API and translate the response into a typed result.
 * The scoped device token is carried as a Bearer credential (the only auth the device route accepts),
 * and the server's { data: { command } } envelope becomes a CommandSuccess while an { error } body — or
 * any non-2xx status — becomes a CommandFailure. This dispatches and interprets; it does not retry.
 */
export async function executeVisibilityCommand(
  transport: ControlApiTransport,
  baseUrl: string,
  token: string,
  request: ControlApiRequest,
): Promise<CommandResult> {
  // A transport-level failure (host down, DNS, connection refused) is a CommandFailure, not a throw —
  // every failure mode the caller switches on must arrive as a typed result.
  let response: ControlApiHttpResponse;
  try {
    response = await transport({
      method: request.method,
      url: `${baseUrl}${request.path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message: error instanceof Error ? error.message : 'Control API unreachable',
    };
  }

  // A non-JSON or empty body — a proxy/gateway error page, a dropped connection — degrades to a typed
  // failure carrying the real status, honoring the proxy-safe contract instead of throwing a SyntaxError.
  let parsed: VisibilityResponseBody;
  try {
    parsed = JSON.parse(response.body) as VisibilityResponseBody;
  } catch {
    return {
      ok: false,
      status: response.status,
      code: 'MALFORMED_RESPONSE',
      message: `Control API returned a non-JSON body (status ${response.status})`,
    };
  }

  // Success requires both a 2xx status and an actual command in the envelope; a 2xx without a command
  // is a malformed success, not an { ok: true, outcome: undefined }.
  if (response.status >= 200 && response.status < 300 && parsed.data?.command) {
    return { ok: true, outcome: parsed.data.command };
  }
  return {
    ok: false,
    status: response.status,
    code: parsed.error?.code ?? 'UNKNOWN',
    message: parsed.error?.message ?? 'Control API request failed',
  };
}
