import { describe, expect, it } from 'vitest';
import {
  ControlFeedbackError,
  createControlFeedbackState,
  projectControlFeedback,
  reduceControlFeedback,
  type ControlFeedbackEvent,
  type ControlFeedbackSubject,
} from '../src/control-feedback';

const subject: ControlFeedbackSubject = {
  showId: 'show-1',
  target: 'program',
  controlId: 'lower-third.visibility',
};

describe('control feedback projection', () => {
  it('starts unknown and does not promote a transport acknowledgement to truth', () => {
    const acknowledged = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'transport.acknowledged',
      subject,
      operationId: 'op-1',
      acknowledgedAt: 1_000,
    });

    expect(projectControlFeedback(acknowledged, 1_001)).toMatchObject({
      truthScope: 'authoritative-server',
      status: 'unknown',
      buttonState: 'unknown',
      reason: 'never-observed',
      delivery: { operationId: 'op-1', acknowledgedAt: 1_000 },
    });
  });

  it('projects fresh server observations and expires them at exactly three seconds', () => {
    const observed = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 7,
      observedAt: 1_000,
    });

    expect(projectControlFeedback(observed, 3_999)).toMatchObject({
      status: 'current',
      buttonState: 'active',
      revision: 7,
      expiresAt: 4_000,
    });
    expect(projectControlFeedback(observed, 4_000)).toMatchObject({
      status: 'stale',
      buttonState: 'unknown',
      reason: 'observation-timeout',
      lastKnownState: 'active',
    });
  });

  it('keeps delivery metadata separate so later acknowledgements cannot refresh stale truth', () => {
    const observed = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'inactive',
      revision: 2,
      observedAt: 1_000,
    });
    const acknowledged = reduceControlFeedback(observed, {
      kind: 'transport.acknowledged',
      subject,
      operationId: 'op-2',
      acknowledgedAt: 3_999,
    });

    expect(projectControlFeedback(acknowledged, 4_000)).toMatchObject({
      status: 'stale',
      buttonState: 'unknown',
      observedAt: 1_000,
      delivery: { operationId: 'op-2', acknowledgedAt: 3_999 },
    });
  });

  it('keeps failures explicit until a newer authoritative observation recovers the control', () => {
    const observed = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 4,
      observedAt: 1_000,
    });
    const failed = reduceControlFeedback(observed, {
      kind: 'operation.failed',
      subject,
      operationId: 'op-failed',
      code: 'TARGET_REVISION_CONFLICT',
      message: 'Program changed',
      failedAt: 1_100,
    });
    const acknowledged = reduceControlFeedback(failed, {
      kind: 'transport.acknowledged',
      subject,
      operationId: 'op-failed',
      acknowledgedAt: 1_200,
    });

    expect(projectControlFeedback(acknowledged, 1_300)).toMatchObject({
      status: 'failed',
      buttonState: 'failed',
      lastKnownState: 'active',
      failure: { operationId: 'op-failed', code: 'TARGET_REVISION_CONFLICT' },
    });

    const recovered = reduceControlFeedback(acknowledged, {
      kind: 'server.state.observed',
      subject,
      value: 'inactive',
      revision: 5,
      observedAt: 1_400,
    });
    expect(projectControlFeedback(recovered, 1_401)).toMatchObject({
      status: 'current',
      buttonState: 'inactive',
      revision: 5,
    });
    expect(recovered.failure).toBeUndefined();
  });

  it('does not let older observations or failures rewind newer server truth', () => {
    const current = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'inactive',
      revision: 8,
      observedAt: 3_000,
    });
    const olderObservation = reduceControlFeedback(current, {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 7,
      observedAt: 3_500,
    });
    const olderFailure = reduceControlFeedback(olderObservation, {
      kind: 'operation.failed',
      subject,
      operationId: 'old-op',
      code: 'OLD_FAILURE',
      message: 'Arrived late',
      failedAt: 2_999,
    });

    expect(olderObservation).toBe(current);
    expect(olderFailure).toBe(current);
    expect(projectControlFeedback(olderFailure, 3_100)).toMatchObject({
      status: 'current',
      buttonState: 'inactive',
      revision: 8,
    });
  });

  it('resolves equal-time failure and observation order conservatively', () => {
    const failure: ControlFeedbackEvent = {
      kind: 'operation.failed',
      subject,
      operationId: 'op-tie',
      code: 'TIME_TIE',
      message: 'No later observation exists',
      failedAt: 2_000,
    };
    const observation: ControlFeedbackEvent = {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 2,
      observedAt: 2_000,
    };
    const failureFirst = reduceControlFeedback(
      reduceControlFeedback(createControlFeedbackState(subject), failure),
      observation,
    );
    const observationFirst = reduceControlFeedback(
      reduceControlFeedback(createControlFeedbackState(subject), observation),
      failure,
    );

    expect(projectControlFeedback(failureFirst, 2_001)).toMatchObject({
      status: 'failed',
      buttonState: 'failed',
    });
    expect(projectControlFeedback(observationFirst, 2_001)).toMatchObject({
      status: 'failed',
      buttonState: 'failed',
    });
  });

  it('rejects cross-control contamination and contradictory observations', () => {
    const state = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 1,
      observedAt: 1_000,
    });
    const otherSubject = { ...subject, target: 'preview' as const };

    expect(() => reduceControlFeedback(state, {
      kind: 'transport.acknowledged',
      subject: otherSubject,
      operationId: 'wrong-target',
      acknowledgedAt: 1_100,
    })).toThrowError(expect.objectContaining({ code: 'SUBJECT_MISMATCH' }));
    expect(() => reduceControlFeedback(state, {
      kind: 'server.state.observed',
      subject,
      value: 'inactive',
      revision: 1,
      observedAt: 1_000,
    })).toThrowError(ControlFeedbackError);
    expect(() => reduceControlFeedback(state, {
      kind: 'server.state.observed',
      subject,
      value: 'inactive',
      revision: 1,
      observedAt: 1_000,
    })).toThrowError(expect.objectContaining({ code: 'OBSERVATION_CONFLICT' }));
  });

  it('fails closed when the observation clock is ahead of the projector', () => {
    const observed = reduceControlFeedback(createControlFeedbackState(subject), {
      kind: 'server.state.observed',
      subject,
      value: 'active',
      revision: 1,
      observedAt: 2_000,
    });

    expect(projectControlFeedback(observed, 1_999)).toMatchObject({
      status: 'unknown',
      buttonState: 'unknown',
      reason: 'clock-skew',
      lastKnownState: 'active',
    });
  });

  it('rejects invalid runtime observation values instead of projecting them', () => {
    const invalid = {
      kind: 'server.state.observed',
      subject,
      value: 'maybe',
      revision: 1,
      observedAt: 1_000,
    } as unknown as ControlFeedbackEvent;

    expect(() => reduceControlFeedback(createControlFeedbackState(subject), invalid))
      .toThrowError(expect.objectContaining({ code: 'INVALID_EVENT' }));
  });
});
