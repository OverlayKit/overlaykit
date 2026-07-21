import {
  ControlFeedbackError,
  createControlFeedbackState,
  reduceControlFeedback,
  type ControlFeedbackEvent,
  type ControlFeedbackSubject,
} from './control-feedback';
import type { ProductionBus } from './production';

export const CONTROL_FEEDBACK_ENVELOPE_VERSION = 'overlaykit-control-feedback/v1' as const;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_FAILURE_MESSAGE_LENGTH = 1_000;
const MAX_SIGNATURE_LENGTH = 4_096;

export interface UnsignedControlFeedbackEnvelope {
  readonly schemaVersion: typeof CONTROL_FEEDBACK_ENVELOPE_VERSION;
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly sequence: number;
  readonly event: ControlFeedbackEvent;
}

export interface SignedControlFeedbackEnvelope extends UnsignedControlFeedbackEnvelope {
  readonly signature: string;
}

export interface ControlFeedbackAuthorityContext {
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly showId: string;
  readonly targets: ReadonlyArray<ProductionBus>;
  readonly controlIds: ReadonlyArray<string>;
  readonly scopes: ReadonlyArray<'feedback:read'>;
  readonly lastAcceptedSequence: number;
}

export type ControlFeedbackSignatureVerifier = (
  signingBytes: Uint8Array,
  signature: string,
  issuerKeyId: string,
) => boolean | Promise<boolean>;

export interface AdmittedControlFeedback {
  readonly event: ControlFeedbackEvent;
  readonly acceptedSequence: number;
}

export type ControlFeedbackAdmissionCode =
  | 'INVALID_ENVELOPE'
  | 'UNTRUSTED_ISSUER'
  | 'INVALID_SIGNATURE'
  | 'AUDIENCE_FORBIDDEN'
  | 'SCOPE_FORBIDDEN'
  | 'SHOW_FORBIDDEN'
  | 'TARGET_FORBIDDEN'
  | 'CONTROL_FORBIDDEN'
  | 'FEEDBACK_REPLAYED';

export class ControlFeedbackAdmissionError extends Error {
  constructor(
    public readonly code: ControlFeedbackAdmissionCode,
    message: string,
  ) {
    super(message);
  }
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SIGNATURE_LENGTH;
}

function assertBoundedSubject(subject: ControlFeedbackSubject): void {
  if (!requiredString(subject.showId) || !requiredString(subject.controlId)) {
    throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback subject exceeds protocol limits');
  }
}

function normalizedSubject(subject: ControlFeedbackSubject): ControlFeedbackSubject {
  return {
    showId: subject.showId,
    target: subject.target,
    controlId: subject.controlId,
  };
}

function normalizedEvent(event: ControlFeedbackEvent): ControlFeedbackEvent {
  if (
    !event
    || typeof event !== 'object'
    || !('kind' in event)
    || !('subject' in event)
    || !event.subject
    || typeof event.subject !== 'object'
  ) {
    throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback event is malformed');
  }
  assertBoundedSubject(event.subject);

  let normalized: ControlFeedbackEvent;
  switch (event.kind) {
    case 'server.state.observed':
      normalized = {
        kind: event.kind,
        subject: normalizedSubject(event.subject),
        value: event.value,
        revision: event.revision,
        observedAt: event.observedAt,
      };
      break;
    case 'transport.acknowledged':
      if (!requiredString(event.operationId)) {
        throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback operation exceeds protocol limits');
      }
      normalized = {
        kind: event.kind,
        subject: normalizedSubject(event.subject),
        operationId: event.operationId,
        acknowledgedAt: event.acknowledgedAt,
      };
      break;
    case 'operation.failed':
      if (
        !requiredString(event.operationId)
        || !requiredString(event.code)
        || typeof event.message !== 'string'
        || event.message.length > MAX_FAILURE_MESSAGE_LENGTH
      ) {
        throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback failure exceeds protocol limits');
      }
      normalized = {
        kind: event.kind,
        subject: normalizedSubject(event.subject),
        operationId: event.operationId,
        code: event.code,
        message: event.message,
        failedAt: event.failedAt,
      };
      break;
    default:
      throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback event kind is unsupported');
  }

  try {
    reduceControlFeedback(createControlFeedbackState(normalized.subject), normalized);
  } catch (error) {
    if (error instanceof ControlFeedbackError) {
      throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', error.message);
    }
    throw error;
  }
  return normalized;
}

