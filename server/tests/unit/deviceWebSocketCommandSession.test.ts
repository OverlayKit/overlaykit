import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import {
  DEVICE_COMMAND_EXECUTE_TYPE,
  DEVICE_COMMAND_EXECUTE_VERSION,
  parseDeviceCommandResponseMessage,
  type DeviceCommandResponseMessage,
} from '@overlaykit/protocol/device-command';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceWebSocketCommandSessionFactory,
  type DeviceCommandExecutionPort,
} from '../../src/services/DeviceWebSocketCommandSession';
import type { DeviceBootstrapSession } from '../../src/services/DeviceBootstrapSessionRuntime';
import type { ProductionCommandOutcome } from '../../src/types/production';
import { ProductionError, type ProductionService } from '../../src/services/ProductionService';
import { DeviceConnectionAuthorityError } from '../../src/services/DeviceConnectionAuthorityCoordinator';
import { productionVisibilityIntentHash } from '../../src/services/SqliteProductionStateStore';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function authority(): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g2',
    generation: 2,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['lower-third.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: Date.now() + 60_000,
  };
}

function command(
  operationId = 'operation-1',
  target: 'preview' | 'program' = 'preview',
  visible = true,
): string {
  return JSON.stringify({
    schemaVersion: DEVICE_COMMAND_EXECUTE_VERSION,
    type: DEVICE_COMMAND_EXECUTE_TYPE,
    operationId,
    target,
    basedOn: {
      issuerKeyId: 'issuer-1',
      sequence: target === 'preview' ? 17 : 18,
      sha256: (target === 'preview' ? 'a' : 'b').repeat(64),
      productionRevision: 4,
      catalogGeneration: 3,
    },
    intent: {
      kind: 'component.visibility',
      componentId: 'lower-third',
      visible,
      expectedRevision: 4,
    },
  });
}

function outcome(
  operationId: string,
  overrides: Partial<ProductionCommandOutcome> = {},
): ProductionCommandOutcome {
  return {
    status: 'applied',
    resultCode: 'APPLIED',
    globalSequence: 9,
    operationId,
    intentHash: 'c'.repeat(64),
    authorityGeneration: 2,
    expectedRevision: 4,
    previousRevision: 4,
    resultingRevision: 5,
    resultingSnapshotHash: 'd'.repeat(64),
    committedAt: 100,
    replayed: false,
    ...overrides,
  };
}

function result(
  intent: Parameters<ProductionService['executeDeviceVisibilityCommand']>[0],
  overrides: Partial<ProductionCommandOutcome> = {},
) {
  return {
    receipt: {},
    state: {},
    command: outcome(intent.operationId, {
      intentHash: productionVisibilityIntentHash(intent),
      ...overrides,
    }),
  } as unknown as ReturnType<ProductionService['executeDeviceVisibilityCommand']>;
}

function stateSession(options: {
  ready?: boolean;
  issuerKeyId?: string;
  sequence?: number;
  sha256?: string;
  revision?: number;
  catalogGeneration?: number;
} = {}): DeviceBootstrapSession {
  const issuerKeyId = options.issuerKeyId ?? 'issuer-1';
  return {
    start: async () => undefined,
    receive: async () => undefined,
    dispose: async () => undefined,
    isReady: () => true,
    isTargetReady: () => options.ready ?? true,
    commandEvidence: (target) => ({
      target,
      ready: options.ready ?? true,
      issuerKeyId,
      sequence: options.sequence ?? (target === 'preview' ? 17 : 18),
      sha256: options.sha256 ?? (target === 'preview' ? 'a' : 'b').repeat(64),
      productionRevision: options.revision ?? 4,
      catalogGeneration: options.catalogGeneration ?? 3,
    }),
    confirmedIssuerKeyId: () => issuerKeyId,
  };
}

