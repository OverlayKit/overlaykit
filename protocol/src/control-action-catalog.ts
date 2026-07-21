import type { ControlFeedbackSubject } from './control-feedback.js';
import type { DeviceCredentialAuthority } from './device-credential.js';
import type { ProductionBus } from './production.js';

export const CONTROL_ACTION_CATALOG_VERSION = 'overlaykit-control-action-catalog/v1' as const;
export const COMPONENT_VISIBILITY_ACTION_KIND = 'component.visibility' as const;

const COMPONENT_VISIBILITY_SCOPE = 'component.visibility:write' as const;
const MAX_SHOW_ID_LENGTH = 200;
const MAX_COMPONENT_ID_LENGTH = 100;
const MAX_LABEL_LENGTH = 160;
const MAX_CAPABILITIES = 1_000;
const TARGET_ORDER: ReadonlyArray<ProductionBus> = ['preview', 'program'];

export interface ComponentVisibilityCapability {
  readonly kind: typeof COMPONENT_VISIBILITY_ACTION_KIND;
  readonly target: ProductionBus;
  readonly componentId: string;
  readonly label: string;
}

export interface ControlActionInventory {
  readonly showId: string;
  readonly capabilities: ReadonlyArray<ComponentVisibilityCapability>;
}

export interface BooleanVisibilityInputDefinition {
  readonly visible: {
    readonly type: 'boolean';
    readonly required: true;
  };
}

export interface ComponentVisibilityActionDescriptor {
  readonly actionId: string;
  readonly kind: typeof COMPONENT_VISIBILITY_ACTION_KIND;
  readonly subject: ControlFeedbackSubject;
  readonly componentId: string;
  readonly label: string;
  readonly input: BooleanVisibilityInputDefinition;
}

export interface AuthorizedControlActionCatalog {
  readonly schemaVersion: typeof CONTROL_ACTION_CATALOG_VERSION;
  readonly showId: string;
  readonly actions: ReadonlyArray<ComponentVisibilityActionDescriptor>;
}

export type ControlActionCatalogErrorCode =
  | 'INVALID_ACTION_INVENTORY'
  | 'DUPLICATE_ACTION_CAPABILITY'
  | 'INVALID_DEVICE_AUTHORITY'
  | 'AUTHORITY_SHOW_MISMATCH';

export class ControlActionCatalogError extends Error {
  constructor(
    public readonly code: ControlActionCatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function requiredIdentifier(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
  ) {
    throw new ControlActionCatalogError(
      'INVALID_ACTION_INVENTORY',
      `${field} is invalid`,
    );
  }
  return value;
}

function requiredLabel(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_LABEL_LENGTH
    || value !== value.trim()
  ) {
    throw new ControlActionCatalogError('INVALID_ACTION_INVENTORY', 'Capability label is invalid');
  }
  return value;
}

function requiredTarget(value: unknown): ProductionBus {
  if (value !== 'preview' && value !== 'program') {
    throw new ControlActionCatalogError('INVALID_ACTION_INVENTORY', 'Capability target is invalid');
  }
  return value;
}

function normalizedAuthority(authority: DeviceCredentialAuthority): {
  showId: string;
  targets: Set<ProductionBus>;
  controlIds: Set<string>;
  canWriteVisibility: boolean;
} {
  if (
    !authority
    || typeof authority !== 'object'
    || typeof authority.showId !== 'string'
    || !Array.isArray(authority.targets)
    || !Array.isArray(authority.controlIds)
    || !Array.isArray(authority.scopes)
    || authority.targets.some((target) => target !== 'preview' && target !== 'program')
    || authority.controlIds.some((controlId) => typeof controlId !== 'string')
  ) {
    throw new ControlActionCatalogError('INVALID_DEVICE_AUTHORITY', 'Device authority is invalid');
  }
  return {
    showId: authority.showId,
    targets: new Set(authority.targets),
    controlIds: new Set(authority.controlIds),
    canWriteVisibility: authority.scopes.includes(COMPONENT_VISIBILITY_SCOPE),
  };
}

export function componentVisibilityControlId(componentId: string): string {
  return `${requiredIdentifier(
    componentId,
    'Component identifier',
    MAX_COMPONENT_ID_LENGTH,
  )}.visibility`;
}

function actionId(target: ProductionBus, componentId: string): string {
  return `${COMPONENT_VISIBILITY_ACTION_KIND}/${target}/${encodeURIComponent(componentId)}`;
}

function targetRank(target: ProductionBus): number {
  return TARGET_ORDER.indexOf(target);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function projectAuthorizedControlActionCatalog(
  inventory: ControlActionInventory,
  authority: DeviceCredentialAuthority,
): AuthorizedControlActionCatalog {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.capabilities)) {
    throw new ControlActionCatalogError('INVALID_ACTION_INVENTORY', 'Action inventory is invalid');
  }
  const showId = requiredIdentifier(inventory.showId, 'Show identifier', MAX_SHOW_ID_LENGTH);
  if (inventory.capabilities.length > MAX_CAPABILITIES) {
    throw new ControlActionCatalogError('INVALID_ACTION_INVENTORY', 'Action inventory is too large');
  }

  const capabilities: Array<ComponentVisibilityCapability & { controlId: string }> = [];
  const identities = new Set<string>();
  for (const capability of inventory.capabilities) {
    if (!capability || typeof capability !== 'object' || capability.kind !== COMPONENT_VISIBILITY_ACTION_KIND) {
      throw new ControlActionCatalogError('INVALID_ACTION_INVENTORY', 'Action capability is unsupported');
    }
    const target = requiredTarget(capability.target);
    const componentId = requiredIdentifier(
      capability.componentId,
      'Component identifier',
      MAX_COMPONENT_ID_LENGTH,
    );
    const controlId = componentVisibilityControlId(componentId);
    const identity = `${target}\u0000${controlId}`;
    if (identities.has(identity)) {
      throw new ControlActionCatalogError(
        'DUPLICATE_ACTION_CAPABILITY',
        'Action capabilities must be unique within a target',
      );
    }
    identities.add(identity);
    capabilities.push({
      kind: capability.kind,
      target,
      componentId,
      controlId,
      label: requiredLabel(capability.label),
    });
  }

  const normalized = normalizedAuthority(authority);
  if (normalized.showId !== showId) {
    throw new ControlActionCatalogError(
      'AUTHORITY_SHOW_MISMATCH',
      'Device authority belongs to another Show',
    );
  }

  const actions = capabilities
    .filter((capability) => (
      normalized.canWriteVisibility
      && normalized.targets.has(capability.target)
      && normalized.controlIds.has(capability.controlId)
    ))
    .sort((left, right) => (
      targetRank(left.target) - targetRank(right.target)
      || compareText(left.controlId, right.controlId)
    ))
    .map((capability): ComponentVisibilityActionDescriptor => ({
      actionId: actionId(capability.target, capability.componentId),
      kind: COMPONENT_VISIBILITY_ACTION_KIND,
      subject: {
        showId,
        target: capability.target,
        controlId: capability.controlId,
      },
      componentId: capability.componentId,
      label: capability.label,
      input: {
        visible: { type: 'boolean', required: true },
      },
    }));

  return {
    schemaVersion: CONTROL_ACTION_CATALOG_VERSION,
    showId,
    actions,
  };
}
