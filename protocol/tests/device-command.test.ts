import { describe, expect, it } from 'vitest';
import {
  DEVICE_COMMAND_EXECUTE_TYPE,
  DEVICE_COMMAND_EXECUTE_VERSION,
  DEVICE_COMMAND_MESSAGE_VERSION,
  DEVICE_COMMAND_REFUSED_TYPE,
  DEVICE_COMMAND_REFUSED_VERSION,
  DEVICE_COMMAND_RESULT_TYPE,
  DEVICE_COMMAND_RESULT_VERSION,
  DeviceCommandProtocolError,
  buildDeviceCommandRefusedPayload,
  buildDeviceCommandResponseMessage,
  buildDeviceCommandResultPayload,
  deviceCommandExecuteBytes,
  deviceCommandIntentBytes,
  parseDeviceCommandExecuteJson,
  parseDeviceCommandResponseMessage,
} from '../src/device-command.js';

function executeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: DEVICE_COMMAND_EXECUTE_VERSION,
    type: DEVICE_COMMAND_EXECUTE_TYPE,
    operationId: 'operation-1',
    target: 'preview',
    basedOn: {
      issuerKeyId: 'issuer-1',
      sequence: 17,
      sha256: 'a'.repeat(64),
      productionRevision: 4,
      catalogGeneration: 3,
    },
    intent: {
      kind: 'component.visibility',
      componentId: 'lower-third',
      visible: true,
      expectedRevision: 4,
    },
    ...overrides,
  });
}

describe('device command protocol', () => {
  it('normalizes equivalent command JSON while rejecting ambiguous properties', () => {
    const canonical = parseDeviceCommandExecuteJson(executeJson());
    const reordered = parseDeviceCommandExecuteJson(`{
      "intent":{"visible":true,"expectedRevision":4,"componentId":"lower-third","kind":"component.visibility"},
      "basedOn":{"catalogGeneration":3,"productionRevision":4,"sha256":"${'a'.repeat(64)}","sequence":17,"issuerKeyId":"issuer-1"},
      "target":"preview","operationId":"operation-1","type":"device.command.execute",
      "schemaVersion":"overlaykit-device-command-execute/v1"
    }`);

    expect(reordered).toEqual(canonical);
    expect(deviceCommandExecuteBytes(reordered)).toEqual(deviceCommandExecuteBytes(canonical));
    expect(new TextDecoder().decode(deviceCommandIntentBytes(canonical))).toBe(
      '{"schemaVersion":"overlaykit-device-command-intent/v1","target":"preview","kind":"component.visibility","componentId":"lower-third","visible":true,"expectedRevision":4}',
    );

    expect(() => parseDeviceCommandExecuteJson(
      executeJson().replace('"operationId":"operation-1"', '"operationId":"operation-1","operationId":"other"'),
    )).toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(
      executeJson().replace('"componentId":"lower-third"', '"componentId":"lower-third","component\\u0049d":"other"'),
    )).toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(
      executeJson().replace('{', '{"__proto__":{},'),
    )).toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(
      executeJson().replace('{', `{\u00a0`),
    )).toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(executeJson({ showId: 'attacker-show' })))
      .toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(executeJson({ operationId: '' })))
      .toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(executeJson({ operationId: 'x'.repeat(101) })))
      .toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(` ${' '.repeat(16_384)}`))
      .toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(executeJson({
      intent: {
        kind: 'scene.take',
        componentId: 'lower-third',
        visible: true,
        expectedRevision: 4,
      },
    }))).toThrowError(DeviceCommandProtocolError);
    expect(() => parseDeviceCommandExecuteJson(executeJson({
      basedOn: {
        issuerKeyId: 'issuer-1',
        sequence: 17,
        sha256: 'a'.repeat(64),
        productionRevision: 5,
        catalogGeneration: 3,
      },
    }))).toThrowError(DeviceCommandProtocolError);
  });

  it('builds a canonical signed terminal message without current state', async () => {
    const payload = buildDeviceCommandResultPayload({
      schemaVersion: DEVICE_COMMAND_RESULT_VERSION,
      type: DEVICE_COMMAND_RESULT_TYPE,
      issuerKeyId: 'issuer-1',
      audienceCredentialId: 'device-1.g2',
      operationId: 'operation-1',
      intentSha256: 'b'.repeat(64),
      outcome: 'applied',
      resultCode: 'APPLIED',
      commandSequence: 9,
      expectedRevision: 4,
      previousRevision: 4,
      resultingRevision: 5,
      replayed: false,
    });
    const message = await buildDeviceCommandResponseMessage({
      payload,
      signature: 'detached-signature',
    });
    const parsed = await parseDeviceCommandResponseMessage(message);

    expect(message).toMatchObject({
      schemaVersion: DEVICE_COMMAND_MESSAGE_VERSION,
      type: DEVICE_COMMAND_RESULT_TYPE,
      issuerKeyId: 'issuer-1',
      signature: 'detached-signature',
    });
    expect(parsed.payload).toEqual(payload);
    expect(Object.keys(parsed.payload)).not.toContain('state');
    expect(Object.keys(parsed.payload)).not.toContain('snapshot');
    expect(Object.isFrozen(parsed.payload)).toBe(true);

    await expect(parseDeviceCommandResponseMessage({
      ...message,
      sha256: 'c'.repeat(64),
    })).rejects.toThrowError(DeviceCommandProtocolError);
  });

  it('binds a non-durable refusal to the canonical request hash', async () => {
    const payload = buildDeviceCommandRefusedPayload({
      schemaVersion: DEVICE_COMMAND_REFUSED_VERSION,
      type: DEVICE_COMMAND_REFUSED_TYPE,
      issuerKeyId: 'issuer-1',
      audienceCredentialId: 'device-1.g2',
      operationId: 'operation-1',
      requestSha256: 'd'.repeat(64),
      reason: 'not_ready',
    });
    const parsed = await parseDeviceCommandResponseMessage(
      await buildDeviceCommandResponseMessage({ payload, signature: 'signature' }),
    );

    expect(parsed.payload).toEqual(payload);
    expect(parsed.payload.type).toBe(DEVICE_COMMAND_REFUSED_TYPE);
    expect(() => buildDeviceCommandRefusedPayload({
      ...payload,
      reason: 'retry_later' as 'not_ready',
    })).toThrowError(DeviceCommandProtocolError);
  });
});
