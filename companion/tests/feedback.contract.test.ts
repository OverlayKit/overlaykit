import { describe, expect, it } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type AuthoritativeServerObservation,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { projectCompanionActions } from '../src/catalog';
import { projectCompanionFeedback } from '../src/feedback';

// AC-018 (feedback half) contract: server visibility observations become per-action Companion button
// states. This reuses the protocol's own feedback projector (createControlFeedbackState ->
// reduceControlFeedback -> projectControlFeedback), so the adapter honors the same button-state truth
// as Studio rather than inventing its own; the live delta transport is a separate slice.

const SHOW = 'show-1';
const NOW = 1_000_000;

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'cred-1',
    audienceCredentialId: 'aud-1',
    generation: 1,
    showId: SHOW,
    targets: ['preview', 'program'],
    controlIds: ['scoreboard.visibility', 'lower-third.visibility'],
    scopes: ['component.visibility:write'],
    expiresAt: 4_102_444_800_000,
  };
}

const inventory: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'lower-third', label: 'Lower Third' },
  ],
};

function actions() {
  return projectCompanionActions(projectAuthorizedControlActionCatalog(inventory, authority()));
}

function observation(
  controlId: string,
  value: 'active' | 'inactive',
  observedAt: number,
): AuthoritativeServerObservation {
  return {
    kind: 'server.state.observed',
    subject: { showId: SHOW, target: 'preview', controlId },
    value,
    revision: 1,
    observedAt,
  };
}

describe('projectCompanionFeedback (AC-018 feedback)', () => {
  it('reflects each action current visibility from fresh server observations', () => {
    const feedback = projectCompanionFeedback(
      actions(),
      [
        observation('scoreboard.visibility', 'active', NOW - 100),
        observation('lower-third.visibility', 'inactive', NOW - 100),
      ],
      NOW,
    );

    expect(feedback).toEqual([
      { actionId: 'component.visibility/preview/lower-third', buttonState: 'inactive', status: 'current' },
      { actionId: 'component.visibility/preview/scoreboard', buttonState: 'active', status: 'current' },
    ]);
  });

  it('reports unknown for an action with no matching observation', () => {
    const feedback = projectCompanionFeedback(
      actions(),
      [observation('scoreboard.visibility', 'active', NOW - 100)],
      NOW,
    );
    const lowerThird = feedback.find((f) => f.actionId === 'component.visibility/preview/lower-third');
    expect(lowerThird).toEqual({
      actionId: 'component.visibility/preview/lower-third',
      buttonState: 'unknown',
      status: 'unknown',
    });
  });

  it('goes stale once the observation is older than the feedback timeout', () => {
    const feedback = projectCompanionFeedback(
      actions(),
      [observation('scoreboard.visibility', 'active', NOW - 10_000)],
      NOW,
    );
    const scoreboard = feedback.find((f) => f.actionId === 'component.visibility/preview/scoreboard');
    expect(scoreboard).toEqual({
      actionId: 'component.visibility/preview/scoreboard',
      buttonState: 'unknown',
      status: 'stale',
    });
  });

  it('keeps the highest-revision observation when a subject reports more than once', () => {
    const stale: AuthoritativeServerObservation = {
      kind: 'server.state.observed',
      subject: { showId: SHOW, target: 'preview', controlId: 'scoreboard.visibility' },
      value: 'inactive',
      revision: 1,
      observedAt: NOW - 100,
    };
    const fresh: AuthoritativeServerObservation = { ...stale, value: 'active', revision: 2, observedAt: NOW - 50 };

    const feedback = projectCompanionFeedback(actions(), [stale, fresh], NOW);
    const scoreboard = feedback.find((f) => f.actionId === 'component.visibility/preview/scoreboard');
    expect(scoreboard?.buttonState).toBe('active');
  });

  it('does not match an observation from a different target (no Program-to-Preview leak)', () => {
    const programObservation: AuthoritativeServerObservation = {
      kind: 'server.state.observed',
      subject: { showId: SHOW, target: 'program', controlId: 'scoreboard.visibility' },
      value: 'active',
      revision: 1,
      observedAt: NOW - 100,
    };
    const feedback = projectCompanionFeedback(actions(), [programObservation], NOW);
    const previewScoreboard = feedback.find((f) => f.actionId === 'component.visibility/preview/scoreboard');
    expect(previewScoreboard).toEqual({
      actionId: 'component.visibility/preview/scoreboard',
      buttonState: 'unknown',
      status: 'unknown',
    });
  });

  it('does not match an observation from a different Show', () => {
    const foreignShow: AuthoritativeServerObservation = {
      kind: 'server.state.observed',
      subject: { showId: 'other-show', target: 'preview', controlId: 'scoreboard.visibility' },
      value: 'active',
      revision: 1,
      observedAt: NOW - 100,
    };
    const feedback = projectCompanionFeedback(actions(), [foreignShow], NOW);
    const scoreboard = feedback.find((f) => f.actionId === 'component.visibility/preview/scoreboard');
    expect(scoreboard?.status).toBe('unknown');
  });

  it('honors a caller-supplied freshness window via timeoutMs', () => {
    const widened = projectCompanionFeedback(
      actions(),
      [observation('scoreboard.visibility', 'active', NOW - 5_000)],
      NOW,
      10_000,
    );
    expect(widened.find((f) => f.actionId === 'component.visibility/preview/scoreboard')).toEqual({
      actionId: 'component.visibility/preview/scoreboard',
      buttonState: 'active',
      status: 'current',
    });

    const narrowed = projectCompanionFeedback(
      actions(),
      [observation('scoreboard.visibility', 'active', NOW - 100)],
      NOW,
      50,
    );
    expect(narrowed.find((f) => f.actionId === 'component.visibility/preview/scoreboard')?.status).toBe('stale');
  });

  it('treats a future-dated observation as unknown (clock skew)', () => {
    const feedback = projectCompanionFeedback(
      actions(),
      [observation('scoreboard.visibility', 'active', NOW + 5_000)],
      NOW,
    );
    expect(feedback.find((f) => f.actionId === 'component.visibility/preview/scoreboard')).toEqual({
      actionId: 'component.visibility/preview/scoreboard',
      buttonState: 'unknown',
      status: 'unknown',
    });
  });

  it('isolates a malformed observation to its own action, keeping the rest', () => {
    const malformed: AuthoritativeServerObservation = {
      kind: 'server.state.observed',
      subject: { showId: SHOW, target: 'preview', controlId: 'scoreboard.visibility' },
      value: 'active',
      revision: -1,
      observedAt: NOW - 100,
    };
    const feedback = projectCompanionFeedback(
      actions(),
      [malformed, observation('lower-third.visibility', 'inactive', NOW - 100)],
      NOW,
    );
    // The malformed observation degrades its own action to unknown; the valid one is unaffected.
    expect(feedback).toEqual([
      { actionId: 'component.visibility/preview/lower-third', buttonState: 'inactive', status: 'current' },
      { actionId: 'component.visibility/preview/scoreboard', buttonState: 'unknown', status: 'unknown' },
    ]);
  });
});
