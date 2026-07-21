import type {
  AuthorizedControlActionCatalog,
  ControlActionInventory,
} from '@overlaykit/protocol/control-action-catalog' with { 'resolution-mode': 'import' };
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential' with {
  'resolution-mode': 'import',
};
import type { ElementNode } from '../types/element';
import type { ProductionBus, ProductionState } from '../types/production';
import type { ProductionService } from './ProductionService';

const MAX_CATALOG_LABEL_LENGTH = 160;
const MAX_CATALOG_CAPABILITIES = 1_000;

type ControlActionCatalogProtocolModule = typeof import(
  '@overlaykit/protocol/control-action-catalog',
  { with: { 'resolution-mode': 'import' } }
);

export type DeviceActionCatalogProjector = (
  inventory: ControlActionInventory,
  authority: DeviceCredentialAuthority
) => AuthorizedControlActionCatalog;

export interface DeviceActionCatalogRuntime {
  readonly projectAuthorizedControlActionCatalog: DeviceActionCatalogProjector;
}

export interface DeviceActionCatalogRuntimeOptions {
  readonly loadProtocol?: () => Promise<ControlActionCatalogProtocolModule>;
}

class DeviceActionInventoryError extends Error {
  readonly code = 'INVALID_ACTION_INVENTORY';
}

async function loadControlActionCatalogProtocol(): Promise<ControlActionCatalogProtocolModule> {
  return import('@overlaykit/protocol/control-action-catalog');
}

function boundedLabel(value: string): string {
  return value.trim().slice(0, MAX_CATALOG_LABEL_LENGTH).trim();
}

function componentLabel(element: ElementNode): string {
  const declared = [element.attributes?.['aria-label'], element.attributes?.['data-label']]
    .filter((value): value is string => typeof value === 'string')
    .map(boundedLabel)
    .find(Boolean);
  if (declared) return declared;

  const className = element.attributes?.class?.split(/\s+/).map(boundedLabel).find(Boolean);
  if (className) return className;

  const content = boundedLabel(element.content ?? '');
  if (content && !content.includes('{{')) return content;
  return element.id;
}

function appendCapabilities(
  capabilities: ControlActionInventory['capabilities'][number][],
  target: ProductionBus,
  elements: readonly ElementNode[]
): void {
  const pending = [...elements].reverse();
  while (pending.length > 0) {
    const element = pending.pop() as ElementNode;
    if (capabilities.length >= MAX_CATALOG_CAPABILITIES) {
      throw new DeviceActionInventoryError('Action inventory exceeds the server limit');
    }
    capabilities.push({
      kind: 'component.visibility',
      target,
      componentId: element.id,
      label: componentLabel(element),
    });
    for (const child of [...(element.children ?? [])].reverse()) pending.push(child);
  }
}

export function buildDeviceActionInventory(
  production: ProductionService,
  showId: string
): ControlActionInventory {
  return buildDeviceActionInventoryFromState(production.getState(showId));
}

export function buildDeviceActionInventoryFromState(
  state: ProductionState
): ControlActionInventory {
  const capabilities: ControlActionInventory['capabilities'][number][] = [];
  for (const target of ['preview', 'program'] as const) {
    appendCapabilities(capabilities, target, state[target].elements);
  }
  return { showId: state.showId, capabilities };
}

export async function createDeviceActionCatalogRuntime(
  options: DeviceActionCatalogRuntimeOptions = {}
): Promise<DeviceActionCatalogRuntime> {
  const protocol = await (options.loadProtocol ?? loadControlActionCatalogProtocol)();
  return {
    projectAuthorizedControlActionCatalog: protocol.projectAuthorizedControlActionCatalog,
  };
}
