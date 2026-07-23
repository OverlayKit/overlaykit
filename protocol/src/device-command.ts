import type { ProductionBus } from './production.js';

export const DEVICE_COMMAND_EXECUTE_VERSION = 'overlaykit-device-command-execute/v1' as const;
export const DEVICE_COMMAND_EXECUTE_TYPE = 'device.command.execute' as const;
export const DEVICE_COMMAND_RESULT_VERSION = 'overlaykit-device-command-result/v1' as const;
export const DEVICE_COMMAND_RESULT_TYPE = 'device.command.result' as const;
export const DEVICE_COMMAND_REFUSED_VERSION = 'overlaykit-device-command-refused/v1' as const;
export const DEVICE_COMMAND_REFUSED_TYPE = 'device.command.refused' as const;
export const DEVICE_COMMAND_MESSAGE_VERSION = 'overlaykit-device-command-message/v1' as const;
export const DEVICE_COMMAND_MAX_MESSAGE_BYTES = 16_384;
export const DEVICE_COMMAND_REFUSAL_REASONS = [
  'not_ready',
  'base_mismatch',
  'not_authorized',
  'operation_conflict',
  'capacity_exhausted',
  'target_unavailable',
] as const;

const MAX_OPERATION_ID_LENGTH = 100;
const MAX_COMPONENT_ID_LENGTH = 100;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_SIGNATURE_LENGTH = 4_096;
const MAX_JSON_DEPTH = 16;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type DeviceCommandRefusalReason = typeof DEVICE_COMMAND_REFUSAL_REASONS[number];

export interface DeviceCommandBasedOn {
  readonly issuerKeyId: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly productionRevision: number;
  readonly catalogGeneration: number;
}

export interface DeviceComponentVisibilityCommand {
  readonly kind: 'component.visibility';
  readonly componentId: string;
  readonly visible: boolean;
  readonly expectedRevision: number;
}

export interface DeviceCommandExecute {
  readonly schemaVersion: typeof DEVICE_COMMAND_EXECUTE_VERSION;
  readonly type: typeof DEVICE_COMMAND_EXECUTE_TYPE;
  readonly operationId: string;
  readonly target: ProductionBus;
  readonly basedOn: DeviceCommandBasedOn;
  readonly intent: DeviceComponentVisibilityCommand;
}

interface DeviceCommandResponseAuthority {
  readonly issuerKeyId: string;
  readonly audienceCredentialId: string;
  readonly operationId: string;
}

export interface DeviceCommandResultPayload extends DeviceCommandResponseAuthority {
  readonly schemaVersion: typeof DEVICE_COMMAND_RESULT_VERSION;
  readonly type: typeof DEVICE_COMMAND_RESULT_TYPE;
  readonly intentSha256: string;
  readonly outcome: 'applied' | 'rejected';
  readonly resultCode: 'APPLIED' | 'TARGET_REVISION_CONFLICT';
  readonly commandSequence: number;
  readonly expectedRevision: number;
  readonly previousRevision: number;
  readonly resultingRevision: number;
  readonly replayed: boolean;
}

export interface DeviceCommandRefusedPayload extends DeviceCommandResponseAuthority {
  readonly schemaVersion: typeof DEVICE_COMMAND_REFUSED_VERSION;
  readonly type: typeof DEVICE_COMMAND_REFUSED_TYPE;
  readonly requestSha256: string;
  readonly reason: DeviceCommandRefusalReason;
}

export type DeviceCommandResponsePayload =
  | DeviceCommandResultPayload
  | DeviceCommandRefusedPayload;

export interface DeviceCommandResponseMessage {
  readonly schemaVersion: typeof DEVICE_COMMAND_MESSAGE_VERSION;
  readonly type: typeof DEVICE_COMMAND_RESULT_TYPE | typeof DEVICE_COMMAND_REFUSED_TYPE;
  readonly issuerKeyId: string;
  readonly sha256: string;
  readonly payloadBase64: string;
  readonly signature: string;
}

export interface DeviceCommandResponseMessageInput {
  readonly payload: DeviceCommandResponsePayload;
  readonly signature: string;
}

export class DeviceCommandProtocolError extends Error {
  readonly code = 'INVALID_DEVICE_COMMAND_PROTOCOL' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeviceCommandProtocolError';
  }
}

function fail(message: string): never {
  throw new DeviceCommandProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
  ) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(`${label} is invalid`);
  }
  return value as number;
}

