import type { DeviceControlFrameMode } from './device-control-frame.js';
import type { ProductionBus } from './production.js';

export const DEVICE_STATE_ACK_VERSION = 'overlaykit-device-state-ack/v1' as const;
export const DEVICE_STATE_ACK_TYPE = 'device.state.ack' as const;
export const DEVICE_STATE_DELTA_VERSION = 'overlaykit-device-state-delta/v1' as const;
export const DEVICE_STATE_DELTA_TYPE = 'device.state.delta' as const;
export const DEVICE_STATE_ACK_ERROR_CODES = [
  'decode_failed',
  'validation_failed',
  'unsupported_frame',
  'base_mismatch',
  'apply_failed',
  'resource_unavailable',
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 4_096;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_PAYLOAD_BASE64_LENGTH = Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4;

export type DeviceStateAckErrorCode = typeof DEVICE_STATE_ACK_ERROR_CODES[number];

interface DeviceStateAckEvidence {
  readonly schemaVersion: typeof DEVICE_STATE_ACK_VERSION;
  readonly type: typeof DEVICE_STATE_ACK_TYPE;
  readonly mode: DeviceControlFrameMode;
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
}

export interface DeviceStateAppliedAck extends DeviceStateAckEvidence {
  readonly status: 'applied';
}

export interface DeviceStateErrorAck extends DeviceStateAckEvidence {
  readonly status: 'error';
  readonly errorCode: DeviceStateAckErrorCode;
}

export type DeviceStateAck = DeviceStateAppliedAck | DeviceStateErrorAck;

export interface DeviceStateDeltaMessage {
  readonly schemaVersion: typeof DEVICE_STATE_DELTA_VERSION;
  readonly type: typeof DEVICE_STATE_DELTA_TYPE;
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly payloadBase64: string;
  readonly signature: string;
}

export interface DeviceStateDeltaMessageInput {
  readonly target: ProductionBus;
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly payloadBytes: Uint8Array;
  readonly signature: string;
}

export class DeviceStateAckError extends Error {
  readonly code = 'INVALID_DEVICE_STATE_ACK' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceStateAckError';
  }
}

export class DeviceStateDeltaMessageError extends Error {
  readonly code = 'INVALID_DEVICE_STATE_DELTA_MESSAGE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceStateDeltaMessageError';
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

function validMode(value: unknown): value is DeviceControlFrameMode {
  return value === 'bootstrap' || value === 'delta';
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

function validIdentity(value: {
  readonly target: unknown;
  readonly issuerKeyId: unknown;
  readonly sequence: unknown;
  readonly sha256: unknown;
}): boolean {
  return validTarget(value.target)
    && validIdentifier(value.issuerKeyId)
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) > 0
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256);
}

function validErrorCode(value: unknown): value is DeviceStateAckErrorCode {
  return typeof value === 'string'
    && DEVICE_STATE_ACK_ERROR_CODES.some((code) => code === value);
}

function sharedAckFields(value: Record<string, unknown>): boolean {
  return value.schemaVersion === DEVICE_STATE_ACK_VERSION
    && value.type === DEVICE_STATE_ACK_TYPE
    && validMode(value.mode)
    && validIdentity({
      target: value.target,
      issuerKeyId: value.issuerKeyId,
      sequence: value.sequence,
      sha256: value.sha256,
    });
}

