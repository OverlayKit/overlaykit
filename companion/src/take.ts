import {
  PRODUCTION_TAKE_ACTION_KIND,
  type AuthorizedControlActionCatalog,
} from '@overlaykit/protocol';

/** A discovered Show-level Take action an operator binds to a single button. */
export interface CompanionTakeActionDefinition {
  readonly actionId: string;
  readonly name: string;
  readonly showId: string;
}

/**
 * The caller-supplied execution context for a Take. operationId makes the Take idempotent on retry;
 * expectedPreviewRevision is the optimistic-concurrency guard the Control API checks against the
 * current Preview revision. A runtime slice supplies both — the adapter does not invent them.
 */
export interface TakeExecution {
  readonly operationId: string;
  readonly expectedPreviewRevision: number;
}

/** A ready-to-send device Take request. */
export interface TakeCommandRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: {
    readonly operationId: string;
    readonly expectedPreviewRevision: number;
  };
}

/**
 * Project the authorized catalog's Show-level actions into Companion Take definitions. Take rides on
 * the optional showActions sibling (never the visibility `actions` array), so a catalog without the
 * production:take scope yields no Take action.
 */
export function projectCompanionTakeActions(
  catalog: AuthorizedControlActionCatalog,
): CompanionTakeActionDefinition[] {
  return (catalog.showActions ?? [])
    .filter((action) => action.kind === PRODUCTION_TAKE_ACTION_KIND)
    .map((action) => ({
      actionId: action.actionId,
      name: action.label,
      showId: action.showId,
    }));
}

/**
 * Turn a Take intent into the exact request the device Take route accepts: a body of precisely
 * { operationId, expectedPreviewRevision }, with the Show id percent-encoded in the path.
 *
 * Contract source: server/src/routes/deviceControl.ts
 * (POST /api/device/shows/:showId/production/take).
 */
export function buildTakeCommandRequest(
  showId: string,
  execution: TakeExecution,
): TakeCommandRequest {
  return {
    method: 'POST',
    path: `/api/device/shows/${encodeURIComponent(showId)}/production/take`,
    body: {
      operationId: execution.operationId,
      expectedPreviewRevision: execution.expectedPreviewRevision,
    },
  };
}