function target(value: unknown): ProductionBus {
  if (value !== 'preview' && value !== 'program') {
    return fail('Device command target is invalid');
  }
  return value;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function operationId(value: unknown): string {
  return identifier(value, MAX_OPERATION_ID_LENGTH, 'Device command operationId');
}

function normalizeBasedOn(value: unknown): DeviceCommandBasedOn {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'issuerKeyId',
      'sequence',
      'sha256',
      'productionRevision',
      'catalogGeneration',
    ])
  ) {
    return fail('Device command base is invalid');
  }
  return Object.freeze({
    issuerKeyId: identifier(value.issuerKeyId, MAX_IDENTIFIER_LENGTH, 'Device command base issuer'),
    sequence: safeInteger(value.sequence, 1, 'Device command base sequence'),
    sha256: sha256Value(value.sha256, 'Device command base hash'),
    productionRevision: safeInteger(
      value.productionRevision,
      0,
      'Device command base production revision',
    ),
    catalogGeneration: safeInteger(
      value.catalogGeneration,
      1,
      'Device command base catalog generation',
    ),
  });
}

function normalizeIntent(value: unknown): DeviceComponentVisibilityCommand {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['kind', 'componentId', 'visible', 'expectedRevision'])
    || value.kind !== 'component.visibility'
    || typeof value.visible !== 'boolean'
  ) {
    return fail('Device command intent is invalid');
  }
  return Object.freeze({
    kind: 'component.visibility',
    componentId: identifier(
      value.componentId,
      MAX_COMPONENT_ID_LENGTH,
      'Device command component identifier',
    ),
    visible: value.visible,
    expectedRevision: safeInteger(
      value.expectedRevision,
      0,
      'Device command expected revision',
    ),
  });
}

export function parseDeviceCommandExecute(value: unknown): DeviceCommandExecute {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'type',
      'operationId',
      'target',
      'basedOn',
      'intent',
    ])
    || value.schemaVersion !== DEVICE_COMMAND_EXECUTE_VERSION
    || value.type !== DEVICE_COMMAND_EXECUTE_TYPE
  ) {
    return fail('Device command execute frame is invalid');
  }
  const basedOn = normalizeBasedOn(value.basedOn);
  const intent = normalizeIntent(value.intent);
  if (intent.expectedRevision !== basedOn.productionRevision) {
    return fail('Device command intent does not match its declared production base');
  }
  return Object.freeze({
    schemaVersion: DEVICE_COMMAND_EXECUTE_VERSION,
    type: DEVICE_COMMAND_EXECUTE_TYPE,
    operationId: operationId(value.operationId),
    target: target(value.target),
    basedOn,
    intent,
  });
}

class StrictJsonReader {
  private index = 0;

  constructor(private readonly text: string) {}

  read(): unknown {
    this.space();
    const value = this.value(0);
    this.space();
    if (this.index !== this.text.length) fail('Device command JSON has trailing data');
    return value;
  }

  private value(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) fail('Device command JSON is too deeply nested');
    const character = this.text[this.index];
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    this.space();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') fail('Device command JSON object key is invalid');
      const key = this.string();
      if (keys.has(key)) fail('Device command JSON contains a duplicate property');
      keys.add(key);
      this.space();
      if (this.text[this.index] !== ':') fail('Device command JSON object is invalid');
      this.index += 1;
      this.space();
      result[key] = this.value(depth);
      this.space();
      const delimiter = this.text[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') fail('Device command JSON object is invalid');
      this.index += 1;
      this.space();
    }
    return fail('Device command JSON object is incomplete');
  }

  private array(depth: number): unknown[] {
    this.index += 1;
    this.space();
    const result: unknown[] = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.value(depth));
      this.space();
      const delimiter = this.text[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') fail('Device command JSON array is invalid');
      this.index += 1;
      this.space();
    }
    return fail('Device command JSON array is incomplete');
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          return fail('Device command JSON string is invalid');
        }
      }
      if (character.charCodeAt(0) < 0x20) fail('Device command JSON string is invalid');
      if (character === '\\') {
        this.index += 1;
        const escape = this.text[this.index];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) {
          fail('Device command JSON escape is invalid');
        }
        if (escape === 'u') {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('Device command JSON escape is invalid');
          this.index += 4;
        }
      }
      this.index += 1;
    }
    return fail('Device command JSON string is incomplete');
  }

  private literal(token: string, value: unknown): unknown {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      return fail('Device command JSON literal is invalid');
    }
    this.index += token.length;
    return value;
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (!match) return fail('Device command JSON value is invalid');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return fail('Device command JSON number is invalid');
    return value;
  }

  private space(): void {
    while (
      this.text[this.index] === ' '
      || this.text[this.index] === '\t'
      || this.text[this.index] === '\n'
      || this.text[this.index] === '\r'
    ) this.index += 1;
  }
}

