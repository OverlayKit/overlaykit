import { describe, expect, it } from 'vitest';
import {
  DEVICE_BOOTSTRAP_ACK_ERROR_CODES,
  DEVICE_BOOTSTRAP_ACK_TYPE,
  DEVICE_BOOTSTRAP_ACK_VERSION,
  DEVICE_BOOTSTRAP_SNAPSHOT_TYPE,
  DEVICE_BOOTSTRAP_SNAPSHOT_VERSION,
  DEVICE_READY_TYPE,
  DEVICE_READY_VERSION,
  DeviceBootstrapAckError,
  DeviceBootstrapMessageError,
  buildDeviceBootstrapSnapshotMessage,
  buildDeviceReadyMessage,
  parseDeviceBootstrapAck,
  parseDeviceBootstrapSnapshotMessage,
} from '../src/device-bootstrap.js';

const SHA256 = 'a'.repeat(64);

function applied(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
    type: DEVICE_BOOTSTRAP_ACK_TYPE,
    target: 'preview',
    sha256: SHA256,
    status: 'applied',
    ...overrides,
  };
}

describe('device bootstrap acknowledgement contract', () => {
  it('parses an exact applied acknowledgement into an immutable copy', () => {
    const input = applied();
    const parsed = parseDeviceBootstrapAck(input);
    input.target = 'program';
    input.sha256 = 'b'.repeat(64);

    expect(parsed).toEqual({
      schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
      type: DEVICE_BOOTSTRAP_ACK_TYPE,
      target: 'preview',
      sha256: SHA256,
      status: 'applied',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts only the bounded error-code vocabulary', () => {
    for (const errorCode of DEVICE_BOOTSTRAP_ACK_ERROR_CODES) {
      expect(parseDeviceBootstrapAck({
        ...applied({ target: 'program', status: 'error' }),
        errorCode,
      })).toEqual({
        schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
        type: DEVICE_BOOTSTRAP_ACK_TYPE,
        target: 'program',
        sha256: SHA256,
        status: 'error',
        errorCode,
      });
    }
  });

  it('rejects extra fields, free text, and status-specific field confusion', () => {
    const invalid = [
      applied({ message: 'device detail' }),
      applied({ errorCode: 'apply_failed' }),
      applied({ status: 'error' }),
      { ...applied({ status: 'error' }), errorCode: 'unknown_failure' },
      {
        ...applied({ status: 'error' }),
        errorCode: 'apply_failed',
        message: 'free text is forbidden',
      },
    ];

    for (const value of invalid) {
      expect(() => parseDeviceBootstrapAck(value)).toThrowError(DeviceBootstrapAckError);
    }
  });

  it('rejects malformed hashes, targets, versions, types, and statuses', () => {
    const invalid = [
      null,
      [],
      applied({ sha256: 'a'.repeat(63) }),
      applied({ sha256: 'A'.repeat(64) }),
      applied({ sha256: `${'a'.repeat(63)}g` }),
      applied({ target: 'both' }),
      applied({ schemaVersion: 'overlaykit-device-bootstrap-ack/v2' }),
      applied({ type: 'device.bootstrap.ready' }),
      applied({ status: 'unknown' }),
    ];

    for (const value of invalid) {
      expect(() => parseDeviceBootstrapAck(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_DEVICE_BOOTSTRAP_ACK' }),
      );
    }
  });
});

describe('device bootstrap server message contract', () => {
  it('round-trips exact immutable snapshot bytes and keeps ready notification non-authoritative', async () => {
    const payloadBytes = new TextEncoder().encode('canonical signed snapshot');
    const sha256 = await crypto.subtle.digest('SHA-256', payloadBytes);
    const hash = [...new Uint8Array(sha256)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const message = await buildDeviceBootstrapSnapshotMessage({
      target: 'program',
      issuerKeyId: 'server-key-1',
      sequence: 7,
      sha256: hash,
      payloadBytes,
      signature: 'detached-signature',
    });
    payloadBytes.fill(0);
    const parsed = await parseDeviceBootstrapSnapshotMessage(message);

    expect(message).toMatchObject({
      schemaVersion: DEVICE_BOOTSTRAP_SNAPSHOT_VERSION,
      type: DEVICE_BOOTSTRAP_SNAPSHOT_TYPE,
      target: 'program',
      sequence: 7,
      sha256: hash,
    });
    expect(new TextDecoder().decode(parsed.payloadBytes)).toBe('canonical signed snapshot');
    expect(Object.isFrozen(message)).toBe(true);
    expect(buildDeviceReadyMessage()).toEqual({
      schemaVersion: DEVICE_READY_VERSION,
      type: DEVICE_READY_TYPE,
    });
    expect(Object.keys(buildDeviceReadyMessage())).not.toContain('recordHash');
    expect(Object.keys(buildDeviceReadyMessage())).not.toContain('globalSequence');
  });

  it('rejects payload substitution, non-canonical base64, extras, and invalid bounds', async () => {
    const bytes = new TextEncoder().encode('snapshot');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const message = await buildDeviceBootstrapSnapshotMessage({
      target: 'preview',
      issuerKeyId: 'server-key-1',
      sequence: 1,
      sha256: hash,
      payloadBytes: bytes,
      signature: 'signature',
    });

    await expect(parseDeviceBootstrapSnapshotMessage({
      ...message,
      payloadBase64: btoa('substitution'),
    })).rejects.toThrowError(DeviceBootstrapMessageError);
    await expect(parseDeviceBootstrapSnapshotMessage({
      ...message,
      payloadBase64: `${message.payloadBase64}=`,
    })).rejects.toThrowError(DeviceBootstrapMessageError);
    await expect(parseDeviceBootstrapSnapshotMessage({ ...message, authority: true }))
      .rejects.toThrowError(DeviceBootstrapMessageError);
    await expect(buildDeviceBootstrapSnapshotMessage({
      target: 'preview',
      issuerKeyId: 'server-key-1',
      sequence: 1,
      sha256: 'f'.repeat(64),
      payloadBytes: bytes,
      signature: 'signature',
    })).rejects.toThrowError(DeviceBootstrapMessageError);
  });
});
