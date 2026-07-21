import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_FEEDBACK_ENVELOPE_VERSION,
  admitControlFeedback,
  controlFeedbackSigningBytes,
  type ControlFeedbackAuthorityContext,
  type SignedControlFeedbackEnvelope,
  type UnsignedControlFeedbackEnvelope,
} from '../src/control-feedback-authority';
import {
  createControlFeedbackState,
  projectControlFeedback,
  reduceControlFeedback,
} from '../src/control-feedback';

const keys = generateKeyPairSync('ed25519');
const foreignKeys = generateKeyPairSync('ed25519');

const unsigned: UnsignedControlFeedbackEnvelope = {
  schemaVersion: CONTROL_FEEDBACK_ENVELOPE_VERSION,
  issuerKeyId: 'server-key-1',
  audienceCredentialId: 'device-credential-1',
  sequence: 1,
  event: {
    kind: 'server.state.observed',
    subject: {
      showId: 'show-1',
      target: 'program',
      controlId: 'lower-third.visibility',
    },
    value: 'active',
    revision: 4,
    observedAt: 1_000,
  },
};

const authority: ControlFeedbackAuthorityContext = {
  issuerKeyId: 'server-key-1',
  audienceCredentialId: 'device-credential-1',
  showId: 'show-1',
  targets: ['program'],
  controlIds: ['lower-third.visibility'],
  scopes: ['feedback:read'],
  lastAcceptedSequence: 0,
};

function signedEnvelope(
  value: UnsignedControlFeedbackEnvelope = unsigned,
  privateKey: KeyObject = keys.privateKey,
): SignedControlFeedbackEnvelope {
  return {
    ...value,
    signature: sign(null, controlFeedbackSigningBytes(value), privateKey).toString('base64url'),
  };
}

function verifier(publicKey: KeyObject = keys.publicKey) {
  return (bytes: Uint8Array, signature: string): boolean => verify(
    null,
    bytes,
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
}

describe('control feedback authority', () => {
  it('admits a signed event for the pinned issuer, audience, Show, target, and control', async () => {
    const admitted = await admitControlFeedback(signedEnvelope(), authority, verifier());
    const state = reduceControlFeedback(
      createControlFeedbackState(admitted.event.subject),
      admitted.event,
    );

    expect(admitted.acceptedSequence).toBe(1);
    expect(projectControlFeedback(state, 1_001)).toMatchObject({
      status: 'current',
      buttonState: 'active',
      truthScope: 'authoritative-server',
    });
  });

  it('rejects payload substitution after the server signature was created', async () => {
    const envelope = signedEnvelope();
    const substituted = {
      ...envelope,
      event: {
        ...envelope.event,
        subject: { ...envelope.event.subject, showId: 'show-2' },
      },
    } as SignedControlFeedbackEnvelope;

    await expect(admitControlFeedback(substituted, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });

  it('rejects an unpinned issuer and a signature from another key', async () => {
    await expect(admitControlFeedback(signedEnvelope({
      ...unsigned,
      issuerKeyId: 'server-key-2',
    }, foreignKeys.privateKey), authority, verifier())).rejects.toMatchObject({
      code: 'UNTRUSTED_ISSUER',
    });
    await expect(admitControlFeedback(
      signedEnvelope(unsigned, foreignKeys.privateKey),
      authority,
      verifier(),
    )).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('rejects a valid server signature issued for another credential audience', async () => {
    const envelope = signedEnvelope({
      ...unsigned,
      audienceCredentialId: 'device-credential-2',
    });

    await expect(admitControlFeedback(envelope, authority, verifier())).rejects.toMatchObject({
      code: 'AUDIENCE_FORBIDDEN',
    });
  });

  it('enforces feedback scope and exact Show, target, and control authorization', async () => {
    await expect(admitControlFeedback(signedEnvelope(), {
      ...authority,
      scopes: [],
    }, verifier())).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    await expect(admitControlFeedback(signedEnvelope(), {
      ...authority,
      showId: 'show-2',
    }, verifier())).rejects.toMatchObject({ code: 'SHOW_FORBIDDEN' });
    await expect(admitControlFeedback(signedEnvelope(), {
      ...authority,
      targets: ['preview'],
    }, verifier())).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN' });
    await expect(admitControlFeedback(signedEnvelope(), {
      ...authority,
      controlIds: ['scoreboard.visibility'],
    }, verifier())).rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
  });

  it('rejects replay at or below the last admitted sequence', async () => {
    await expect(admitControlFeedback(signedEnvelope(), {
      ...authority,
      lastAcceptedSequence: 1,
    }, verifier())).rejects.toMatchObject({ code: 'FEEDBACK_REPLAYED' });
  });

  it('normalizes the signed event so unsigned extra properties never reach the projector', async () => {
    const eventWithExtra = {
      ...unsigned.event,
      privileged: true,
    };
    const value = { ...unsigned, event: eventWithExtra } as UnsignedControlFeedbackEnvelope;
    const admitted = await admitControlFeedback(signedEnvelope(value), authority, verifier());

    expect(admitted.event).not.toHaveProperty('privileged');
  });

  it('rejects malformed runtime subjects, event kinds, and missing signatures deterministically', async () => {
    const malformedSubject = {
      ...signedEnvelope(),
      event: { ...unsigned.event, subject: null },
    } as unknown as SignedControlFeedbackEnvelope;
    const unknownKind = {
      ...signedEnvelope(),
      event: { ...unsigned.event, kind: 'server.maybe.observed' },
    } as unknown as SignedControlFeedbackEnvelope;
    const missingSignature = {
      ...signedEnvelope(),
      signature: '',
    };

    await expect(admitControlFeedback(malformedSubject, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
    await expect(admitControlFeedback(unknownKind, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
    await expect(admitControlFeedback(missingSignature, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
  });

  it('bounds untrusted fields before signature verification and canonicalization', async () => {
    const oversizedControl = {
      ...signedEnvelope(),
      event: {
        ...unsigned.event,
        subject: { ...unsigned.event.subject, controlId: 'x'.repeat(201) },
      },
    } as SignedControlFeedbackEnvelope;
    const oversizedSignature = {
      ...signedEnvelope(),
      signature: 'x'.repeat(4_097),
    };

    await expect(admitControlFeedback(oversizedControl, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
    await expect(admitControlFeedback(oversizedSignature, authority, verifier())).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
  });
});
