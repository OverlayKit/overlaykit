import { describe, expect, it } from 'vitest';
import {
  DEVICE_STATE_ACK_TYPE,
  DEVICE_STATE_ACK_VERSION,
  DEVICE_STATE_DELTA_TYPE,
  DEVICE_STATE_DELTA_VERSION,
  DeviceStateAckError,
  DeviceStateDeltaMessageError,
  buildDeviceStateDeltaMessage,
  parseDeviceStateAck,
  parseDeviceStateDeltaMessage,
} from '../src/device-state-sync.js';

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function applied(mode: 'bootstrap' | 'delta' = 'delta') {
  return {
    schemaVersion: DEVICE_STATE_ACK_VERSION,
    type: DEVICE_STATE_ACK_TYPE,
    mode,
    target: 'preview',
    issuerKeyId: 'server-key-1',
    sequence: 9,
    sha256: 'a'.repeat(64),
    status: 'applied',
  };
}

describe('device state synchronization wire contract', () => {
  it('uses one closed exact acknowledgement for bootstrap and delta modes', () => {
    expect(parseDeviceStateAck(applied('bootstrap'))).toEqual(applied('bootstrap'));
    expect(parseDeviceStateAck(applied('delta'))).toEqual(applied('delta'));
    expect(parseDeviceStateAck({
      ...applied(),
      status: 'error',
      errorCode: 'base_mismatch',
    })).toMatchObject({
      mode: 'delta',
      status: 'error',
      errorCode: 'base_mismatch',
    });

    const invalid = [
      { ...applied(), commandResult: 'applied' },
      { ...applied(), mode: 'command' },
      { ...applied(), issuerKeyId: '' },
      { ...applied(), sequence: 0 },
      { ...applied(), status: 'error' },
      { ...applied(), status: 'error', errorCode: 'free_text' },
      { ...applied(), errorCode: 'apply_failed' },
    ];
    for (const value of invalid) {
      expect(() => parseDeviceStateAck(value)).toThrowError(DeviceStateAckError);
    }
  });

  it('round-trips immutable hashed delta bytes and rejects substitution', async () => {
    const payloadBytes = new TextEncoder().encode('canonical signed delta');
    const sha256 = await digest(payloadBytes);
    const message = await buildDeviceStateDeltaMessage({
      target: 'program',
      issuerKeyId: 'server-key-1',
      sequence: 10,
      sha256,
      payloadBytes,
      signature: 'detached-signature',
    });
    payloadBytes.fill(0);
    const parsed = await parseDeviceStateDeltaMessage(message);

    expect(message).toMatchObject({
      schemaVersion: DEVICE_STATE_DELTA_VERSION,
      type: DEVICE_STATE_DELTA_TYPE,
      target: 'program',
      issuerKeyId: 'server-key-1',
      sequence: 10,
      sha256,
    });
    expect(new TextDecoder().decode(parsed.payloadBytes)).toBe('canonical signed delta');
    expect(Object.isFrozen(message)).toBe(true);

    await expect(parseDeviceStateDeltaMessage({
      ...message,
      payloadBase64: btoa('substitution'),
    })).rejects.toThrowError(DeviceStateDeltaMessageError);
    await expect(parseDeviceStateDeltaMessage({
      ...message,
      commandResult: 'applied',
    })).rejects.toThrowError(DeviceStateDeltaMessageError);
    await expect(parseDeviceStateDeltaMessage({
      ...message,
      payloadBase64: 'A'.repeat(1_398_108),
    })).rejects.toThrowError(DeviceStateDeltaMessageError);
    await expect(buildDeviceStateDeltaMessage({
      target: 'program',
      issuerKeyId: 'server-key-1',
      sequence: 10,
      sha256: 'f'.repeat(64),
      payloadBytes: new TextEncoder().encode('different'),
      signature: 'detached-signature',
    })).rejects.toThrowError(DeviceStateDeltaMessageError);
  });
});
