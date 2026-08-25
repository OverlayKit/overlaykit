import type { AuthorizedControlActionCatalog } from '@overlaykit/protocol';
import type { ControlApiTransport } from './transport.js';

/** The authorized catalog fetched from the Control API, or a typed failure. */
export type CatalogResult =
  | { readonly ok: true; readonly catalog: AuthorizedControlActionCatalog }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

interface CatalogResponseBody {
  readonly data?: AuthorizedControlActionCatalog;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Fetch the authorized action catalog for a Show from the Control API
 * (GET /api/device/shows/:showId/actions) with the device Bearer credential, then hand it to
 * projectCompanionActions for discovery. Every failure mode — a network rejection, a non-JSON body,
 * or an error envelope — degrades to a typed CatalogResult, mirroring executeVisibilityCommand, so a
 * caller never has to catch. Contract source: server/src/routes/deviceControl.ts.
 */
export async function fetchAuthorizedCatalog(
  transport: ControlApiTransport,
  baseUrl: string,
  token: string,
  showId: string,
): Promise<CatalogResult> {
  let response;
  try {
    response = await transport({
      method: 'GET',
      url: `${baseUrl}/api/device/shows/${encodeURIComponent(showId)}/actions`,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message: error instanceof Error ? error.message : 'Control API unreachable',
    };
  }

  let parsed: CatalogResponseBody;
  try {
    parsed = JSON.parse(response.body) as CatalogResponseBody;
  } catch {
    return {
      ok: false,
      status: response.status,
      code: 'MALFORMED_RESPONSE',
      message: `Control API returned a non-JSON body (status ${response.status})`,
    };
  }

  if (response.status >= 200 && response.status < 300 && parsed.data) {
    return { ok: true, catalog: parsed.data };
  }
  return {
    ok: false,
    status: response.status,
    code: parsed.error?.code ?? 'UNKNOWN',
    message: parsed.error?.message ?? 'Control API request failed',
  };
}