async function harness(options: {
  state?: DeviceBootstrapSession;
  authority?: DeviceCredentialAuthority;
  execute?: DeviceCommandExecutionPort['execute'];
  production?: ProductionService['executeDeviceVisibilityCommand'];
  issuerKeyId?: string;
  send?: (message: DeviceCommandResponseMessage) => void | Promise<void>;
  sendTimeoutMs?: number;
} = {}) {
  const sent: DeviceCommandResponseMessage[] = [];
  const closes: string[] = [];
  const signingBytes: Uint8Array[] = [];
  const production = vi.fn(options.production ?? ((intent, authorization) => {
    authorization.admitNewCommand?.();
    return result(intent);
  }));
  const execute = vi.fn(options.execute ?? (async (operation) => operation()));
  const factory = new DeviceWebSocketCommandSessionFactory({
    production: {
      executeDeviceVisibilityCommand: production as ProductionService['executeDeviceVisibilityCommand'],
    },
    signing: {
      current: () => ({
        issuerKeyId: options.issuerKeyId ?? 'issuer-1',
        sign: async (bytes) => {
          signingBytes.push(bytes.slice());
          return 'detached-signature';
        },
      }),
    },
    sendTimeoutMs: options.sendTimeoutMs,
  });
  const session = await factory.create({
    authority: options.authority ?? authority(),
    state: options.state ?? stateSession(),
    execution: { execute },
    transport: {
      send: options.send ?? ((message) => {
        sent.push(message);
      }),
      close: async (reason) => {
        closes.push(reason);
      },
    },
  });
  return { session, sent, closes, signingBytes, production, execute };
}

