import { describe, expect, it } from 'vitest';
import {
  DEVICE_BOOTSTRAP_ACK_ERROR_CODES,
  DEVICE_BOOTSTRAP_ACK_TYPE,
  DEVICE_BOOTSTRAP_ACK_VERSION,
  DeviceBootstrapAckError,
  parseDeviceBootstrapAck,
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
