import { describe, expect, it } from 'vitest';
import {
  projectAuthorizedControlActionCatalog,
  type AuthorizedControlActionCatalog,
  type ComponentVisibilityCapability,
} from '../src/control-action-catalog.js';
import {
  ControlVisibilityFeedbackError,
  projectServerVisibilityFeedback,
} from '../src/control-visibility-feedback.js';
import type { DeviceCredentialAuthority } from '../src/device-credential.js';
import type { ElementNode } from '../src/element.js';
import type { ProductionBus, ProductionSnapshot } from '../src/production.js';

const authority: DeviceCredentialAuthority = {
  credentialId: 'device-1',
  generation: 1,
  feedbackAudience: 'device-1.g1',
  showId: 'show-1',
  scopes: ['feedback:read', 'component.visibility:write'],
  targets: ['preview', 'program'],
  controlIds: [
    'alert.visibility',
    'container.visibility',
    'lower-third.visibility',
    'scoreboard.visibility',
  ],
  expiresAt: 10_000,
};

function element(
  id: string,
  styles: Record<string, string> = {},
  children?: ElementNode[],
): ElementNode {
  return { id, tag: 'div', styles, ...(children ? { children } : {}) };
}

function snapshot(
  elements: ElementNode[],
  overrides: Partial<ProductionSnapshot> = {},
): ProductionSnapshot {
  return {
    showId: 'show-1',
    bus: 'preview',
    revision: 7,
    scene: { id: 'scene-1', name: 'Scene', elements: [] },
    elements,
    variables: {},
    controls: [],
    orientation: 'landscape',
    updatedAt: 1_000,
    ...overrides,
  };
}

function catalog(
  capabilities: ComponentVisibilityCapability[],
  authorityOverrides: Partial<DeviceCredentialAuthority> = {},
): AuthorizedControlActionCatalog {
  return projectAuthorizedControlActionCatalog(
    { showId: 'show-1', capabilities },
    { ...authority, ...authorityOverrides },
  );
}

