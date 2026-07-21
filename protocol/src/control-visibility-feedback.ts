import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  CONTROL_ACTION_CATALOG_VERSION,
  componentVisibilityControlId,
  type AuthorizedControlActionCatalog,
  type ComponentVisibilityActionDescriptor,
} from './control-action-catalog.js';
import type { AuthoritativeServerObservation } from './control-feedback.js';
import type { ElementNode } from './element.js';
import type { ProductionBus, ProductionSnapshot } from './production.js';

export const CONTROL_VISIBILITY_FEEDBACK_VERSION = 'overlaykit-control-visibility-feedback/v1' as const;

const MAX_SHOW_ID_LENGTH = 200;
const MAX_COMPONENT_ID_LENGTH = 100;
const MAX_LABEL_LENGTH = 160;
const MAX_ELEMENTS = 1_000;
const MAX_ACTIONS = 1_000;

export interface ServerVisibilityFeedbackProjection {
  readonly schemaVersion: typeof CONTROL_VISIBILITY_FEEDBACK_VERSION;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly revision: number;
  readonly observedAt: number;
  readonly observations: ReadonlyArray<AuthoritativeServerObservation>;
}

export type ControlVisibilityFeedbackErrorCode =
  | 'INVALID_PRODUCTION_SNAPSHOT'
  | 'INVALID_ACTION_CATALOG'
  | 'SNAPSHOT_CATALOG_MISMATCH'
  | 'DUPLICATE_COMPONENT_ID'
  | 'DUPLICATE_FEEDBACK_SUBJECT'
  | 'CATALOG_COMPONENT_MISSING'
  | 'INVALID_OBSERVATION_TIME'
  | 'OBSERVATION_BEFORE_SNAPSHOT';

export class ControlVisibilityFeedbackError extends Error {
  constructor(
    public readonly code: ControlVisibilityFeedbackErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface IndexedComponent {
  readonly active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredIdentifier(
  value: unknown,
  maxLength: number,
  code: 'INVALID_PRODUCTION_SNAPSHOT' | 'INVALID_ACTION_CATALOG',
  field: string,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
  ) {
    throw new ControlVisibilityFeedbackError(code, `${field} is invalid`);
  }
  return value;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validTarget(value: unknown): value is ProductionBus {
  return value === 'preview' || value === 'program';
}

function codeUnitCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function displayEnabled(styles: Record<string, unknown>): boolean {
  const display = styles.display;
  return typeof display !== 'string' || display.trim().toLowerCase() !== 'none';
}

function indexComponents(elements: readonly ElementNode[]): Map<string, IndexedComponent> {
  const components = new Map<string, IndexedComponent>();
  const pending = [...elements]
    .reverse()
    .map((element) => ({ element, ancestorsEnabled: true }));

  while (pending.length > 0) {
    const { element, ancestorsEnabled } = pending.pop() as {
      element: ElementNode;
      ancestorsEnabled: boolean;
    };
    if (components.size >= MAX_ELEMENTS) {
      throw new ControlVisibilityFeedbackError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Production snapshot exceeds the visibility feedback element limit',
      );
    }
    if (!isRecord(element)) {
      throw new ControlVisibilityFeedbackError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Production snapshot element is malformed',
      );
    }
    const componentId = requiredIdentifier(
      element.id,
      MAX_COMPONENT_ID_LENGTH,
      'INVALID_PRODUCTION_SNAPSHOT',
      'Component identifier',
    );
    if (typeof element.tag !== 'string' || !isRecord(element.styles)) {
      throw new ControlVisibilityFeedbackError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Production snapshot element is malformed',
      );
    }
    if (element.styles.display !== undefined && typeof element.styles.display !== 'string') {
      throw new ControlVisibilityFeedbackError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Component display state is malformed',
      );
    }
    if (element.children !== undefined && !Array.isArray(element.children)) {
      throw new ControlVisibilityFeedbackError(
        'INVALID_PRODUCTION_SNAPSHOT',
        'Component children are malformed',
      );
    }
    if (components.has(componentId)) {
      throw new ControlVisibilityFeedbackError(
        'DUPLICATE_COMPONENT_ID',
        'Component identifiers must be unique in a production target',
      );
    }

    const active = ancestorsEnabled && displayEnabled(element.styles);
    components.set(componentId, { active });
    for (const child of [...(element.children ?? [])].reverse()) {
      pending.push({ element: child, ancestorsEnabled: active });
    }
  }
  return components;
}

