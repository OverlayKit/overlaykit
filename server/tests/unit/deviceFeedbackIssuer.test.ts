import {
  generateKeyPairSync,
  sign as signBytes,
  verify,
  type KeyObject,
} from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  admitControlFeedback,
  type ControlFeedbackAuthorityContext,
} from '@overlaykit/protocol/control-feedback-authority';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import { ChannelManager } from '../../src/services/ChannelManager';
import {
  createDeviceActionCatalogRuntime,
} from '../../src/services/DeviceActionCatalogRuntime';
import {
  createDeviceFeedbackIssuerRuntime,
  DeviceFeedbackIssuerError,
  type DeviceFeedbackSigner,
} from '../../src/services/DeviceFeedbackIssuer';
import type { FeedbackSequenceStore } from '../../src/services/FileFeedbackSequenceStore';
import { ProductionService } from '../../src/services/ProductionService';

class MemoryFeedbackSequenceStore implements FeedbackSequenceStore {
  readonly init = vi.fn(async () => undefined);
  readonly reservations: Array<{
    issuerKeyId: string;
    audienceCredentialId: string;
    count: number;
  }> = [];
  private readonly values = new Map<string, number>();

  async reserve(
    issuerKeyId: string,
    audienceCredentialId: string,
    count: number,
  ): Promise<ReadonlyArray<number>> {
    this.reservations.push({ issuerKeyId, audienceCredentialId, count });
    const key = JSON.stringify([issuerKeyId, audienceCredentialId]);
    const first = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, first + count - 1);
    return Array.from({ length: count }, (_value, index) => first + index);
  }
}

function authority(overrides: Partial<DeviceCredentialAuthority> = {}): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    targets: ['preview'],
    controlIds: ['alpha.visibility', 'zulu.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: 10_000,
    ...overrides,
  };
}

function production(): ProductionService {
  const service = new ProductionService(new ChannelManager(), { allowEphemeral: true });
  service.loadPreview('show-1', {
    id: 'scene-1',
    name: 'Feedback scene',
    elements: [
      { id: 'zulu', tag: 'div', content: 'Zulu', styles: {} },
      { id: 'alpha', tag: 'div', content: 'Alpha', styles: { display: 'none' } },
    ],
  });
  return service;
}

function signer(
  privateKey: KeyObject,
  implementation?: (bytes: Uint8Array) => string | Promise<string>,
): DeviceFeedbackSigner {
  return {
    issuerKeyId: 'server-key-1',
    sign: implementation ?? ((bytes) => (
      signBytes(null, bytes, privateKey).toString('base64url')
    )),
  };
}

function admissionAuthority(
  device: DeviceCredentialAuthority,
  lastAcceptedSequence: number,
): ControlFeedbackAuthorityContext {
  return {
    issuerKeyId: 'server-key-1',
    audienceCredentialId: device.audienceCredentialId,
    showId: device.showId,
    targets: [...device.targets],
    controlIds: [...device.controlIds],
    scopes: device.scopes.includes('feedback:read') ? ['feedback:read'] : [],
    lastAcceptedSequence,
  };
}

