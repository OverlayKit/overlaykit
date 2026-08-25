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
  const response = await transport({
    method: request.method,
    url: `${baseUrl}${request.path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request.body),
  });

  const parsed = JSON.parse(response.body) as VisibilityResponseBody;
  if (response.status >= 200 && response.status < 300 && parsed.data) {
    return { ok: true, outcome: parsed.data.command };
  }
  return {
    ok: false,
    status: response.status,
    code: parsed.error?.code ?? 'UNKNOWN',
    message: parsed.error?.message ?? 'Control API request failed',
  };
}
