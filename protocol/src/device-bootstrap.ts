import type { ProductionBus } from './production.js';

export const DEVICE_BOOTSTRAP_ACK_VERSION = 'overlaykit-device-bootstrap-ack/v1' as const;
export const DEVICE_BOOTSTRAP_ACK_TYPE = 'device.bootstrap.ack' as const;
export const DEVICE_BOOTSTRAP_SNAPSHOT_VERSION =
  'overlaykit-device-bootstrap-snapshot/v1' as const;
export const DEVICE_BOOTSTRAP_SNAPSHOT_TYPE = 'device.bootstrap.snapshot' as const;
export const DEVICE_READY_VERSION = 'overlaykit-device-ready/v1' as const;
export const DEVICE_READY_TYPE = 'device.ready' as const;
export const DEVICE_BOOTSTRAP_ACK_ERROR_CODES = [
  'decode_failed',
  'validation_failed',
  'unsupported_snapshot',
  'apply_failed',
  'resource_unavailable',
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 4_096;
const MAX_SNAPSHOT_BYTES = 1_048_576;

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

export interface DeviceBootstrapSnapshotMessage {
  readonly schemaVersion: typeof DEVICE_BOOTSTRAP_SNAPSHOT_VERSION;
  readonly type: typeof DEVICE_BOOTSTRAP_SNAPSHOT_TYPE;
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly payloadBase64: string;
  readonly signature: string;
}

export interface DeviceBootstrapSnapshotMessageInput {
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly payloadBytes: Uint8Array;
  readonly signature: string;
}

export interface DeviceReadyMessage {
  readonly schemaVersion: typeof DEVICE_READY_VERSION;
  readonly type: typeof DEVICE_READY_TYPE;
}

export class DeviceBootstrapAckError extends Error {
  readonly code = 'INVALID_DEVICE_BOOTSTRAP_ACK' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceBootstrapAckError';
  }
}

export class DeviceBootstrapMessageError extends Error {
  readonly code = 'INVALID_DEVICE_BOOTSTRAP_MESSAGE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceBootstrapMessageError';
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

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SIGNATURE_LENGTH;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw new DeviceBootstrapMessageError('Device bootstrap payload encoding is invalid');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    throw new DeviceBootstrapMessageError(
      `Device bootstrap payload encoding is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_SNAPSHOT_BYTES
    || encodeBase64(bytes) !== value
  ) {
    throw new DeviceBootstrapMessageError('Device bootstrap payload bytes are invalid');
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceBootstrapMessageError('SHA-256 is unavailable');
  }
  const digestInput = new Uint8Array(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function assertSnapshotFields(value: {
  readonly target: unknown;
  readonly issuerKeyId: unknown;
  readonly sequence: unknown;
  readonly sha256: unknown;
  readonly signature: unknown;
}): void {
  if (
    !validTarget(value.target)
    || !validIdentifier(value.issuerKeyId)
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 1
    || typeof value.sha256 !== 'string'
    || !SHA256_PATTERN.test(value.sha256)
    || !validSignature(value.signature)
  ) {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot fields are invalid');
  }
}

export async function buildDeviceBootstrapSnapshotMessage(
  input: DeviceBootstrapSnapshotMessageInput,
): Promise<DeviceBootstrapSnapshotMessage> {
  if (!input || typeof input !== 'object' || !(input.payloadBytes instanceof Uint8Array)) {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot input is invalid');
  }
  assertSnapshotFields(input);
  const payloadBytes = input.payloadBytes.slice();
  if (
    payloadBytes.byteLength === 0
    || payloadBytes.byteLength > MAX_SNAPSHOT_BYTES
    || await sha256(payloadBytes) !== input.sha256
  ) {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot hash is invalid');
  }
  return Object.freeze({
    schemaVersion: DEVICE_BOOTSTRAP_SNAPSHOT_VERSION,
    type: DEVICE_BOOTSTRAP_SNAPSHOT_TYPE,
    target: input.target,
    issuerKeyId: input.issuerKeyId,
    sequence: input.sequence,
    sha256: input.sha256,
    payloadBase64: encodeBase64(payloadBytes),
    signature: input.signature,
  });
}

export async function parseDeviceBootstrapSnapshotMessage(
  value: unknown,
): Promise<{
  readonly message: DeviceBootstrapSnapshotMessage;
  readonly payloadBytes: Uint8Array;
}> {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'type',
      'target',
      'issuerKeyId',
      'sequence',
      'sha256',
      'payloadBase64',
      'signature',
    ])
    || value.schemaVersion !== DEVICE_BOOTSTRAP_SNAPSHOT_VERSION
    || value.type !== DEVICE_BOOTSTRAP_SNAPSHOT_TYPE
  ) {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot message is invalid');
  }
  assertSnapshotFields({
    target: value.target,
    issuerKeyId: value.issuerKeyId,
    sequence: value.sequence,
    sha256: value.sha256,
    signature: value.signature,
  });
  if (typeof value.payloadBase64 !== 'string') {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot payload is invalid');
  }
  const payloadBytes = decodeBase64(value.payloadBase64);
  if (await sha256(payloadBytes) !== value.sha256) {
    throw new DeviceBootstrapMessageError('Device bootstrap snapshot hash is invalid');
  }
  const message = Object.freeze({
    schemaVersion: DEVICE_BOOTSTRAP_SNAPSHOT_VERSION,
    type: DEVICE_BOOTSTRAP_SNAPSHOT_TYPE,
    target: value.target as ProductionBus,
    issuerKeyId: value.issuerKeyId as string,
    sequence: value.sequence as number,
    sha256: value.sha256 as string,
    payloadBase64: value.payloadBase64,
    signature: value.signature as string,
  });
  return Object.freeze({ message, payloadBytes: payloadBytes.slice() });
}

export function buildDeviceReadyMessage(): DeviceReadyMessage {
  return Object.freeze({
    schemaVersion: DEVICE_READY_VERSION,
    type: DEVICE_READY_TYPE,
  });
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