function parseStrictJson(text: string): unknown {
  if (
    typeof text !== 'string'
    || text.length === 0
    || new TextEncoder().encode(text).byteLength > DEVICE_COMMAND_MAX_MESSAGE_BYTES
  ) {
    return fail('Device command JSON size is invalid');
  }
  return new StrictJsonReader(text).read();
}

export function parseDeviceCommandExecuteJson(text: string): DeviceCommandExecute {
  return parseDeviceCommandExecute(parseStrictJson(text));
}

export function deviceCommandExecuteBytes(value: DeviceCommandExecute): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parseDeviceCommandExecute(value)));
}

export function deviceCommandIntentBytes(value: DeviceCommandExecute): Uint8Array {
  const command = parseDeviceCommandExecute(value);
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 'overlaykit-device-command-intent/v1',
    target: command.target,
    kind: command.intent.kind,
    componentId: command.intent.componentId,
    visible: command.intent.visible,
    expectedRevision: command.intent.expectedRevision,
  }));
}

function normalizeResponseAuthority(value: Record<string, unknown>): DeviceCommandResponseAuthority {
  return {
    issuerKeyId: identifier(value.issuerKeyId, MAX_IDENTIFIER_LENGTH, 'Command response issuer'),
    audienceCredentialId: identifier(
      value.audienceCredentialId,
      MAX_IDENTIFIER_LENGTH,
      'Command response audience',
    ),
    operationId: operationId(value.operationId),
  };
}

function normalizeResult(value: unknown): DeviceCommandResultPayload {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'type',
      'issuerKeyId',
      'audienceCredentialId',
      'operationId',
      'intentSha256',
      'outcome',
      'resultCode',
      'commandSequence',
      'expectedRevision',
      'previousRevision',
      'resultingRevision',
      'replayed',
    ])
    || value.schemaVersion !== DEVICE_COMMAND_RESULT_VERSION
    || value.type !== DEVICE_COMMAND_RESULT_TYPE
    || (value.outcome !== 'applied' && value.outcome !== 'rejected')
    || (value.resultCode !== 'APPLIED' && value.resultCode !== 'TARGET_REVISION_CONFLICT')
    || typeof value.replayed !== 'boolean'
  ) {
    return fail('Device command result payload is invalid');
  }
  const authority = normalizeResponseAuthority(value);
  const expectedRevision = safeInteger(value.expectedRevision, 0, 'Command expected revision');
  const previousRevision = safeInteger(value.previousRevision, 0, 'Command previous revision');
  const resultingRevision = safeInteger(value.resultingRevision, 0, 'Command resulting revision');
  if (
    (value.outcome === 'applied'
      && (value.resultCode !== 'APPLIED'
        || expectedRevision !== previousRevision
        || resultingRevision !== previousRevision + 1))
    || (value.outcome === 'rejected'
      && (value.resultCode !== 'TARGET_REVISION_CONFLICT'
        || resultingRevision !== previousRevision))
  ) {
    return fail('Device command result boundary is inconsistent');
  }
  return Object.freeze({
    schemaVersion: DEVICE_COMMAND_RESULT_VERSION,
    type: DEVICE_COMMAND_RESULT_TYPE,
    ...authority,
    intentSha256: sha256Value(value.intentSha256, 'Command intent hash'),
    outcome: value.outcome,
    resultCode: value.resultCode,
    commandSequence: safeInteger(value.commandSequence, 1, 'Command sequence'),
    expectedRevision,
    previousRevision,
    resultingRevision,
    replayed: value.replayed,
  });
}

function refusalReason(value: unknown): DeviceCommandRefusalReason {
  if (
    typeof value !== 'string'
    || !DEVICE_COMMAND_REFUSAL_REASONS.some((reason) => reason === value)
  ) {
    return fail('Device command refusal reason is invalid');
  }
  return value as DeviceCommandRefusalReason;
}

