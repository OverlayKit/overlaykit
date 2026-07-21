import type { ProductionBus } from './production.js';

export const DEVICE_BOOTSTRAP_ACK_VERSION = 'overlaykit-device-bootstrap-ack/v1' as const;
export const DEVICE_BOOTSTRAP_ACK_TYPE = 'device.bootstrap.ack' as const;
export const DEVICE_BOOTSTRAP_ACK_ERROR_CODES = [
  'decode_failed',
  'validation_failed',
  'unsupported_snapshot',
  'apply_failed',
  'resource_unavailable',
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DeviceBootstrapAckErrorCode = typeof DEVICE_BOOTSTRAP_ACK_ERROR_CODES[number];

export interface DeviceBootstrapAppliedAck {
  readonly schemaVersion: typeof DEVICE_BOOTSTRAP_ACK_VERSION;
  readonly type: typeof DEVICE_BOOTSTRAP_ACK_TYPE;
  readonly target: ProductionBus;
  readonly sha256: string;
  readonly status: 'applied';
}

export interface DeviceBootstrapErrorAck {
  readonly schemaVersion: typeof DEVICE_BOOTSTRAP_ACK_VERSION;
  readonly type: typeof DEVICE_BOOTSTRAP_ACK_TYPE;
  readonly target: ProductionBus;
  readonly sha256: string;
  readonly status: 'error';
  readonly errorCode: DeviceBootstrapAckErrorCode;
}

export type DeviceBootstrapAck = DeviceBootstrapAppliedAck | DeviceBootstrapErrorAck;

export class DeviceBootstrapAckError extends Error {
  readonly code = 'INVALID_DEVICE_BOOTSTRAP_ACK' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceBootstrapAckError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validTarget(value: unknown): value is ProductionBus {
  return value === 'preview' || value === 'program';
}

function validErrorCode(value: unknown): value is DeviceBootstrapAckErrorCode {
  return typeof value === 'string'
    && DEVICE_BOOTSTRAP_ACK_ERROR_CODES.some((code) => code === value);
}

function sharedFields(value: Record<string, unknown>): boolean {
  return value.schemaVersion === DEVICE_BOOTSTRAP_ACK_VERSION
    && value.type === DEVICE_BOOTSTRAP_ACK_TYPE
    && validTarget(value.target)
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256);
}

export function parseDeviceBootstrapAck(value: unknown): DeviceBootstrapAck {
  if (!isRecord(value) || !sharedFields(value)) {
    throw new DeviceBootstrapAckError('Device bootstrap acknowledgement is invalid');
  }
  if (
    value.status === 'applied'
    && hasExactKeys(value, ['schemaVersion', 'type', 'target', 'sha256', 'status'])
  ) {
    return Object.freeze({
      schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
      type: DEVICE_BOOTSTRAP_ACK_TYPE,
      target: value.target as ProductionBus,
      sha256: value.sha256 as string,
      status: 'applied',
    });
  }
  if (
    value.status === 'error'
    && validErrorCode(value.errorCode)
    && hasExactKeys(
      value,
      ['schemaVersion', 'type', 'target', 'sha256', 'status', 'errorCode'],
    )
  ) {
    return Object.freeze({
      schemaVersion: DEVICE_BOOTSTRAP_ACK_VERSION,
      type: DEVICE_BOOTSTRAP_ACK_TYPE,
      target: value.target as ProductionBus,
      sha256: value.sha256 as string,
      status: 'error',
      errorCode: value.errorCode,
    });
  }
  throw new DeviceBootstrapAckError('Device bootstrap acknowledgement is invalid');
}
