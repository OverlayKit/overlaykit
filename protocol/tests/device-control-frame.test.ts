import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_ACTION_CATALOG_VERSION,
  type AuthorizedControlActionCatalog,
  type ComponentVisibilityActionDescriptor,
} from '../src/control-action-catalog.js';
import type { AuthoritativeServerObservation } from '../src/control-feedback.js';
import {
  DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,
  DEVICE_CONTROL_CATALOG_VERSION,
  DEVICE_CONTROL_FRAME_VERSION,
  admitDeviceControlFrame,
  buildDeviceControlBootstrapFrame,
  buildDeviceControlDeltaFrame,
  deviceControlCatalogBytes,
  deviceControlCatalogHash,
  deviceControlFramePayloadBytes,
  projectDeviceControl,
  reduceAdmittedDeviceControlFrame,
  reduceDeviceControlFrame,
  type DeviceControlFrame,
  type DeviceControlFrameAuthorityContext,
  type DeviceControlFrameInput,
  type DeviceControlFrameState,
  type UnsignedDeviceControlFrameEnvelope,
} from '../src/device-control-frame.js';
import type { ProductionBus } from '../src/production.js';

function action(
  componentId: string,
  label = componentId,
  target: ProductionBus = 'preview',
  showId = 'show-1'
): ComponentVisibilityActionDescriptor {
  return {
    actionId: `component.visibility/${target}/${encodeURIComponent(componentId)}`,
    kind: 'component.visibility',
    subject: { showId, target, controlId: `${componentId}.visibility` },
    componentId,
    label,
    input: { visible: { type: 'boolean', required: true } },
  };
}

function catalog(
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>,
  showId = 'show-1'
): AuthorizedControlActionCatalog {
  return {
    schemaVersion: CONTROL_ACTION_CATALOG_VERSION,
    showId,
    actions,
  };
}

function observation(
  componentId: string,
  value: 'active' | 'inactive',
  revision: number,
  observedAt: number,
  target: ProductionBus = 'preview',
  showId = 'show-1'
): AuthoritativeServerObservation {
  return {
    kind: 'server.state.observed',
    subject: { showId, target, controlId: `${componentId}.visibility` },
    value,
    revision,
    observedAt,
  };
}

function input(
  actions: ReadonlyArray<ComponentVisibilityActionDescriptor>,
  observations: ReadonlyArray<AuthoritativeServerObservation>,
  revision: number,
  confirmedAt: number,
  target: ProductionBus = 'preview',
  catalogGeneration = 1
): DeviceControlFrameInput {
  return {
    showId: 'show-1',
    target,
    revision,
    catalogGeneration,
    confirmedAt,
    catalog: catalog(actions),
    observations,
  };
}

function unsignedEnvelope(
  frame: DeviceControlFrame,
  overrides: Partial<UnsignedDeviceControlFrameEnvelope> = {}
): UnsignedDeviceControlFrameEnvelope {
  return {
    schemaVersion: DEVICE_CONTROL_FRAME_ENVELOPE_VERSION,
    issuerKeyId: 'server-key-1',
    audienceCredentialId: 'device-1.g1',
    sequence: 1,
    baseIssuerKeyId: null,
    baseSequence: null,
    baseSha256: null,
    frame,
    ...overrides,
  };
}

interface SignedPayload {
  readonly payloadBytes: Uint8Array;
  readonly signature: string;
  readonly unsigned: UnsignedDeviceControlFrameEnvelope;
}

function signedPayload(
  frame: DeviceControlFrame,
  privateKey: KeyObject,
  overrides: Partial<UnsignedDeviceControlFrameEnvelope> = {}
): SignedPayload {
  const unsigned = unsignedEnvelope(frame, overrides);
  const payloadBytes = deviceControlFramePayloadBytes(unsigned);
  return {
    payloadBytes,
    signature: signBytes(null, payloadBytes, privateKey).toString('base64url'),
    unsigned,
  };
}