export function parseDeviceStateAck(value: unknown): DeviceStateAck {
  if (!isRecord(value) || !sharedAckFields(value)) {
    throw new DeviceStateAckError('Device state acknowledgement is invalid');
  }
  const evidence = {
    schemaVersion: DEVICE_STATE_ACK_VERSION,
    type: DEVICE_STATE_ACK_TYPE,
    mode: value.mode as DeviceControlFrameMode,
    target: value.target as ProductionBus,
    issuerKeyId: value.issuerKeyId as string,
    sequence: value.sequence as number,
    sha256: value.sha256 as string,
  };
  if (
    value.status === 'applied'
    && hasExactKeys(value, [
      'schemaVersion',
      'type',
      'mode',
      'target',
      'issuerKeyId',
      'sequence',
      'sha256',
      'status',
    ])
  ) {
    return Object.freeze({ ...evidence, status: 'applied' });
  }
  if (
    value.status === 'error'
    && validErrorCode(value.errorCode)
    && hasExactKeys(value, [
      'schemaVersion',
      'type',
      'mode',
      'target',
      'issuerKeyId',
      'sequence',
      'sha256',
      'status',
      'errorCode',
    ])
  ) {
    return Object.freeze({
      ...evidence,
      status: 'error',
      errorCode: value.errorCode,
    });
  }
  throw new DeviceStateAckError('Device state acknowledgement is invalid');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > MAX_PAYLOAD_BASE64_LENGTH || !BASE64_PATTERN.test(value)) {
    throw new DeviceStateDeltaMessageError('Device delta payload encoding is invalid');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new DeviceStateDeltaMessageError('Device delta payload encoding is invalid');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_PAYLOAD_BYTES
    || encodeBase64(bytes) !== value
  ) {
    throw new DeviceStateDeltaMessageError('Device delta payload bytes are invalid');
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DeviceStateDeltaMessageError('SHA-256 is unavailable');
  }
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function assertDeltaFields(value: {
  readonly target: unknown;
  readonly issuerKeyId: unknown;
  readonly sequence: unknown;
  readonly sha256: unknown;
  readonly signature: unknown;
}): void {
  if (
    !validIdentity(value)
    || typeof value.signature !== 'string'
    || value.signature.length === 0
    || value.signature.length > MAX_SIGNATURE_LENGTH
  ) {
    throw new DeviceStateDeltaMessageError('Device delta fields are invalid');
  }
}

export async function buildDeviceStateDeltaMessage(
  input: DeviceStateDeltaMessageInput,
): Promise<DeviceStateDeltaMessage> {
  if (!input || typeof input !== 'object' || !(input.payloadBytes instanceof Uint8Array)) {
    throw new DeviceStateDeltaMessageError('Device delta input is invalid');
  }
  assertDeltaFields(input);
  const bytes = input.payloadBytes.slice();
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_PAYLOAD_BYTES
    || await sha256(bytes) !== input.sha256
  ) {
    throw new DeviceStateDeltaMessageError('Device delta payload hash is invalid');
  }
  return Object.freeze({
    schemaVersion: DEVICE_STATE_DELTA_VERSION,
    type: DEVICE_STATE_DELTA_TYPE,
    target: input.target,
    issuerKeyId: input.issuerKeyId,
    sequence: input.sequence,
    sha256: input.sha256,
    payloadBase64: encodeBase64(bytes),
    signature: input.signature,
  });
}

export async function parseDeviceStateDeltaMessage(
  value: unknown,
): Promise<{
  readonly message: DeviceStateDeltaMessage;
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
    || value.schemaVersion !== DEVICE_STATE_DELTA_VERSION
    || value.type !== DEVICE_STATE_DELTA_TYPE
    || typeof value.payloadBase64 !== 'string'
  ) {
    throw new DeviceStateDeltaMessageError('Device delta message is invalid');
  }
  assertDeltaFields({
    target: value.target,
    issuerKeyId: value.issuerKeyId,
    sequence: value.sequence,
    sha256: value.sha256,
    signature: value.signature,
  });
  const payloadBytes = decodeBase64(value.payloadBase64);
  if (await sha256(payloadBytes) !== value.sha256) {
    throw new DeviceStateDeltaMessageError('Device delta payload hash is invalid');
  }
  return Object.freeze({
    message: Object.freeze({
      schemaVersion: DEVICE_STATE_DELTA_VERSION,
      type: DEVICE_STATE_DELTA_TYPE,
      target: value.target as ProductionBus,
      issuerKeyId: value.issuerKeyId as string,
      sequence: value.sequence as number,
      sha256: value.sha256 as string,
      payloadBase64: value.payloadBase64,
      signature: value.signature as string,
    }),
    payloadBytes: payloadBytes.slice(),
  });
}
