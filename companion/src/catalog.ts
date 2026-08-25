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
 * Scope note: catalog.actions models component visibility only. The Show-level Take action rides on
 * the optional catalog.showActions sibling and is projected by projectCompanionTakeActions; Scene and
 * trigger actions are not represented yet.
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