function authority(
  overrides: Partial<DeviceControlFrameAuthorityContext> = {}
): DeviceControlFrameAuthorityContext {
  return {
    issuerKeyId: 'server-key-1',
    audienceCredentialId: 'device-1.g1',
    showId: 'show-1',
    targets: ['preview'],
    controlIds: ['alpha.visibility', 'beta.visibility', 'zulu.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    lastAcceptedSequence: 0,
    ...overrides,
  };
}

function verifier(publicKey: KeyObject) {
  return (bytes: Uint8Array, signature: string) =>
    verifyBytes(null, bytes, publicKey, Buffer.from(signature, 'base64url'));
}

function admit(
  signed: SignedPayload,
  acceptedAuthority: DeviceControlFrameAuthorityContext,
  verify: ReturnType<typeof verifier> | (() => boolean)
) {
  return admitDeviceControlFrame(signed.payloadBytes, signed.signature, acceptedAuthority, verify);
}

async function initialState(): Promise<DeviceControlFrameState> {
  const frame = await buildDeviceControlBootstrapFrame(
    input(
      [action('zulu', 'Zulu'), action('alpha', 'Alpha')],
      [observation('zulu', 'active', 1, 1_000), observation('alpha', 'inactive', 1, 1_000)],
      1,
      1_000
    )
  );
  return reduceDeviceControlFrame(null, frame);
}

describe('device control frames', () => {
  it('builds, signs, admits, and reduces a canonical complete bootstrap', async () => {
    const keys = generateKeyPairSync('ed25519');
    const source = input(
      [action('zulu', 'Zulu'), action('alpha', 'Alpha')],
      [observation('zulu', 'active', 3, 1_000), observation('alpha', 'inactive', 3, 1_000)],
      3,
      1_000
    );
    const before = structuredClone(source);
    const frame = await buildDeviceControlBootstrapFrame(source);
    const signed = signedPayload(frame, keys.privateKey);

    const admitted = await admitDeviceControlFrame(
      signed.payloadBytes,
      signed.signature,
      authority(),
      verifier(keys.publicKey)
    );
    const state = await reduceDeviceControlFrame(null, admitted.frame);

    expect(source).toEqual(before);
    expect(frame.addedActions.map((item) => item.subject.controlId)).toEqual([
      'alpha.visibility',
      'zulu.visibility',
    ]);
    expect(frame.observations.map((item) => item.subject.controlId)).toEqual([
      'alpha.visibility',
      'zulu.visibility',
    ]);
    expect(admitted.acceptedSequence).toBe(1);
    expect(state.controls.map((entry) => [entry.action.subject.controlId, entry.value])).toEqual([
      ['alpha.visibility', 'inactive'],
      ['zulu.visibility', 'active'],
    ]);
    expect(state.catalogHash).toBe(
      await deviceControlCatalogHash(
        'show-1',
        'preview',
        state.controls.map((entry) => entry.action)
      )
    );
    expect(projectDeviceControl(state, action('alpha').subject, 3_999)).toMatchObject({
      available: true,
      status: 'current',
      buttonState: 'inactive',
      reason: 'revision-confirmed',
    });
    expect(projectDeviceControl(state, action('alpha').subject, 4_000)).toMatchObject({
      available: true,
      status: 'stale',
      buttonState: 'unknown',
      reason: 'confirmation-timeout',
    });

    const tamperedPayload = deviceControlFramePayloadBytes({
      ...signed.unsigned,
      frame: {
        ...signed.unsigned.frame,
        observations: signed.unsigned.frame.observations.map((item) =>
          item.subject.controlId === 'alpha.visibility' ? { ...item, value: 'active' } : item
        ),
      },
    });
    await expect(
      admitDeviceControlFrame(
        tamperedPayload,
        signed.signature,
        authority(),
        verifier(keys.publicKey)
      )
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('emits only changed values and renews unchanged controls with a lease-only delta', async () => {
    const state = await initialState();
    const changed = await buildDeviceControlDeltaFrame(
      state,
      input(
        [action('alpha', 'Alpha'), action('zulu', 'Zulu')],
        [observation('alpha', 'active', 2, 1_500), observation('zulu', 'active', 2, 1_500)],
        2,
        1_500
      )
    );

    expect(changed.addedActions).toEqual([]);
    expect(changed.removedControlIds).toEqual([]);
    expect(changed.observations.map((item) => [item.subject.controlId, item.value])).toEqual([
      ['alpha.visibility', 'active'],
    ]);
    const changedState = await reduceDeviceControlFrame(state, changed);
    const zuluBeforeLease = changedState.controls.find(
      (entry) => entry.action.subject.controlId === 'zulu.visibility'
    );
    expect(zuluBeforeLease).toMatchObject({
      value: 'active',
      valueRevision: 1,
      valueObservedAt: 1_000,
    });

    const lease = await buildDeviceControlDeltaFrame(
      changedState,
      input(
        [action('zulu', 'Zulu'), action('alpha', 'Alpha')],
        [observation('zulu', 'active', 2, 3_500), observation('alpha', 'active', 2, 3_500)],
        2,
        3_500
      )
    );
    expect(lease.addedActions).toEqual([]);
    expect(lease.removedControlIds).toEqual([]);
    expect(lease.observations).toEqual([]);

    const renewed = await reduceDeviceControlFrame(changedState, lease);
    expect(projectDeviceControl(renewed, action('zulu').subject, 6_499)).toMatchObject({
      status: 'current',
      buttonState: 'active',
      valueObservedAt: 1_000,
      confirmedAt: 3_500,
    });
    expect(projectDeviceControl(renewed, action('zulu').subject, 6_500)).toMatchObject({
      status: 'stale',
      buttonState: 'unknown',
    });
  });

  it('advances a shared catalog generation without inventing a target-local change', async () => {
    const state = await initialState();
    const generationOnly = await buildDeviceControlDeltaFrame(
      state,
      input(
        [action('alpha', 'Alpha'), action('zulu', 'Zulu')],
        [observation('alpha', 'inactive', 1, 1_500), observation('zulu', 'active', 1, 1_500)],
        1,
        1_500,
        'preview',
        2
      )
    );
    expect(generationOnly).toMatchObject({
      catalogGeneration: 2,
      addedActions: [],
      removedControlIds: [],
      observations: [],
    });
    const advanced = await reduceDeviceControlFrame(state, generationOnly);
    expect(advanced.catalogGeneration).toBe(2);

    await expect(
      buildDeviceControlDeltaFrame(
        advanced,
        input(
          [action('alpha', 'Alpha'), action('zulu', 'Zulu')],
          [observation('alpha', 'inactive', 1, 2_000), observation('zulu', 'active', 1, 2_000)],
          1,
          2_000,
          'preview',
          1
        )
      )
    ).rejects.toMatchObject({ code: 'OUT_OF_ORDER_FRAME' });
  });

  it('atomically removes unavailable controls and adds controls with initial state', async () => {
    const state = await initialState();
    const delta = await buildDeviceControlDeltaFrame(
      state,
      input(
        [action('alpha', 'Alpha'), action('beta', 'Beta')],
        [observation('alpha', 'inactive', 2, 2_000), observation('beta', 'active', 2, 2_000)],
        2,
        2_000,
        'preview',
        2
      )
    );

    expect(delta.removedControlIds).toEqual(['zulu.visibility']);
    expect(delta.addedActions.map((item) => item.subject.controlId)).toEqual(['beta.visibility']);
    expect(delta.observations.map((item) => item.subject.controlId)).toEqual(['beta.visibility']);
    const next = await reduceDeviceControlFrame(state, delta);
    expect(next.controls.map((entry) => entry.action.subject.controlId)).toEqual([
      'alpha.visibility',
      'beta.visibility',
    ]);
    expect(projectDeviceControl(next, action('zulu').subject, 2_001)).toEqual({
      available: false,
      subject: action('zulu').subject,
      status: 'unavailable',
      buttonState: 'unavailable',
      reason: 'not-in-authorized-catalog',
    });
    expect(projectDeviceControl(next, action('beta').subject, 2_001)).toMatchObject({
      available: true,
      buttonState: 'active',
      valueRevision: 2,
    });

    const before = structuredClone(state);
    await expect(
      reduceDeviceControlFrame(state, {
        ...delta,
        catalogHash: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'CATALOG_HASH_MISMATCH' });
    expect(state).toEqual(before);
  });

  it('represents descriptor replacement as one remove-plus-add with fresh state', async () => {
    const state = await initialState();
    const delta = await buildDeviceControlDeltaFrame(
      state,
      input(
        [action('alpha', 'Renamed alpha'), action('zulu', 'Zulu')],
        [observation('alpha', 'inactive', 2, 2_000), observation('zulu', 'active', 2, 2_000)],
        2,
        2_000,
        'preview',
        2
      )
    );

    expect(delta.removedControlIds).toEqual(['alpha.visibility']);
    expect(delta.addedActions).toHaveLength(1);
    expect(delta.addedActions[0].label).toBe('Renamed alpha');
    expect(delta.observations.map((item) => item.subject.controlId)).toEqual(['alpha.visibility']);
    const next = await reduceDeviceControlFrame(state, delta);
    expect(next.controls[0]).toMatchObject({
      action: { label: 'Renamed alpha' },
      value: 'inactive',
      valueRevision: 2,
    });
  });

  it('normalizes code-unit ordering for hashes and signatures without mutating inputs', async () => {
    const forward = [action('Alpha'), action('alpha'), action('zulu')];
    const reverse = [...forward].reverse();
    expect(await deviceControlCatalogHash('show-1', 'preview', forward)).toBe(
      await deviceControlCatalogHash('show-1', 'preview', reverse)
    );
    const catalogBytes = Buffer.from(deviceControlCatalogBytes('show-1', 'preview', forward));
    expect(catalogBytes).toEqual(
      Buffer.from(deviceControlCatalogBytes('show-1', 'preview', reverse))
    );
    expect(JSON.parse(catalogBytes.toString())).toMatchObject({
      schemaVersion: DEVICE_CONTROL_CATALOG_VERSION,
      showId: 'show-1',
      target: 'preview',
    });
    expect(await deviceControlCatalogHash('show-1', 'preview', forward)).toBe(
      createHash('sha256').update(catalogBytes).digest('hex')
    );

    const frame = await buildDeviceControlBootstrapFrame(
      input(
        reverse,
        [
          observation('zulu', 'active', 1, 1_000),
          observation('alpha', 'active', 1, 1_000),
          observation('Alpha', 'inactive', 1, 1_000),
        ],
        1,
        1_000
      )
    );
    const reordered: DeviceControlFrame = {
      ...frame,
      addedActions: [...frame.addedActions].reverse(),
      observations: [...frame.observations].reverse(),
    };
    expect(Buffer.from(deviceControlFramePayloadBytes(unsignedEnvelope(frame)))).toEqual(
      Buffer.from(deviceControlFramePayloadBytes(unsignedEnvelope(reordered)))
    );
    expect(frame.addedActions.map((item) => item.subject.controlId)).toEqual([
      'Alpha.visibility',
      'alpha.visibility',
      'zulu.visibility',
    ]);
  });

  it('rejects incomplete, malformed, duplicate, and oversized bootstrap input', async () => {
    await expect(
      buildDeviceControlBootstrapFrame(
        input(
          [action('alpha'), action('zulu')],
          [observation('alpha', 'active', 1, 1_000)],
          1,
          1_000
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_OBSERVATION' });

    await expect(
      buildDeviceControlBootstrapFrame(
        input([action('alpha')], [observation('alpha', 'active', 2, 1_000)], 1, 1_000)
      )
    ).rejects.toMatchObject({ code: 'INVALID_OBSERVATION' });

    await expect(
      buildDeviceControlBootstrapFrame(
        input(
          [action('alpha'), action('alpha')],
          [observation('alpha', 'active', 1, 1_000)],
          1,
          1_000
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });

    const tooMany = Array.from({ length: 1_001 }, (_value, index) => action(`item-${index}`));
    await expect(
      buildDeviceControlBootstrapFrame(input(tooMany, [], 1, 1_000))
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });

    const malformed = action('alpha') as ComponentVisibilityActionDescriptor & {
      actionId: string;
    };
    malformed.actionId = 'attacker/action';
    await expect(
      buildDeviceControlBootstrapFrame(
        input([malformed], [observation('alpha', 'active', 1, 1_000)], 1, 1_000)
      )
    ).rejects.toMatchObject({ code: 'INVALID_CATALOG' });
  });

  it('fails closed for unsupported state transitions without partial mutation', async () => {
    const state = await initialState();
    const before = structuredClone(state);
    await expect(
      buildDeviceControlDeltaFrame(
        state,
        input(
          [action('alpha', 'Alpha'), action('zulu', 'Zulu')],
          [observation('alpha', 'active', 1, 1_500), observation('zulu', 'active', 1, 1_500)],
          1,
          1_500
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const lease = await buildDeviceControlDeltaFrame(
      state,
      input(
        [action('alpha', 'Alpha'), action('zulu', 'Zulu')],
        [observation('alpha', 'inactive', 1, 1_500), observation('zulu', 'active', 1, 1_500)],
        1,
        1_500
      )
    );

    await expect(reduceDeviceControlFrame(null, lease)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        mode: 'bootstrap',
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        revision: 0,
        confirmedAt: 999,
      })
    ).rejects.toMatchObject({ code: 'OUT_OF_ORDER_FRAME' });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        removedControlIds: ['missing.visibility'],
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        observations: [observation('alpha', 'active', 1, 1_500)],
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        revision: 2,
        observations: [observation('missing', 'active', 2, 1_500)],
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      reduceDeviceControlFrame(state, {
        ...lease,
        revision: 2,
        addedActions: [action('beta')],
        observations: [],
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(state).toEqual(before);
  });

  it('fails admission for untrusted, unauthorized, replayed, or invalid frames', async () => {
    const keys = generateKeyPairSync('ed25519');
    const frame = await buildDeviceControlBootstrapFrame(
      input([action('alpha')], [observation('alpha', 'active', 1, 1_000)], 1, 1_000)
    );
    const verify = verifier(keys.publicKey);

    await expect(
      admit(
        signedPayload(frame, keys.privateKey, { issuerKeyId: 'other-key' }),
        authority(),
        verify
      )
    ).rejects.toMatchObject({ code: 'UNTRUSTED_ISSUER' });
    await expect(
      admit(
        signedPayload(frame, keys.privateKey, { audienceCredentialId: 'device-2.g1' }),
        authority(),
        verify
      )
    ).rejects.toMatchObject({ code: 'AUDIENCE_FORBIDDEN' });
    await expect(
      admit(
        signedPayload(frame, keys.privateKey),
        authority({ scopes: ['component.visibility:write'] }),
        verify
      )
    ).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    await expect(
      admit(signedPayload(frame, keys.privateKey), authority({ scopes: ['feedback:read'] }), verify)
    ).rejects.toMatchObject({ code: 'SCOPE_FORBIDDEN' });
    await expect(
      admit(signedPayload(frame, keys.privateKey), authority({ showId: 'show-2' }), verify)
    ).rejects.toMatchObject({ code: 'SHOW_FORBIDDEN' });
    await expect(
      admit(signedPayload(frame, keys.privateKey), authority({ targets: ['program'] }), verify)
    ).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN' });
    await expect(
      admit(
        signedPayload(frame, keys.privateKey),
        authority({ controlIds: ['zulu.visibility'] }),
        verify
      )
    ).rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
    await expect(
      admit(signedPayload(frame, keys.privateKey), authority({ lastAcceptedSequence: 1 }), verify)
    ).rejects.toMatchObject({ code: 'FRAME_REPLAYED' });
    await expect(
      admit(signedPayload(frame, keys.privateKey), authority(), () => false)
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('filters the complete authorized catalog to one exact frame target', async () => {
    const frame = await buildDeviceControlBootstrapFrame({
      showId: 'show-1',
      target: 'preview',
      revision: 1,
      catalogGeneration: 1,
      confirmedAt: 1_000,
      catalog: catalog([
        action('preview-control', 'Preview', 'preview'),
        action('program-control', 'Program', 'program'),
      ]),
      observations: [observation('preview-control', 'active', 1, 1_000)],
    });
    expect(frame.addedActions.map((item) => item.subject.controlId)).toEqual([
      'preview-control.visibility',
    ]);
  });

  it('supports an empty authorized target without inventing availability', async () => {
    const frame = await buildDeviceControlBootstrapFrame(input([], [], 0, 1_000));
    const state = await reduceDeviceControlFrame(null, frame);
    expect(state.controls).toEqual([]);
    expect(projectDeviceControl(state, action('missing').subject, 1_001)).toMatchObject({
      available: false,
      buttonState: 'unavailable',
    });
  });

  it('rejects a signature over another catalog hash even when the frame is otherwise valid', async () => {
    const keys = generateKeyPairSync('ed25519');
    const frame = await buildDeviceControlBootstrapFrame(
      input([action('alpha')], [observation('alpha', 'active', 1, 1_000)], 1, 1_000)
    );
    const wrongHashFrame: DeviceControlFrame = {
      ...frame,
      catalogHash: 'f'.repeat(64),
    };
    const signed = signedPayload(wrongHashFrame, keys.privateKey);
    const admitted = await admitDeviceControlFrame(
      signed.payloadBytes,
      signed.signature,
      authority(),
      verifier(keys.publicKey)
    );
    await expect(reduceDeviceControlFrame(null, admitted.frame)).rejects.toMatchObject({
      code: 'CATALOG_HASH_MISMATCH',
    });
  });

  it('chains deltas to the exact applied base and admits exact retransmissions idempotently', async () => {
    const keys = generateKeyPairSync('ed25519');
    const bootstrap = await buildDeviceControlBootstrapFrame(
      input(
        [action('alpha', 'Alpha')],
        [observation('alpha', 'inactive', 1, 1_000)],
        1,
        1_000,
      ),
    );
    const admittedBootstrap = await admit(
      signedPayload(bootstrap, keys.privateKey),
      authority(),
      verifier(keys.publicKey),
    );
    const initial = await reduceAdmittedDeviceControlFrame(null, admittedBootstrap);
    const delta = await buildDeviceControlDeltaFrame(
      initial.state.state,
      input(
        [action('alpha', 'Alpha')],
        [observation('alpha', 'active', 2, 2_000)],
        2,
        2_000,
      ),
    );
    const signedDelta = signedPayload(delta, keys.privateKey, {
      sequence: 3,
      baseIssuerKeyId: initial.state.identity.issuerKeyId,
      baseSequence: initial.state.identity.sequence,
      baseSha256: initial.state.identity.sha256,
    });
    const admittedDelta = await admit(
      signedDelta,
      authority({ lastAcceptedSequence: 2 }),
      verifier(keys.publicKey),
    );
    const advanced = await reduceAdmittedDeviceControlFrame(initial.state, admittedDelta);

    expect(admittedDelta.base).toEqual(initial.state.identity);
    expect(advanced.applied).toBe(true);
    expect(advanced.state.state.controls[0].value).toBe('active');

    const duplicate = await admit(
      signedDelta,
      authority({
        lastAcceptedSequence: 4,
        acceptedFrameIdentities: [admittedDelta.identity],
      }),
      verifier(keys.publicKey),
    );
    const repeated = await reduceAdmittedDeviceControlFrame(advanced.state, duplicate);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.acceptedSequence).toBe(4);
    expect(repeated.applied).toBe(false);
    expect(repeated.state).toEqual(advanced.state);

    const confirmation = await buildDeviceControlDeltaFrame(
      advanced.state.state,
      input(
        [action('alpha', 'Alpha')],
        [observation('alpha', 'active', 3, 3_000)],
        3,
        3_000,
      ),
    );
    const admittedConfirmation = await admit(
      signedPayload(confirmation, keys.privateKey, {
        sequence: 5,
        baseIssuerKeyId: advanced.state.identity.issuerKeyId,
        baseSequence: advanced.state.identity.sequence,
        baseSha256: advanced.state.identity.sha256,
      }),
      authority({ lastAcceptedSequence: 4 }),
      verifier(keys.publicKey),
    );
    const newer = await reduceAdmittedDeviceControlFrame(
      advanced.state,
      admittedConfirmation,
    );
    const oldRepeated = await reduceAdmittedDeviceControlFrame(newer.state, duplicate);
    expect(oldRepeated.applied).toBe(false);
    expect(oldRepeated.state).toEqual(newer.state);

    const wrongBase = await admit(
      signedPayload(delta, keys.privateKey, {
        sequence: 6,
        baseIssuerKeyId: initial.state.identity.issuerKeyId,
        baseSequence: initial.state.identity.sequence,
        baseSha256: 'f'.repeat(64),
      }),
      authority({ lastAcceptedSequence: 5 }),
      verifier(keys.publicKey),
    );
    await expect(
      reduceAdmittedDeviceControlFrame(newer.state, wrongBase),
    ).rejects.toMatchObject({ code: 'BASE_MISMATCH' });
  });

  it('uses explicit schema versions for frames and envelopes', async () => {
    const frame = await buildDeviceControlBootstrapFrame(input([], [], 0, 1_000));
    expect(frame.schemaVersion).toBe('overlaykit-device-control-frame/v2');
    expect(frame.catalogGeneration).toBe(1);
    expect(unsignedEnvelope(frame).schemaVersion).toBe(
      'overlaykit-device-control-frame-envelope/v3'
    );
    expect(DEVICE_CONTROL_FRAME_VERSION).toBe(frame.schemaVersion);
    expect(DEVICE_CONTROL_FRAME_ENVELOPE_VERSION).toBe(unsignedEnvelope(frame).schemaVersion);
  });

  it('rejects non-canonical payload bytes even when their signature is valid', async () => {
    const keys = generateKeyPairSync('ed25519');
    const frame = await buildDeviceControlBootstrapFrame(input([], [], 0, 1_000));
    const nonCanonical = new TextEncoder().encode(JSON.stringify(unsignedEnvelope(frame), null, 2));
    const signature = signBytes(null, nonCanonical, keys.privateKey).toString('base64url');

    await expect(
      admitDeviceControlFrame(nonCanonical, signature, authority(), verifier(keys.publicKey))
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });
});