function normalizedUnsignedEnvelope(
  envelope: UnsignedControlFeedbackEnvelope | SignedControlFeedbackEnvelope,
): UnsignedControlFeedbackEnvelope {
  if (
    !envelope
    || typeof envelope !== 'object'
    || envelope.schemaVersion !== CONTROL_FEEDBACK_ENVELOPE_VERSION
    || !requiredString(envelope.issuerKeyId)
    || !requiredString(envelope.audienceCredentialId)
    || !Number.isSafeInteger(envelope.sequence)
    || envelope.sequence <= 0
  ) {
    throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback envelope is malformed');
  }
  return {
    schemaVersion: envelope.schemaVersion,
    issuerKeyId: envelope.issuerKeyId,
    audienceCredentialId: envelope.audienceCredentialId,
    sequence: envelope.sequence,
    event: normalizedEvent(envelope.event),
  };
}

export function controlFeedbackSigningBytes(
  envelope: UnsignedControlFeedbackEnvelope | SignedControlFeedbackEnvelope,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizedUnsignedEnvelope(envelope)));
}

export async function admitControlFeedback(
  envelope: SignedControlFeedbackEnvelope,
  authority: ControlFeedbackAuthorityContext,
  verifySignature: ControlFeedbackSignatureVerifier,
): Promise<AdmittedControlFeedback> {
  const unsigned = normalizedUnsignedEnvelope(envelope);
  if (!validSignature(envelope.signature)) {
    throw new ControlFeedbackAdmissionError('INVALID_ENVELOPE', 'Feedback signature is required');
  }
  if (unsigned.issuerKeyId !== authority.issuerKeyId) {
    throw new ControlFeedbackAdmissionError('UNTRUSTED_ISSUER', 'Feedback issuer is not pinned');
  }

  let verified = false;
  try {
    verified = await verifySignature(
      controlFeedbackSigningBytes(unsigned),
      envelope.signature,
      unsigned.issuerKeyId,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new ControlFeedbackAdmissionError('INVALID_SIGNATURE', 'Feedback signature is invalid');
  }
  if (unsigned.audienceCredentialId !== authority.audienceCredentialId) {
    throw new ControlFeedbackAdmissionError('AUDIENCE_FORBIDDEN', 'Feedback was issued for another credential');
  }
  if (!authority.scopes.includes('feedback:read')) {
    throw new ControlFeedbackAdmissionError('SCOPE_FORBIDDEN', 'Credential cannot read feedback');
  }

  const { subject } = unsigned.event;
  if (subject.showId !== authority.showId) {
    throw new ControlFeedbackAdmissionError('SHOW_FORBIDDEN', 'Feedback belongs to another Show');
  }
  if (!authority.targets.includes(subject.target)) {
    throw new ControlFeedbackAdmissionError('TARGET_FORBIDDEN', 'Feedback target is outside credential scope');
  }
  if (!authority.controlIds.includes(subject.controlId)) {
    throw new ControlFeedbackAdmissionError('CONTROL_FORBIDDEN', 'Feedback control is outside credential scope');
  }
  if (unsigned.sequence <= authority.lastAcceptedSequence) {
    throw new ControlFeedbackAdmissionError('FEEDBACK_REPLAYED', 'Feedback sequence was already admitted');
  }

  return {
    event: unsigned.event,
    acceptedSequence: unsigned.sequence,
  };
}
