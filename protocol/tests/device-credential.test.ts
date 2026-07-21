import {
  createHash,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_FEEDBACK_ENVELOPE_VERSION,
  admitControlFeedback,
  controlFeedbackSigningBytes,
  type UnsignedControlFeedbackEnvelope,
} from '../src/control-feedback-authority';
import {
  DeviceCredentialLifecycle,
  MemoryDeviceCredentialStore,
  type DeviceCredentialIssueInput,
  type DeviceCredentialOwner,
  type DeviceCredentialSecretCodec,
} from '../src/device-credential';

const OWNER: DeviceCredentialOwner = {
  principalId: 'owner-1',
  roles: ['owner', 'producer'],
};
const PRODUCER: DeviceCredentialOwner = {
  principalId: 'producer-1',
  roles: ['producer'],
};
const INPUT: DeviceCredentialIssueInput = {
  label: 'Production desk',
  showId: 'show-1',
  targets: ['program'],
  controlIds: ['lower-third.visibility'],
  scopes: ['feedback:read', 'component.visibility:write'],
  expiresAt: 10_000,
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const secretCodec: DeviceCredentialSecretCodec = {
  seal: digest,
  matches: (token, sealedSecret) => {
    const candidate = Buffer.from(digest(token), 'hex');
    const stored = Buffer.from(sealedSecret, 'hex');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  },
};

function harness() {
  let now = 1_000;
  let id = 0;
  let secret = 0;
  const store = new MemoryDeviceCredentialStore();
  const lifecycle = new DeviceCredentialLifecycle(store, {
    now: () => now,
    generateCredentialId: () => `device-${++id}`,
    generateSecret: () => `${String(++secret).padStart(4, '0')}${'s'.repeat(40)}`,
    secretCodec,
  });
  return {
    lifecycle,
    store,
    setNow(value: number) { now = value; },
  };
}

describe('device credential lifecycle', () => {
  it('issues a one-time opaque token while storing only its sealed secret', async () => {
    const { lifecycle, store } = harness();
    const issued = await lifecycle.issue(OWNER, INPUT);
    const stored = await store.get(issued.credential.credentialId);
    const authority = await lifecycle.authenticate(issued.token);

    expect(issued.token).toMatch(/^ok_device_device-1\./);
    expect(issued.credential).not.toHaveProperty('sealedSecret');
    expect(stored?.sealedSecret).toBe(digest(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(authority).toMatchObject({
      credentialId: 'device-1',
      audienceCredentialId: 'device-1.g1',
      generation: 1,
      showId: 'show-1',
      targets: ['program'],
      controlIds: ['lower-third.visibility'],
    });
    expect(authority).not.toHaveProperty('principalId');
    expect(authority).not.toHaveProperty('roles');
    await expect(lifecycle.authenticate(`${issued.token.slice(0, -1)}x`)).resolves.toBeNull();
    await expect(lifecycle.feedbackAuthority(
      issued.token,
      'server-key-1',
      -1,
    )).rejects.toMatchObject({ code: 'INVALID_DEVICE_CREDENTIAL' });
  });

  it('requires Owner authority and rejects malformed least-privilege grants', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(OWNER, INPUT);
    await expect(lifecycle.issue(PRODUCER, INPUT)).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(lifecycle.rotate(PRODUCER, issued.credential.credentialId)).rejects.toMatchObject({
      code: 'OWNER_REQUIRED',
    });
    await expect(lifecycle.revoke(PRODUCER, issued.credential.credentialId)).rejects.toMatchObject({
      code: 'OWNER_REQUIRED',
    });
    await expect(lifecycle.issue(OWNER, {
      ...INPUT,
      scopes: ['feedback:read', 'feedback:read'],
    })).rejects.toMatchObject({ code: 'INVALID_DEVICE_CREDENTIAL' });
    await expect(lifecycle.issue(OWNER, {
      ...INPUT,
      expiresAt: 1_000,
    })).rejects.toMatchObject({ code: 'INVALID_DEVICE_CREDENTIAL' });
  });

  it('authorizes only the exact Show, scope, target, and control', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(OWNER, INPUT);
    await expect(lifecycle.authorize(issued.token, {
      showId: 'show-1',
      scope: 'component.visibility:write',
      target: 'program',
      controlId: 'lower-third.visibility',
    })).resolves.toMatchObject({ credentialId: 'device-1' });

    for (const request of [
      { showId: 'show-2', scope: 'component.visibility:write', target: 'program', controlId: 'lower-third.visibility' },
      { showId: 'show-1', scope: 'production:take', target: 'program', controlId: 'lower-third.visibility' },
      { showId: 'show-1', scope: 'component.visibility:write', target: 'preview', controlId: 'lower-third.visibility' },
      { showId: 'show-1', scope: 'component.visibility:write', target: 'program', controlId: 'scoreboard.visibility' },
    ] as const) {
      await expect(lifecycle.authorize(issued.token, request)).rejects.toMatchObject({
        code: 'DEVICE_CREDENTIAL_FORBIDDEN',
      });
    }
  });

  it('rotates in place, increments generation, and invalidates the predecessor', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(OWNER, INPUT);
    const rotated = await lifecycle.rotate(OWNER, issued.credential.credentialId);

    expect(rotated.credential.credentialId).toBe(issued.credential.credentialId);
    expect(rotated.credential.generation).toBe(2);
    expect(rotated.token).not.toBe(issued.token);
    await expect(lifecycle.authenticate(issued.token)).resolves.toBeNull();
    await expect(lifecycle.authenticate(rotated.token)).resolves.toMatchObject({
      generation: 2,
      audienceCredentialId: 'device-1.g2',
    });
  });

  it('fails closed for expired and revoked credentials', async () => {
    const expired = harness();
    const expiring = await expired.lifecycle.issue(OWNER, INPUT);
    expired.setNow(INPUT.expiresAt);
    await expect(expired.lifecycle.authenticate(expiring.token)).resolves.toBeNull();
    await expect(expired.lifecycle.feedbackAuthority(
      expiring.token,
      'server-key-1',
      0,
    )).rejects.toMatchObject({ code: 'INVALID_DEVICE_CREDENTIAL' });
    await expect(expired.lifecycle.rotate(OWNER, expiring.credential.credentialId)).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_EXPIRED',
    });

    const revoked = harness();
    const issued = await revoked.lifecycle.issue(OWNER, INPUT);
    const first = await revoked.lifecycle.revoke(OWNER, issued.credential.credentialId);
    const second = await revoked.lifecycle.revoke(OWNER, issued.credential.credentialId);
    expect(first.revokedAt).toBe(1_000);
    expect(second).toEqual(first);
    await expect(revoked.lifecycle.authenticate(issued.token)).resolves.toBeNull();
    await expect(revoked.lifecycle.feedbackAuthority(
      issued.token,
      'server-key-1',
      0,
    )).rejects.toMatchObject({ code: 'INVALID_DEVICE_CREDENTIAL' });
    await expect(revoked.lifecycle.rotate(OWNER, issued.credential.credentialId)).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_REVOKED',
    });
  });

  it('binds admitted feedback to the authenticated credential audience', async () => {
    const { lifecycle } = harness();
    const issued = await lifecycle.issue(OWNER, INPUT);
    const second = await lifecycle.issue(OWNER, { ...INPUT, label: 'Backup desk' });
    const principal = await lifecycle.authenticate(issued.token);
    const otherPrincipal = await lifecycle.authenticate(second.token);
    expect(principal).not.toBeNull();
    expect(otherPrincipal).not.toBeNull();

    const keys = generateKeyPairSync('ed25519');
    const unsigned: UnsignedControlFeedbackEnvelope = {
      schemaVersion: CONTROL_FEEDBACK_ENVELOPE_VERSION,
      issuerKeyId: 'server-key-1',
      audienceCredentialId: principal!.audienceCredentialId,
      sequence: 1,
      event: {
        kind: 'server.state.observed',
        subject: {
          showId: 'show-1',
          target: 'program',
          controlId: 'lower-third.visibility',
        },
        value: 'active',
        revision: 1,
        observedAt: 1_000,
      },
    };
    const envelope = {
      ...unsigned,
      signature: sign(null, controlFeedbackSigningBytes(unsigned), keys.privateKey).toString('base64url'),
    };
    const verifier = (bytes: Uint8Array, signature: string): boolean => verify(
      null,
      bytes,
      keys.publicKey,
      Buffer.from(signature, 'base64url'),
    );

    await expect(admitControlFeedback(
      envelope,
      await lifecycle.feedbackAuthority(issued.token, 'server-key-1', 0),
      verifier,
    )).resolves.toMatchObject({ acceptedSequence: 1 });
    await expect(admitControlFeedback(
      envelope,
      await lifecycle.feedbackAuthority(second.token, 'server-key-1', 0),
      verifier,
    )).rejects.toMatchObject({ code: 'AUDIENCE_FORBIDDEN' });

    const rotated = await lifecycle.rotate(OWNER, issued.credential.credentialId);
    await expect(admitControlFeedback(
      envelope,
      await lifecycle.feedbackAuthority(rotated.token, 'server-key-1', 0),
      verifier,
    )).rejects.toMatchObject({ code: 'AUDIENCE_FORBIDDEN' });
  });
});