describe('DeviceWebSocketCommandSession', () => {
  it('executes one state-bound command and emits only a signed historical result', async () => {
    const mounted = await harness();
    await mounted.session.receiveJson(command());

    expect(mounted.production).toHaveBeenCalledTimes(1);
    expect(mounted.execute).toHaveBeenCalledTimes(1);
    expect(mounted.closes).toEqual([]);
    expect(mounted.sent).toHaveLength(1);
    const parsed = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(parsed.payload).toMatchObject({
      type: 'device.command.result',
      audienceCredentialId: 'device-1.g2',
      operationId: 'operation-1',
      outcome: 'applied',
      resultingRevision: 5,
      replayed: false,
    });
    expect(Object.keys(parsed.payload)).not.toContain('state');
    expect(mounted.signingBytes[0]).toEqual(parsed.payloadBytes);
  });

  it('refuses a new command without invoking durable authority when its base is not current', async () => {
    const mounted = await harness({ state: stateSession({ ready: false }) });
    await mounted.session.receiveJson(command());

    expect(mounted.production).toHaveBeenCalledTimes(1);
    const parsed = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(parsed.payload).toMatchObject({
      type: 'device.command.refused',
      operationId: 'operation-1',
      reason: 'not_ready',
    });
    expect(mounted.closes).toEqual([]);
  });

  it('allows an exact historical replay while the target is not ready', async () => {
    const mounted = await harness({
      state: stateSession({ ready: false }),
      production: (intent) => result(intent, { replayed: true }),
    });
    await mounted.session.receiveJson(command());

    const parsed = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(parsed.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'operation-1',
      replayed: true,
    });
  });

  it('does not consume an operation identity when base admission is refused', async () => {
    const mounted = await harness({ state: stateSession({ revision: 5 }) });
    await mounted.session.receiveJson(command('operation-retry'));

    const refused = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(refused.payload).toMatchObject({
      type: 'device.command.refused',
      operationId: 'operation-retry',
      reason: 'base_mismatch',
    });

    const current = JSON.parse(command('operation-retry')) as {
      basedOn: { productionRevision: number };
      intent: { expectedRevision: number };
    };
    current.basedOn.productionRevision = 5;
    current.intent.expectedRevision = 5;
    await mounted.session.receiveJson(JSON.stringify(current));

    expect(mounted.production).toHaveBeenCalledTimes(2);
    const accepted = await parseDeviceCommandResponseMessage(mounted.sent[1]);
    expect(accepted.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'operation-retry',
    });
  });

  it('refuses a command outside connection scope without touching production authority', async () => {
    const mounted = await harness({
      authority: {
        ...authority(),
        scopes: ['feedback:read'],
      },
    });
    await mounted.session.receiveJson(command());

    expect(mounted.production).not.toHaveBeenCalled();
    const refused = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(refused.payload).toMatchObject({
      type: 'device.command.refused',
      reason: 'not_authorized',
    });
  });

  it.each([
    ['OPERATION_ID_CONFLICT', 'operation_conflict'],
    ['PRODUCTION_COMMAND_JOURNAL_FULL', 'capacity_exhausted'],
    ['COMPONENT_NOT_FOUND', 'target_unavailable'],
  ] as const)('maps %s to the closed refusal %s', async (code, reason) => {
    const mounted = await harness({
      production: () => {
        throw new ProductionError(code, code, 409);
      },
    });
    await mounted.session.receiveJson(command());

    const refused = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(refused.payload).toMatchObject({
      type: 'device.command.refused',
      reason,
    });
    expect(mounted.closes).toEqual([]);
  });

  it('emits an admitted revision conflict as a durable terminal result', async () => {
    const mounted = await harness({
      production: (intent) => {
        throw new ProductionError(
          'TARGET_REVISION_CONFLICT',
          'stale revision',
          409,
          {
            command: outcome(intent.operationId, {
              intentHash: productionVisibilityIntentHash(intent),
              status: 'rejected',
              resultCode: 'TARGET_REVISION_CONFLICT',
              previousRevision: 7,
              resultingRevision: 7,
            }),
          },
        );
      },
    });
    await mounted.session.receiveJson(command());

    const resultMessage = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(resultMessage.payload).toMatchObject({
      type: 'device.command.result',
      outcome: 'rejected',
      resultCode: 'TARGET_REVISION_CONFLICT',
      expectedRevision: 4,
      previousRevision: 7,
      resultingRevision: 7,
    });
  });

  it('coalesces an identical in-flight operation and refuses another new operation per target', async () => {
    const firstAdmission = deferred<void>();
    let executions = 0;
    const mounted = await harness({
      execute: async (operation) => {
        executions += 1;
        if (executions === 1) await firstAdmission.promise;
        return operation();
      },
    });

    const first = mounted.session.receiveJson(command('operation-1'));
    await Promise.resolve();
    const duplicate = mounted.session.receiveJson(command('operation-1'));
    const other = mounted.session.receiveJson(command('operation-2'));
    await other;
    firstAdmission.resolve();
    await Promise.all([first, duplicate]);

    expect(mounted.production).toHaveBeenCalledTimes(2);
    expect(mounted.sent).toHaveLength(2);
    const payloads = await Promise.all(mounted.sent.map(async (message) => (
      await parseDeviceCommandResponseMessage(message)
    ).payload));
    expect(payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'operation-1', type: 'device.command.result' }),
      expect.objectContaining({ operationId: 'operation-2', reason: 'not_ready' }),
    ]));
  });

  it('admits Preview and Program independently', async () => {
    const previewAdmission = deferred<void>();
    let executions = 0;
    const mounted = await harness({
      execute: async (operation) => {
        executions += 1;
        if (executions === 1) await previewAdmission.promise;
        return operation();
      },
    });

    const preview = mounted.session.receiveJson(command('preview-operation', 'preview'));
    await Promise.resolve();
    await mounted.session.receiveJson(command('program-operation', 'program'));

    const programResult = await parseDeviceCommandResponseMessage(mounted.sent[0]);
    expect(programResult.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'program-operation',
    });
    previewAdmission.resolve();
    await preview;
    expect(mounted.production).toHaveBeenCalledTimes(2);
    expect(mounted.sent).toHaveLength(2);
  });

  it('closes on malformed protocol, issuer rotation, and unresolved response delivery', async () => {
    const malformed = await harness();
    await malformed.session.receiveJson('{"type":"device.command.execute","type":"duplicate"}');
    expect(malformed.closes).toEqual(['command.protocol_violation']);
    expect(malformed.production).not.toHaveBeenCalled();

    const rotated = await harness({ issuerKeyId: 'issuer-2' });
    await rotated.session.receiveJson(command());
    expect(rotated.closes).toEqual(['command.issuer_rotated']);
    expect(rotated.sent).toEqual([]);

    const transport = await harness({
      sendTimeoutMs: 5,
      send: () => new Promise<void>(() => undefined),
    });
    await transport.session.receiveJson(command());
    expect(transport.closes).toEqual(['command.transport_failure']);
  });

  it('distinguishes authority loss and malformed internal outcomes', async () => {
    const retired = await harness({
      execute: async () => {
        throw new DeviceConnectionAuthorityError(
          'DEVICE_CONNECTION_NOT_ACTIVE',
          'retired',
        );
      },
    });
    await retired.session.receiveJson(command());
    expect(retired.closes).toEqual(['command.authority_changed']);

    const unexpected = await harness({
      execute: async () => {
        throw new Error('unexpected coordinator failure');
      },
    });
    await unexpected.session.receiveJson(command());
    expect(unexpected.closes).toEqual(['command.internal_error']);

    const inconsistent = await harness({
      production: (intent) => result(intent, {
        status: 'applied',
        resultCode: 'TARGET_REVISION_CONFLICT',
      }),
    });
    await inconsistent.session.receiveJson(command());
    expect(inconsistent.closes).toEqual(['command.internal_error']);
    expect(inconsistent.sent).toEqual([]);

    const crossed = await harness({
      production: (intent) => result(intent, { intentHash: 'f'.repeat(64) }),
    });
    await crossed.session.receiveJson(command());
    expect(crossed.closes).toEqual(['command.internal_error']);
    expect(crossed.sent).toEqual([]);
  });
});
