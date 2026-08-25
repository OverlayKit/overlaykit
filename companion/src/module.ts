import type { VisibilityCommandInput } from './command.js';
import type { CommandResult } from './transport.js';
import type { CompanionActionDefinition, CompanionActionOption } from './types.js';

/**
 * The vendor-neutral core of a Bitfocus Companion module: the connection config and the action
 * definitions. It carries no dependency on @companion-module/base — a thin InstanceBase wrapper
 * registers COMPANION_CONFIG_FIELDS as its config fields and the output of
 * buildCompanionActionDefinitions as its actions, and supplies the `run` seam (operationId, expected
 * revision, and the CompanionAdapter) that this core deliberately does not own.
 */

/** The operator-supplied connection settings a Companion module instance needs. */
export interface CompanionModuleConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly showId: string;
}

/** One connection config field, in Companion's field shape but without importing its SDK types. */
export interface CompanionConfigField {
  readonly id: keyof CompanionModuleConfig;
  readonly type: 'textinput';
  readonly label: string;
  readonly required: true;
}

export const COMPANION_CONFIG_FIELDS: readonly CompanionConfigField[] = [
  { id: 'baseUrl', type: 'textinput', label: 'Control API base URL', required: true },
  { id: 'token', type: 'textinput', label: 'Device token', required: true },
  { id: 'showId', type: 'textinput', label: 'Show ID', required: true },
];

export type ModuleConfigResult =
  | { readonly ok: true; readonly config: CompanionModuleConfig }
  | { readonly ok: false; readonly missing: readonly (keyof CompanionModuleConfig)[] };

/**
 * Validate the raw config an operator entered into the module's fields. Every field is required and
 * whitespace-trimmed; the result reports all missing fields at once rather than a partial config, so
 * the wrapper can surface a single actionable message before it builds an adapter.
 */
export function parseModuleConfig(
  raw: Partial<Record<keyof CompanionModuleConfig, unknown>>,
): ModuleConfigResult {
  const read = (key: keyof CompanionModuleConfig): string => {
    const value = raw[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const config = { baseUrl: read('baseUrl'), token: read('token'), showId: read('showId') };
  const missing = (Object.keys(config) as (keyof CompanionModuleConfig)[]).filter((key) => config[key] === '');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config };
}

/** One Companion action definition: what the operator sees and does with a button. */
export interface CompanionActionModuleDefinition {
  readonly name: string;
  readonly options: readonly CompanionActionOption[];
  readonly callback: (options: Record<string, unknown>) => Promise<CommandResult>;
}

/**
 * Build the action definitions a Companion module registers from the discovered actions, keyed by
 * actionId. Pressing a button runs the injected command for that action with the button's visible
 * option coerced to a boolean; the `run` seam owns the operationId, the expected revision, and the
 * adapter, so this core stays free of runtime state and of the SDK.
 */
export function buildCompanionActionDefinitions(
  actions: readonly CompanionActionDefinition[],
  run: (action: CompanionActionDefinition, input: VisibilityCommandInput) => Promise<CommandResult>,
): Record<string, CompanionActionModuleDefinition> {
  const definitions: Record<string, CompanionActionModuleDefinition> = {};
  for (const action of actions) {
    definitions[action.actionId] = {
      name: action.name,
      options: action.options,
      callback: (options) => run(action, { visible: options.visible === true }),
    };
  }
  return definitions;
}