function assertSnapshot(snapshot: ProductionSnapshot): void {
  if (!isRecord(snapshot)) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_PRODUCTION_SNAPSHOT',
      'Production snapshot is malformed',
    );
  }
  requiredIdentifier(
    snapshot.showId,
    MAX_SHOW_ID_LENGTH,
    'INVALID_PRODUCTION_SNAPSHOT',
    'Snapshot Show identifier',
  );
  if (
    !validTarget(snapshot.bus)
    || !Number.isSafeInteger(snapshot.revision)
    || snapshot.revision < 0
    || !Array.isArray(snapshot.elements)
    || !isRecord(snapshot.variables)
    || !Array.isArray(snapshot.controls)
    || (snapshot.orientation !== 'landscape' && snapshot.orientation !== 'portrait')
    || (snapshot.updatedAt !== null && !validTime(snapshot.updatedAt))
    || (snapshot.scene !== null && !isRecord(snapshot.scene))
  ) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_PRODUCTION_SNAPSHOT',
      'Production snapshot is malformed',
    );
  }
}

function assertAction(
  action: ComponentVisibilityActionDescriptor,
  catalogShowId: string,
): void {
  if (
    !isRecord(action)
    || action.kind !== COMPONENT_VISIBILITY_ACTION_KIND
    || !isRecord(action.subject)
    || action.subject.showId !== catalogShowId
    || !validTarget(action.subject.target)
  ) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_ACTION_CATALOG',
      'Action catalog descriptor is malformed',
    );
  }
  const componentId = requiredIdentifier(
    action.componentId,
    MAX_COMPONENT_ID_LENGTH,
    'INVALID_ACTION_CATALOG',
    'Catalog component identifier',
  );
  if (
    typeof action.label !== 'string'
    || action.label.length === 0
    || action.label.length > MAX_LABEL_LENGTH
    || action.label !== action.label.trim()
    || action.subject.controlId !== componentVisibilityControlId(componentId)
    || action.actionId !== `${COMPONENT_VISIBILITY_ACTION_KIND}/${action.subject.target}/${encodeURIComponent(componentId)}`
    || !isRecord(action.input)
    || !isRecord(action.input.visible)
    || action.input.visible.type !== 'boolean'
    || action.input.visible.required !== true
  ) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_ACTION_CATALOG',
      'Action catalog descriptor is malformed',
    );
  }
}

function normalizedTargetActions(
  catalog: AuthorizedControlActionCatalog,
  target: ProductionBus,
): ComponentVisibilityActionDescriptor[] {
  if (
    !isRecord(catalog)
    || catalog.schemaVersion !== CONTROL_ACTION_CATALOG_VERSION
    || !Array.isArray(catalog.actions)
    || catalog.actions.length > MAX_ACTIONS
  ) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_ACTION_CATALOG',
      'Action catalog is malformed',
    );
  }
  const showId = requiredIdentifier(
    catalog.showId,
    MAX_SHOW_ID_LENGTH,
    'INVALID_ACTION_CATALOG',
    'Catalog Show identifier',
  );
  const subjects = new Set<string>();
  for (const action of catalog.actions) {
    assertAction(action, showId);
    const identity = `${action.subject.target}\u0000${action.subject.controlId}`;
    if (subjects.has(identity)) {
      throw new ControlVisibilityFeedbackError(
        'DUPLICATE_FEEDBACK_SUBJECT',
        'Action catalog subjects must be unique',
      );
    }
    subjects.add(identity);
  }
  return catalog.actions
    .filter((action) => action.subject.target === target)
    .slice()
    .sort((left, right) => codeUnitCompare(left.subject.controlId, right.subject.controlId));
}

export function projectServerVisibilityFeedback(
  snapshot: ProductionSnapshot,
  catalog: AuthorizedControlActionCatalog,
  observedAt: number,
): ServerVisibilityFeedbackProjection {
  assertSnapshot(snapshot);
  if (!validTime(observedAt)) {
    throw new ControlVisibilityFeedbackError(
      'INVALID_OBSERVATION_TIME',
      'Visibility feedback observation time is invalid',
    );
  }
  if (snapshot.updatedAt !== null && observedAt < snapshot.updatedAt) {
    throw new ControlVisibilityFeedbackError(
      'OBSERVATION_BEFORE_SNAPSHOT',
      'Visibility feedback cannot predate the production snapshot',
    );
  }

  const actions = normalizedTargetActions(catalog, snapshot.bus);
  if (catalog.showId !== snapshot.showId) {
    throw new ControlVisibilityFeedbackError(
      'SNAPSHOT_CATALOG_MISMATCH',
      'Production snapshot and action catalog belong to different Shows',
    );
  }
  const components = indexComponents(snapshot.elements);
  const observations = actions.map((action): AuthoritativeServerObservation => {
    const component = components.get(action.componentId);
    if (!component) {
      throw new ControlVisibilityFeedbackError(
        'CATALOG_COMPONENT_MISSING',
        'Catalog component is not present in the production snapshot',
      );
    }
    return {
      kind: 'server.state.observed',
      subject: { ...action.subject },
      value: component.active ? 'active' : 'inactive',
      revision: snapshot.revision,
      observedAt,
    };
  });

  return {
    schemaVersion: CONTROL_VISIBILITY_FEEDBACK_VERSION,
    showId: snapshot.showId,
    target: snapshot.bus,
    revision: snapshot.revision,
    observedAt,
    observations,
  };
}