describe('DeviceFeedbackIssuer', () => {
  it('issues canonical ordered envelopes that round-trip through feedback admission', async () => {
    const keys = generateKeyPairSync('ed25519');
    const device = authority();
    const credentials = { authenticate: vi.fn(async () => device) };
    const sequences = new MemoryFeedbackSequenceStore();
    const service = production();
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials,
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: signer(keys.privateKey),
      sequenceStore: sequences,
    });
    const snapshot = service.getSnapshot('show-1', 'preview');

    const envelopes = await issuer.issueVisibility({
      token: 'device-token',
      showId: 'show-1',
      target: 'preview',
      observedAt: (snapshot.updatedAt as number) + 1,
    });

    expect(credentials.authenticate).toHaveBeenCalledWith('device-token');
    expect(envelopes.map((envelope) => ({
      sequence: envelope.sequence,
      audience: envelope.audienceCredentialId,
      controlId: envelope.event.subject.controlId,
      value: envelope.event.kind === 'server.state.observed' ? envelope.event.value : null,
      revision: envelope.event.kind === 'server.state.observed' ? envelope.event.revision : null,
    }))).toEqual([
      {
        sequence: 1,
        audience: 'device-1.g1',
        controlId: 'alpha.visibility',
        value: 'inactive',
        revision: 1,
      },
      {
        sequence: 2,
        audience: 'device-1.g1',
        controlId: 'zulu.visibility',
        value: 'active',
        revision: 1,
      },
    ]);

    let lastAcceptedSequence = 0;
    for (const envelope of envelopes) {
      const admitted = await admitControlFeedback(
        envelope,
        admissionAuthority(device, lastAcceptedSequence),
        (bytes, signature) => verify(
          null,
          bytes,
          keys.publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      );
      lastAcceptedSequence = admitted.acceptedSequence;
    }
    expect(lastAcceptedSequence).toBe(2);

    const first = envelopes[0];
    if (first.event.kind !== 'server.state.observed') throw new Error('Expected state feedback');
    await expect(admitControlFeedback(
      {
        ...first,
        event: { ...first.event, value: 'active' },
      },
      admissionAuthority(device, 0),
      (bytes, signature) => verify(
        null,
        bytes,
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    )).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('captures request, audience, and issuer authority before asynchronous reservation', async () => {
    const keys = generateKeyPairSync('ed25519');
    const device = authority();
    const mutableSigner = signer(keys.privateKey) as DeviceFeedbackSigner & {
      issuerKeyId: string;
    };
    const request = {
      token: 'device-token',
      showId: 'show-1',
      target: 'preview' as const,
      observedAt: production().getSnapshot('show-1', 'preview').updatedAt as number,
    };
    const sequences: FeedbackSequenceStore = {
      init: async () => undefined,
      reserve: async () => {
        mutableSigner.issuerKeyId = 'attacker-key';
        (device as DeviceCredentialAuthority & { audienceCredentialId: string })
          .audienceCredentialId = 'attacker-audience';
        request.showId = 'attacker-show';
        return [1, 2];
      },
    };
    const service = production();
    request.observedAt = service.getSnapshot('show-1', 'preview').updatedAt as number;
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: { authenticate: async () => device },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: mutableSigner,
      sequenceStore: sequences,
    });

    const envelopes = await issuer.issueVisibility(request);

    expect(envelopes.every((envelope) => envelope.issuerKeyId === 'server-key-1')).toBe(true);
    expect(envelopes.every((envelope) => (
      envelope.audienceCredentialId === 'device-1.g1'
      && envelope.event.subject.showId === 'show-1'
    ))).toBe(true);
  });

  it('freshly authenticates and moves a rotated credential audience to its own sequence', async () => {
    const keys = generateKeyPairSync('ed25519');
    let currentAuthority: DeviceCredentialAuthority | null = authority();
    const credentials = { authenticate: vi.fn(async () => currentAuthority) };
    const sequences = new MemoryFeedbackSequenceStore();
    const service = production();
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials,
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: signer(keys.privateKey),
      sequenceStore: sequences,
    });
    const firstTime = service.getSnapshot('show-1', 'preview').updatedAt as number;
    const first = await issuer.issueVisibility({
      token: 'generation-1', showId: 'show-1', target: 'preview', observedAt: firstTime,
    });

    service.executeVisibilityIntent({
      kind: 'component.visibility',
      showId: 'show-1',
      target: 'preview',
      componentId: 'alpha',
      visible: true,
      operationId: 'show-alpha',
      expectedRevision: 1,
    }, { directProgram: false });
    currentAuthority = authority({
      audienceCredentialId: 'device-1.g2',
      generation: 2,
    });
    const secondTime = service.getSnapshot('show-1', 'preview').updatedAt as number;
    const second = await issuer.issueVisibility({
      token: 'generation-2', showId: 'show-1', target: 'preview', observedAt: secondTime,
    });

    expect(first.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    expect(second.map((envelope) => envelope.sequence)).toEqual([1, 2]);
    expect(second.every((envelope) => envelope.audienceCredentialId === 'device-1.g2')).toBe(true);
    expect(second.every((envelope) => (
      envelope.event.kind === 'server.state.observed' && envelope.event.revision === 2
    ))).toBe(true);

    currentAuthority = null;
    await expect(issuer.issueVisibility({
      token: 'revoked', showId: 'show-1', target: 'preview', observedAt: secondTime,
    })).rejects.toMatchObject({ code: 'DEVICE_FEEDBACK_AUTH_REQUIRED' });
    expect(credentials.authenticate).toHaveBeenCalledTimes(3);
  });

  it('denies wrong Show, target, and feedback scope before reserving or signing', async () => {
    const keys = generateKeyPairSync('ed25519');
    const sequences = new MemoryFeedbackSequenceStore();
    const sign = vi.fn(signer(keys.privateKey).sign);
    let currentAuthority = authority();
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: production(),
      credentials: { authenticate: async () => currentAuthority },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: { issuerKeyId: 'server-key-1', sign },
      sequenceStore: sequences,
    });

    for (const candidate of [
      authority({ showId: 'show-2' }),
      authority({ targets: ['program'] }),
      authority({ scopes: ['component.visibility:write'] }),
    ]) {
      currentAuthority = candidate;
      await expect(issuer.issueVisibility({
        token: 'device-token',
        showId: 'show-1',
        target: 'preview',
        observedAt: Date.now(),
      })).rejects.toMatchObject({ code: 'DEVICE_FEEDBACK_FORBIDDEN' });
    }

    expect(sequences.reservations).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
  });

  it('returns no partial batch and never reuses sequences after signing failure', async () => {
    const keys = generateKeyPairSync('ed25519');
    const sequences = new MemoryFeedbackSequenceStore();
    let signingAttempt = 0;
    let shouldFail = true;
    const sign = vi.fn((bytes: Uint8Array): string => {
      signingAttempt += 1;
      if (shouldFail && signingAttempt === 2) throw new Error('signer unavailable');
      return signBytes(null, bytes, keys.privateKey).toString('base64url');
    });
    const service = production();
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: { authenticate: async () => authority() },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: { issuerKeyId: 'server-key-1', sign },
      sequenceStore: sequences,
    });
    const observedAt = service.getSnapshot('show-1', 'preview').updatedAt as number;

    await expect(issuer.issueVisibility({
      token: 'device-token', showId: 'show-1', target: 'preview', observedAt,
    })).rejects.toThrow('signer unavailable');
    shouldFail = false;
    const recovered = await issuer.issueVisibility({
      token: 'device-token', showId: 'show-1', target: 'preview', observedAt,
    });

    expect(recovered.map((envelope) => envelope.sequence)).toEqual([3, 4]);
    expect(sequences.reservations.map((reservation) => reservation.count)).toEqual([2, 2]);
  });

  it('fails before signing when projection, reservation, or signature output is invalid', async () => {
    const keys = generateKeyPairSync('ed25519');
    const service = production();
    const sign = vi.fn(signer(keys.privateKey).sign);
    const actionCatalog = await createDeviceActionCatalogRuntime();
    const beforeSnapshot = (service.getSnapshot('show-1', 'preview').updatedAt as number) - 1;
    const sequences = new MemoryFeedbackSequenceStore();
    const projectionIssuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: { authenticate: async () => authority() },
      actionCatalog,
      signer: { issuerKeyId: 'server-key-1', sign },
      sequenceStore: sequences,
    });
    await expect(projectionIssuer.issueVisibility({
      token: 'device-token', showId: 'show-1', target: 'preview', observedAt: beforeSnapshot,
    })).rejects.toMatchObject({ code: 'OBSERVATION_BEFORE_SNAPSHOT' });
    expect(sequences.reservations).toHaveLength(0);

    const invalidReservation: FeedbackSequenceStore = {
      init: async () => undefined,
      reserve: async () => [1, 1],
    };
    const reservationIssuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: { authenticate: async () => authority() },
      actionCatalog,
      signer: { issuerKeyId: 'server-key-1', sign },
      sequenceStore: invalidReservation,
    });
    await expect(reservationIssuer.issueVisibility({
      token: 'device-token',
      showId: 'show-1',
      target: 'preview',
      observedAt: service.getSnapshot('show-1', 'preview').updatedAt as number,
    })).rejects.toMatchObject<DeviceFeedbackIssuerError>({
      code: 'INVALID_FEEDBACK_SEQUENCE_RESERVATION',
    });

    const invalidSignerIssuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: { authenticate: async () => authority() },
      actionCatalog,
      signer: signer(keys.privateKey, () => ''),
      sequenceStore: new MemoryFeedbackSequenceStore(),
    });
    await expect(invalidSignerIssuer.issueVisibility({
      token: 'device-token',
      showId: 'show-1',
      target: 'preview',
      observedAt: service.getSnapshot('show-1', 'preview').updatedAt as number,
    })).rejects.toMatchObject({ code: 'INVALID_FEEDBACK_SIGNATURE' });
  });

  it('returns an empty batch without sequence reservation when no actions are authorized', async () => {
    const keys = generateKeyPairSync('ed25519');
    const sequences = new MemoryFeedbackSequenceStore();
    const sign = vi.fn(signer(keys.privateKey).sign);
    const service = production();
    const issuer = await createDeviceFeedbackIssuerRuntime({
      production: service,
      credentials: {
        authenticate: async () => authority({ scopes: ['feedback:read'] }),
      },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: { issuerKeyId: 'server-key-1', sign },
      sequenceStore: sequences,
    });

    await expect(issuer.issueVisibility({
      token: 'device-token',
      showId: 'show-1',
      target: 'preview',
      observedAt: service.getSnapshot('show-1', 'preview').updatedAt as number,
    })).resolves.toEqual([]);
    expect(sequences.reservations).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
  });

  it('initializes persistence and protocol ports before exposing the runtime', async () => {
    const authorityProtocol = await import('@overlaykit/protocol/control-feedback-authority');
    const visibilityProtocol = await import('@overlaykit/protocol/control-visibility-feedback');
    const keys = generateKeyPairSync('ed25519');
    const sequences = new MemoryFeedbackSequenceStore();
    const loadAuthorityProtocol = vi.fn(async () => authorityProtocol);
    const loadVisibilityProtocol = vi.fn(async () => ({
      projectServerVisibilityFeedback: (
        snapshot: ReturnType<ProductionService['getSnapshot']>,
        catalog: Parameters<typeof visibilityProtocol.projectServerVisibilityFeedback>[1],
        observedAt: number,
      ) => visibilityProtocol.projectServerVisibilityFeedback(
        snapshot as Parameters<typeof visibilityProtocol.projectServerVisibilityFeedback>[0],
        catalog,
        observedAt,
      ),
    }));

    await createDeviceFeedbackIssuerRuntime({
      production: production(),
      credentials: { authenticate: async () => authority() },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: signer(keys.privateKey),
      sequenceStore: sequences,
      loadAuthorityProtocol,
      loadVisibilityProtocol,
    });

    expect(sequences.init).toHaveBeenCalledTimes(1);
    expect(loadAuthorityProtocol).toHaveBeenCalledTimes(1);
    expect(loadVisibilityProtocol).toHaveBeenCalledTimes(1);

    await expect(createDeviceFeedbackIssuerRuntime({
      production: production(),
      credentials: { authenticate: async () => authority() },
      actionCatalog: await createDeviceActionCatalogRuntime(),
      signer: signer(keys.privateKey),
      sequenceStore: new MemoryFeedbackSequenceStore(),
      loadAuthorityProtocol: async () => { throw new Error('protocol unavailable'); },
    })).rejects.toThrow('protocol unavailable');
  });
});
