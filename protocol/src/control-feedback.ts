import type { ProductionBus } from './production';

export const DEFAULT_CONTROL_FEEDBACK_TIMEOUT_MS = 3_000;

export type ControlFeedbackValue = 'active' | 'inactive';
export type ControlFeedbackStatus = 'current' | 'stale' | 'failed' | 'unknown';
export type ControlButtonState = ControlFeedbackValue | 'failed' | 'unknown';

export interface ControlFeedbackSubject {
  readonly showId: string;
  readonly target: ProductionBus;
  readonly controlId: string;
}

export interface AuthoritativeServerObservation {
  readonly kind: 'server.state.observed';
  readonly subject: ControlFeedbackSubject;
  readonly value: ControlFeedbackValue;
  readonly revision: number;
  readonly observedAt: number;
}

export interface TransportAcknowledgement {
  readonly kind: 'transport.acknowledged';
  readonly subject: ControlFeedbackSubject;
  readonly operationId: string;
  readonly acknowledgedAt: number;
}

export interface ControlOperationFailure {
  readonly kind: 'operation.failed';
  readonly subject: ControlFeedbackSubject;
  readonly operationId: string;
  readonly code: string;
  readonly message: string;
  readonly failedAt: number;
}

export type ControlFeedbackEvent =
  | AuthoritativeServerObservation
  | TransportAcknowledgement
  | ControlOperationFailure;

export interface ControlFeedbackObservation {
  readonly value: ControlFeedbackValue;
  readonly revision: number;
  readonly observedAt: number;
}

export interface ControlFeedbackDelivery {
  readonly operationId: string;
  readonly acknowledgedAt: number;
}

export interface ControlFeedbackFailure {
  readonly operationId: string;
  readonly code: string;
  readonly message: string;
  readonly failedAt: number;
}

export interface ControlFeedbackState {
  readonly subject: ControlFeedbackSubject;
  readonly observation?: ControlFeedbackObservation;
  readonly delivery?: ControlFeedbackDelivery;
  readonly failure?: ControlFeedbackFailure;
}

export interface ControlFeedbackView {
  readonly subject: ControlFeedbackSubject;
  readonly truthScope: 'authoritative-server';
  readonly status: ControlFeedbackStatus;
  readonly buttonState: ControlButtonState;
  readonly reason:
    | 'authoritative-observation'
    | 'observation-timeout'
    | 'operation-failure'
    | 'never-observed'
    | 'clock-skew';
  readonly lastKnownState?: ControlFeedbackValue;
  readonly revision?: number;
  readonly observedAt?: number;
  readonly expiresAt?: number;
  readonly delivery?: ControlFeedbackDelivery;
  readonly failure?: ControlFeedbackFailure;
}