function normalizeRefused(value: unknown): DeviceCommandRefusedPayload {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'type',
      'issuerKeyId',
      'audienceCredentialId',
      'operationId',
      'requestSha256',
      'reason',
    ])
    || value.schemaVersion !== DEVICE_COMMAND_REFUSED_VERSION
    || value.type !== DEVICE_COMMAND_REFUSED_TYPE
  ) {
    return fail('Device command refusal payload is invalid');
  }
  return Object.freeze({
    schemaVersion: DEVICE_COMMAND_REFUSED_VERSION,
    type: DEVICE_COMMAND_REFUSED_TYPE,
    ...normalizeResponseAuthority(value),
    requestSha256: sha256Value(value.requestSha256, 'Command request hash'),
    reason: refusalReason(value.reason),
  });
}

export function buildDeviceCommandResultPayload(
  input: DeviceCommandResultPayload,
): DeviceCommandResultPayload {
  return normalizeResult(input);
}

export function buildDeviceCommandRefusedPayload(
  input: DeviceCommandRefusedPayload,
): DeviceCommandRefusedPayload {
  return normalizeRefused(input);
}

function normalizeResponsePayload(value: unknown): DeviceCommandResponsePayload {
  if (!isRecord(value)) return fail('Device command response payload is invalid');
  if (value.type === DEVICE_COMMAND_RESULT_TYPE) return normalizeResult(value);
  if (value.type === DEVICE_COMMAND_REFUSED_TYPE) return normalizeRefused(value);
  return fail('Device command response type is invalid');
}

export function deviceCommandResponsePayloadBytes(
  value: DeviceCommandResponsePayload,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizeResponsePayload(value)));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length > 24_000 || !BASE64_PATTERN.test(value)) {
    return fail('Device command response encoding is invalid');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return fail('Device command response encoding is invalid');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength === 0
    || bytes.byteLength > DEVICE_COMMAND_MAX_MESSAGE_BYTES
    || encodeBase64(bytes) !== value
  ) {
    return fail('Device command response bytes are invalid');
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return fail('SHA-256 is unavailable');
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildDeviceCommandResponseMessage(
  input: DeviceCommandResponseMessageInput,
): Promise<DeviceCommandResponseMessage> {
  if (!input || typeof input !== 'object') return fail('Command response input is invalid');
  const payload = normalizeResponsePayload(input.payload);
  const signature = identifier(
    input.signature,
    MAX_SIGNATURE_LENGTH,
    'Command response signature',
  );
  const payloadBytes = deviceCommandResponsePayloadBytes(payload);
  return Object.freeze({
    schemaVersion: DEVICE_COMMAND_MESSAGE_VERSION,
    type: payload.type,
    issuerKeyId: payload.issuerKeyId,
    sha256: await sha256(payloadBytes),
    payloadBase64: encodeBase64(payloadBytes),
    signature,
  });
}

export async function parseDeviceCommandResponseMessage(
  value: unknown,
): Promise<{
  readonly message: DeviceCommandResponseMessage;
  readonly payload: DeviceCommandResponsePayload;
  readonly payloadBytes: Uint8Array;
}> {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'type',
      'issuerKeyId',
      'sha256',
      'payloadBase64',
      'signature',
    ])
    || value.schemaVersion !== DEVICE_COMMAND_MESSAGE_VERSION
    || (value.type !== DEVICE_COMMAND_RESULT_TYPE && value.type !== DEVICE_COMMAND_REFUSED_TYPE)
    || typeof value.payloadBase64 !== 'string'
  ) {
    return fail('Device command response message is invalid');
  }
  const issuerKeyId = identifier(
    value.issuerKeyId,
    MAX_IDENTIFIER_LENGTH,
    'Command response issuer',
  );
  const responseHash = sha256Value(value.sha256, 'Command response hash');
  const signature = identifier(
    value.signature,
    MAX_SIGNATURE_LENGTH,
    'Command response signature',
  );
  const payloadBytes = decodeBase64(value.payloadBase64);
  if (await sha256(payloadBytes) !== responseHash) {
    return fail('Device command response hash does not match its payload');
  }
  let payloadValue: unknown;
  try {
    payloadValue = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return fail('Device command response payload is invalid');
  }
  const payload = normalizeResponsePayload(payloadValue);
  if (
    payload.type !== value.type
    || payload.issuerKeyId !== issuerKeyId
    || !sameBytes(payloadBytes, deviceCommandResponsePayloadBytes(payload))
  ) {
    return fail('Device command response payload is not canonical');
  }
  return Object.freeze({
    message: Object.freeze({
      schemaVersion: DEVICE_COMMAND_MESSAGE_VERSION,
      type: value.type,
      issuerKeyId,
      sha256: responseHash,
      payloadBase64: value.payloadBase64,
      signature,
    }),
    payload,
    payloadBytes: payloadBytes.slice(),
  });
}