function capability(
  componentId: string,
  target: ProductionBus = 'preview',
): ComponentVisibilityCapability {
  return {
    kind: 'component.visibility',
    target,
    componentId,
    label: componentId,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('Expected visibility feedback projection to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ControlVisibilityFeedbackError);
    expect((error as ControlVisibilityFeedbackError).code).toBe(code);
  }
}

describe('server-known component visibility feedback', () => {
  it('emits exact revisioned observations for the snapshot target', () => {
    const actions = catalog([
      capability('lower-third'),
      capability('scoreboard'),
      capability('alert', 'program'),
    ]);
    const result = projectServerVisibilityFeedback(
      snapshot([
        element('lower-third'),
        element('scoreboard', { display: 'none' }),
      ]),
      actions,
      1_250,
    );

    expect(result).toEqual({
      schemaVersion: 'overlaykit-control-visibility-feedback/v1',
      showId: 'show-1',
      target: 'preview',
      revision: 7,
      observedAt: 1_250,
      observations: [
        {
          kind: 'server.state.observed',
          subject: {
            showId: 'show-1',
            target: 'preview',
            controlId: 'lower-third.visibility',
          },
          value: 'active',
          revision: 7,
          observedAt: 1_250,
        },
        {
          kind: 'server.state.observed',
          subject: {
            showId: 'show-1',
            target: 'preview',
            controlId: 'scoreboard.visibility',
          },
          value: 'inactive',
          revision: 7,
          observedAt: 1_250,
        },
      ],
    });
  });

  it('reports descendants inactive when an ancestor is structurally hidden', () => {
    const actions = catalog([
      capability('alert'),
      capability('container'),
      capability('scoreboard'),
    ]);
    const result = projectServerVisibilityFeedback(
      snapshot([
        element('container', { display: ' NoNe ' }, [element('alert')]),
        element('scoreboard'),
      ]),
      actions,
      1_001,
    );

    expect(result.observations.map(({ subject, value }) => [subject.controlId, value])).toEqual([
      ['alert.visibility', 'inactive'],
      ['container.visibility', 'inactive'],
      ['scoreboard.visibility', 'active'],
    ]);
  });

  it('does not present unsupported renderer concerns as server-known inactivity', () => {
    const result = projectServerVisibilityFeedback(
      snapshot([element('lower-third', {
        opacity: '0',
        visibility: 'hidden',
        transform: 'translateX(-9999px)',
        clipPath: 'inset(100%)',
      })]),
      catalog([capability('lower-third')]),
      1_001,
    );

    expect(result.observations[0].value).toBe('active');
  });

  it('is deterministic across element and catalog input order without mutation', () => {
    const firstSnapshot = snapshot([element('scoreboard'), element('lower-third')]);
    const secondSnapshot = snapshot([element('lower-third'), element('scoreboard')]);
    const firstCatalog = catalog([capability('scoreboard'), capability('lower-third')]);
    const reversedCatalog = {
      ...firstCatalog,
      actions: [...firstCatalog.actions].reverse(),
    };
    const snapshotBefore = JSON.stringify(firstSnapshot);
    const catalogBefore = JSON.stringify(reversedCatalog);

    const first = projectServerVisibilityFeedback(firstSnapshot, reversedCatalog, 1_001);
    const second = projectServerVisibilityFeedback(secondSnapshot, firstCatalog, 1_001);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(firstSnapshot)).toBe(snapshotBefore);
    expect(JSON.stringify(reversedCatalog)).toBe(catalogBefore);
  });

  it('fails closed for Show mismatch and malformed catalog descriptors', () => {
    const valid = catalog([capability('lower-third')]);
    expectCode(
      () => projectServerVisibilityFeedback(
        snapshot([element('lower-third')], { showId: 'show-2' }),
        valid,
        1_001,
      ),
      'SNAPSHOT_CATALOG_MISMATCH',
    );

    const malformed = structuredClone(valid) as AuthorizedControlActionCatalog;
    (malformed.actions[0].subject as { controlId: string }).controlId = 'other.visibility';
    expectCode(
      () => projectServerVisibilityFeedback(snapshot([element('lower-third')]), malformed, 1_001),
      'INVALID_ACTION_CATALOG',
    );
  });

  it('rejects duplicate components, duplicate subjects, and missing components', () => {
    const valid = catalog([capability('lower-third')]);
    expectCode(
      () => projectServerVisibilityFeedback(
        snapshot([element('lower-third'), element('lower-third')]),
        valid,
        1_001,
      ),
      'DUPLICATE_COMPONENT_ID',
    );

    const duplicatedCatalog = {
      ...valid,
      actions: [valid.actions[0], structuredClone(valid.actions[0])],
    };
    expectCode(
      () => projectServerVisibilityFeedback(
        snapshot([element('lower-third')]),
        duplicatedCatalog,
        1_001,
      ),
      'DUPLICATE_FEEDBACK_SUBJECT',
    );

    expectCode(
      () => projectServerVisibilityFeedback(snapshot([]), valid, 1_001),
      'CATALOG_COMPONENT_MISSING',
    );
  });

  it('rejects invalid revisions and observation time conflicts', () => {
    const valid = catalog([capability('lower-third')]);
    expectCode(
      () => projectServerVisibilityFeedback(
        snapshot([element('lower-third')], { revision: -1 }),
        valid,
        1_001,
      ),
      'INVALID_PRODUCTION_SNAPSHOT',
    );
    expectCode(
      () => projectServerVisibilityFeedback(snapshot([element('lower-third')]), valid, -1),
      'INVALID_OBSERVATION_TIME',
    );
    expectCode(
      () => projectServerVisibilityFeedback(snapshot([element('lower-third')]), valid, 999),
      'OBSERVATION_BEFORE_SNAPSHOT',
    );
  });

  it('rejects malformed structural visibility inputs', () => {
    const malformed = snapshot([element('lower-third')]);
    (malformed.elements[0].styles as Record<string, unknown>).display = false;

    expectCode(
      () => projectServerVisibilityFeedback(
        malformed,
        catalog([capability('lower-third')]),
        1_001,
      ),
      'INVALID_PRODUCTION_SNAPSHOT',
    );
  });

  it('bounds complete snapshot and catalog inputs before projection', () => {
    const valid = catalog([capability('lower-third')]);
    const oversizedElements = Array.from(
      { length: 1_001 },
      (_, index) => element(`element-${index}`),
    );
    expectCode(
      () => projectServerVisibilityFeedback(snapshot(oversizedElements), valid, 1_001),
      'INVALID_PRODUCTION_SNAPSHOT',
    );

    const oversizedCatalog = {
      ...valid,
      actions: Array.from({ length: 1_001 }, () => structuredClone(valid.actions[0])),
    };
    expectCode(
      () => projectServerVisibilityFeedback(
        snapshot([element('lower-third')]),
        oversizedCatalog,
        1_001,
      ),
      'INVALID_ACTION_CATALOG',
    );
  });

  it('traverses a deeply nested bounded tree without recursive stack dependence', () => {
    const root = element('element-0');
    let current = root;
    for (let index = 1; index < 1_000; index += 1) {
      const child = element(`element-${index}`);
      current.children = [child];
      current = child;
    }

    const result = projectServerVisibilityFeedback(
      snapshot([root]),
      catalog([capability('element-999')], { controlIds: ['element-999.visibility'] }),
      1_001,
    );
    expect(result.observations).toMatchObject([
      {
        subject: { controlId: 'element-999.visibility' },
        value: 'active',
        revision: 7,
      },
    ]);
  });
});
