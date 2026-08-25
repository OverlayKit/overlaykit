import type { CompanionActionDefinition } from './types.js';

/** The operator's input for a visibility action — the button's on/off intent. */
export interface VisibilityCommandInput {
  readonly visible: boolean;
}

/**
 * The caller-supplied execution context. operationId makes the command idempotent on retry, and
 * expectedRevision is the optimistic-concurrency guard the Control API checks against the target's
 * current revision. The adapter does not invent these — a runtime slice supplies them.
 */
export interface CommandExecution {
  readonly operationId: string;
  readonly expectedRevision: number;
}

/** A ready-to-send Control API request: method, server-rooted path, and JSON body. */
export interface ControlApiRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: {
    readonly visible: boolean;
    readonly operationId: string;
    readonly expectedRevision: number;
  };
}

/**
 * Turn a discovered Companion action and the operator's toggle into the exact request the device
 * visibility route accepts (AC-018 command execution). The route validates each path identifier as a
 * decoded value, so the Show and component ids are percent-encoded here; the body carries precisely
 * the three fields the route accepts — any extra or missing key is rejected server-side.
 *
 * Contract source: server/src/routes/deviceControl.ts
 * (POST /api/device/shows/:showId/production/:target/components/:componentId/visibility).
 */
export function buildVisibilityCommandRequest(
  action: CompanionActionDefinition,
  input: VisibilityCommandInput,
  execution: CommandExecution,
): ControlApiRequest {
  const path = `/api/device/shows/${encodeURIComponent(action.showId)}`
    + `/production/${action.target}`
    + `/components/${encodeURIComponent(action.componentId)}/visibility`;
  return {
    method: 'POST',
    path,
    body: {
      visible: input.visible,
      operationId: execution.operationId,
      expectedRevision: execution.expectedRevision,
    },
  };
}