export class ControlFeedbackError extends Error {
  constructor(
    public readonly code: 'INVALID_EVENT' | 'SUBJECT_MISMATCH' | 'OBSERVATION_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

function sameSubject(left: ControlFeedbackSubject, right: ControlFeedbackSubject): boolean {
  return left.showId === right.showId
    && left.target === right.target
    && left.controlId === right.controlId;
}

function validSubject(subject: ControlFeedbackSubject): boolean {
  return Boolean(subject?.showId)
    && (subject.target === 'preview' || subject.target === 'program')
    && Boolean(subject.controlId);
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function assertSubject(subject: ControlFeedbackSubject): void {
  if (!validSubject(subject)) {
    throw new ControlFeedbackError(
      'INVALID_EVENT',
      'Feedback subject must name a Show, Preview or Program target, and control',
    );
  }
}

function assertEvent(state: ControlFeedbackState, event: ControlFeedbackEvent): void {
  assertSubject(event.subject);
  if (!sameSubject(state.subject, event.subject)) {
    throw new ControlFeedbackError(
      'SUBJECT_MISMATCH',
      'Feedback for another Show, target, or control cannot change this projection',
    );
  }
}

export function createControlFeedbackState(subject: ControlFeedbackSubject): ControlFeedbackState {
  assertSubject(subject);
  return { subject: { ...subject } };
}

export function reduceControlFeedback(
  state: ControlFeedbackState,
  event: ControlFeedbackEvent,
): ControlFeedbackState {
  assertEvent(state, event);

  if (event.kind === 'transport.acknowledged') {
    if (!event.operationId || !validTime(event.acknowledgedAt)) {
      throw new ControlFeedbackError('INVALID_EVENT', 'Transport acknowledgement is malformed');
    }
    if (state.delivery && state.delivery.acknowledgedAt > event.acknowledgedAt) return state;
    return {
      ...state,
      delivery: {
        operationId: event.operationId,
        acknowledgedAt: event.acknowledgedAt,
      },
    };
  }

  if (event.kind === 'operation.failed') {
    if (!event.operationId || !event.code || !validTime(event.failedAt)) {
      throw new ControlFeedbackError('INVALID_EVENT', 'Operation failure is malformed');
    }
    if (state.observation && state.observation.observedAt > event.failedAt) return state;
    if (state.failure && state.failure.failedAt > event.failedAt) return state;
    return {
      ...state,
      failure: {
        operationId: event.operationId,
        code: event.code,
        message: event.message,
        failedAt: event.failedAt,
      },
    };
  }

  if (
    (event.value !== 'active' && event.value !== 'inactive')
    || !Number.isInteger(event.revision)
    || event.revision < 0
    || !validTime(event.observedAt)
  ) {
    throw new ControlFeedbackError('INVALID_EVENT', 'Server observation is malformed');
  }
  const current = state.observation;
  if (current && event.revision < current.revision) return state;
  if (current && event.revision === current.revision && event.observedAt < current.observedAt) return state;
  if (
    current
    && event.revision === current.revision
    && event.observedAt === current.observedAt
    && event.value !== current.value
  ) {
    throw new ControlFeedbackError(
      'OBSERVATION_CONFLICT',
      'The same server revision and observation time cannot report two states',
    );
  }

  return {
    ...state,
    observation: {
      value: event.value,
      revision: event.revision,
      observedAt: event.observedAt,
    },
    failure: state.failure && state.failure.failedAt >= event.observedAt
      ? state.failure
      : undefined,
  };
}

export function projectControlFeedback(
  state: ControlFeedbackState,
  now: number,
  timeoutMs = DEFAULT_CONTROL_FEEDBACK_TIMEOUT_MS,
): ControlFeedbackView {
  if (!validTime(now) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ControlFeedbackError('INVALID_EVENT', 'Feedback projection time is malformed');
  }

  const observation = state.observation;
  const shared = {
    subject: { ...state.subject },
    truthScope: 'authoritative-server' as const,
    ...(observation ? {
      lastKnownState: observation.value,
      revision: observation.revision,
      observedAt: observation.observedAt,
      expiresAt: observation.observedAt + timeoutMs,
    } : {}),
    ...(state.delivery ? { delivery: { ...state.delivery } } : {}),
    ...(state.failure ? { failure: { ...state.failure } } : {}),
  };

  if (state.failure && (!observation || state.failure.failedAt >= observation.observedAt)) {
    return {
      ...shared,
      status: 'failed',
      buttonState: 'failed',
      reason: 'operation-failure',
    };
  }
  if (!observation) {
    return {
      ...shared,
      status: 'unknown',
      buttonState: 'unknown',
      reason: 'never-observed',
    };
  }
  if (now < observation.observedAt) {
    return {
      ...shared,
      status: 'unknown',
      buttonState: 'unknown',
      reason: 'clock-skew',
    };
  }
  if (now - observation.observedAt >= timeoutMs) {
    return {
      ...shared,
      status: 'stale',
      buttonState: 'unknown',
      reason: 'observation-timeout',
    };
  }
  return {
    ...shared,
    status: 'current',
    buttonState: observation.value,
    reason: 'authoritative-observation',
  };
}
