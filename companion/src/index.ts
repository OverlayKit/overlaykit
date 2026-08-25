export type { CompanionActionDefinition, CompanionActionOption } from './types.js';
export { projectCompanionActions } from './catalog.js';
export type { CompanionAdapter, CompanionAdapterConfig, DiscoverResult } from './adapter.js';
export { createCompanionAdapter } from './adapter.js';
export type {
  CompanionActionModuleDefinition,
  CompanionConfigField,
  CompanionModuleConfig,
  ModuleConfigResult,
} from './module.js';
export {
  COMPANION_CONFIG_FIELDS,
  buildCompanionActionDefinitions,
  parseModuleConfig,
} from './module.js';
export type { CatalogResult } from './discovery.js';
export { fetchAuthorizedCatalog } from './discovery.js';
export type { CommandExecution, ControlApiRequest, VisibilityCommandInput } from './command.js';
export { buildVisibilityCommandRequest } from './command.js';
export type {
  CommandFailure,
  CommandResult,
  CommandSuccess,
  ControlApiHttpRequest,
  ControlApiHttpResponse,
  ControlApiTransport,
  FetchLike,
} from './transport.js';
export { createFetchTransport, executeVisibilityCommand } from './transport.js';
export type { CompanionFeedbackState } from './feedback.js';
export { projectCompanionFeedback } from './feedback.js';
