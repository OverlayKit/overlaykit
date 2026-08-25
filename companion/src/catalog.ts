import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  type AuthorizedControlActionCatalog,
} from '@overlaykit/protocol';
import type { CompanionActionDefinition } from './types.js';

/**
 * Project an authorized Control API action catalog into the Companion action definitions an operator
 * browses on their controller (AC-017: "action discovery from the Control API catalog").
 *
 * The catalog is already the authority intersection produced by the server — it lists only the
 * actions this device token may execute for its Show (ADR-0015/ADR-0016). This projection is a pure,
 * total mapping of that authorized surface into a vendor-neutral definition; it grants nothing and
 * assumes nothing beyond what the catalog already declares.
 *
 * Scope note: the device action catalog models component visibility only. Take, Scene activation, and
 * trigger actions named by AC-017 are not represented in the catalog yet, so they cannot appear here;
 * exposing them requires a core catalog extension tracked separately.
 */
export function projectCompanionActions(
  catalog: AuthorizedControlActionCatalog,
): CompanionActionDefinition[] {
  return catalog.actions
    .filter((action) => action.kind === COMPONENT_VISIBILITY_ACTION_KIND)
    .map((action) => ({
      actionId: action.actionId,
      name: `${action.label} visibility (${action.subject.target})`,
      showId: action.subject.showId,
      target: action.subject.target,
      componentId: action.componentId,
      controlId: action.subject.controlId,
      options: [
        {
          id: 'visible',
          type: 'checkbox' as const,
          label: 'Visible',
          default: true,
        },
      ],
    }));
}
