import { projectCompanionActions } from './catalog.js';
import { buildVisibilityCommandRequest, type CommandExecution, type VisibilityCommandInput } from './command.js';
import { fetchAuthorizedCatalog } from './discovery.js';
import { executeVisibilityCommand, type CommandResult, type ControlApiTransport } from './transport.js';
import type { CompanionActionDefinition } from './types.js';

/** Everything the adapter needs to reach one Control API as one device: the base URL, the scoped
 *  device token, and the transport that carries requests. */
export interface CompanionAdapterConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly transport: ControlApiTransport;
}

export type DiscoverResult =
  | { readonly ok: true; readonly actions: CompanionActionDefinition[] }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/** The two calls a Companion module makes against the Control API, with the config held once. */
export interface CompanionAdapter {
  discover(showId: string): Promise<DiscoverResult>;
  execute(
    action: CompanionActionDefinition,
    input: VisibilityCommandInput,
    execution: CommandExecution,
  ): Promise<CommandResult>;
}

/**
 * Compose the adapter's pieces into the object a Companion module instantiates. discover fetches the
 * authorized catalog and projects it into actions; execute builds the visibility command and
 * dispatches it. Both reuse the held baseUrl, token, and transport, and both surface the underlying
 * typed failures unchanged — the facade adds no error handling of its own. Feedback stays a pure
 * function (projectCompanionFeedback) since it needs no config.
 */
export function createCompanionAdapter(config: CompanionAdapterConfig): CompanionAdapter {
  return {
    async discover(showId) {
      const result = await fetchAuthorizedCatalog(config.transport, config.baseUrl, config.token, showId);
      if (!result.ok) return result;
      return { ok: true, actions: projectCompanionActions(result.catalog) };
    },
    async execute(action, input, execution) {
      const request = buildVisibilityCommandRequest(action, input, execution);
      return executeVisibilityCommand(config.transport, config.baseUrl, config.token, request);
    },
  };
}
