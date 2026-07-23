import { generateKeyPairSync, sign, verify } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import {
  DEVICE_COMMAND_EXECUTE_TYPE,
  DEVICE_COMMAND_EXECUTE_VERSION,
  parseDeviceCommandResponseMessage,
  type DeviceCommandResponseMessage,
} from '@overlaykit/protocol/device-command';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDeviceCredentialRuntime,
  type DeviceCredentialRuntime,
} from '../../src/auth/DeviceCredentialRuntime';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { ChannelManager } from '../../src/services/ChannelManager';
import type { DeviceBootstrapSession } from '../../src/services/DeviceBootstrapSessionRuntime';
import { DeviceWebSocketCommandSessionFactory } from '../../src/services/DeviceWebSocketCommandSession';
import { ProductionService } from '../../src/services/ProductionService';
import type { SqliteProductionStateStore } from '../../src/services/SqliteProductionStateStore';

interface OpenAuthority {
  readonly runtime: DeviceCredentialRuntime;
  readonly persistence: SqliteProductionStateStore;
  readonly production: ProductionService;
}

interface MutableEvidence {
  ready: boolean;
  sequence: number;
  sha256: string;
  productionRevision: number;
}

const runtimes: DeviceCredentialRuntime[] = [];
const directories: string[] = [];

async function openAuthority(databasePath: string): Promise<OpenAuthority> {
  const credentials = new SqliteDeviceCredentialStore({ databasePath });
  await credentials.init();
  const persistence = credentials.createProductionStateStore();
  const runtime = await createDeviceCredentialRuntime({
    store: credentials,
    productionState: persistence,
  });
  const production = new ProductionService(new ChannelManager());
  production.mountPersistence(persistence);
  runtimes.push(runtime);
  return { runtime, persistence, production };
}

async function closeTracked(runtime: DeviceCredentialRuntime): Promise<void> {
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
}

async function requiredAuthority(
  runtime: DeviceCredentialRuntime,
  token: string,
): Promise<DeviceCredentialAuthority> {
  const authority = await runtime.lifecycle.authenticate(token);
  if (!authority) throw new Error('Device credential did not authenticate');
  return authority;
}

function stateSession(evidence: MutableEvidence): DeviceBootstrapSession {
  return {
    async start() {},
    async receive() {},
    async dispose() {},
    isReady: () => evidence.ready,
    isTargetReady: () => evidence.ready,
    commandEvidence: (target) => ({
      target,
      ready: evidence.ready,
      issuerKeyId: 'issuer-1',
      sequence: evidence.sequence,
      sha256: evidence.sha256,
      productionRevision: evidence.productionRevision,
      catalogGeneration: 1,
    }),
    confirmedIssuerKeyId: () => 'issuer-1',
  };
}

function commandJson(
  operationId: string,
  visible: boolean,
  productionRevision: number,
  sequence: number,
  sha256: string,
): string {
  return JSON.stringify({
    schemaVersion: DEVICE_COMMAND_EXECUTE_VERSION,
    type: DEVICE_COMMAND_EXECUTE_TYPE,
    operationId,
    target: 'preview',
    basedOn: {
      issuerKeyId: 'issuer-1',
      sequence,
      sha256,
      productionRevision,
      catalogGeneration: 1,
    },
    intent: {
      kind: 'component.visibility',
      componentId: 'lower-third',
      visible,
      expectedRevision: productionRevision,
    },
  });
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('device WebSocket command SQLite authority', () => {
  it('recovers a lost response after restart and does not consume refused identities', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaykit-ws-command-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'authority.sqlite');
    const first = await openAuthority(databasePath);
    first.production.loadPreview('show-1', {
      id: 'scene-1',
      name: 'Scene 1',
      elements: [{ id: 'lower-third', tag: 'section', content: 'Guest', styles: {} }],
    });
    const issued = await first.runtime.lifecycle.issue(
      { principalId: 'owner-1', roles: ['owner'] },
      {
        label: 'Production desk',
        showId: 'show-1',
        targets: ['preview'],
        controlIds: ['lower-third.visibility'],
        scopes: ['component.visibility:write'],
        expiresAt: Date.now() + 60_000,
      },
    );
    const keys = generateKeyPairSync('ed25519');
    const signing = {
      current: () => ({
        issuerKeyId: 'issuer-1',
        sign: (bytes: Uint8Array) => sign(null, bytes, keys.privateKey).toString('base64url'),
      }),
    };
    const initialHash = 'a'.repeat(64);
    const initialCommand = commandJson('lost-response', false, 1, 10, initialHash);
    const lostMessages: DeviceCommandResponseMessage[] = [];
    const lostCloses: string[] = [];
    const firstFactory = new DeviceWebSocketCommandSessionFactory({
      production: first.production,
      signing,
    });
    const firstSession = await firstFactory.create({
      authority: await requiredAuthority(first.runtime, issued.token),
      state: stateSession({
        ready: true,
        sequence: 10,
        sha256: initialHash,
        productionRevision: 1,
      }),
      execution: { execute: async (operation) => operation() },
      transport: {
        send(message) {
          lostMessages.push(message);
          throw new Error('response disappeared after commit');
        },
        close: async (reason) => {
          lostCloses.push(reason);
        },
      },
    });

    await firstSession.receiveJson(initialCommand);

    expect(lostCloses).toEqual(['command.transport_failure']);
    expect(first.persistence.readCommandJournal()).toHaveLength(1);
    expect(first.production.getSnapshot('show-1', 'preview').revision).toBe(2);
    const lostResult = await parseDeviceCommandResponseMessage(lostMessages[0]);
    expect(lostResult.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'lost-response',
      outcome: 'applied',
      previousRevision: 1,
      resultingRevision: 2,
      replayed: false,
    });
    expect(verify(
      null,
      lostResult.payloadBytes,
      keys.publicKey,
      Buffer.from(lostMessages[0].signature, 'base64url'),
    )).toBe(true);
    firstSession.dispose();
    await closeTracked(first.runtime);

    const successor = await openAuthority(databasePath);
    const currentEvidence: MutableEvidence = {
      ready: false,
      sequence: 11,
      sha256: 'b'.repeat(64),
      productionRevision: 2,
    };
    const sent: DeviceCommandResponseMessage[] = [];
    const closes: string[] = [];
    const successorFactory = new DeviceWebSocketCommandSessionFactory({
      production: successor.production,
      signing,
    });
    const successorSession = await successorFactory.create({
      authority: await requiredAuthority(successor.runtime, issued.token),
      state: stateSession(currentEvidence),
      execution: { execute: async (operation) => operation() },
      transport: {
        send: (message) => {
          sent.push(message);
        },
        close: async (reason) => {
          closes.push(reason);
        },
      },
    });

    await successorSession.receiveJson(initialCommand);
    const replay = await parseDeviceCommandResponseMessage(sent[0]);
    expect(replay.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'lost-response',
      commandSequence: 1,
      previousRevision: 1,
      resultingRevision: 2,
      replayed: true,
    });
    expect(successor.persistence.readCommandJournal()).toHaveLength(1);
    expect(successor.production.getSnapshot('show-1', 'preview').revision).toBe(2);

    currentEvidence.ready = true;
    await successorSession.receiveJson(commandJson(
      'refused-then-admitted',
      true,
      1,
      10,
      initialHash,
    ));
    const refused = await parseDeviceCommandResponseMessage(sent[1]);
    expect(refused.payload).toMatchObject({
      type: 'device.command.refused',
      operationId: 'refused-then-admitted',
      reason: 'base_mismatch',
    });
    expect(successor.persistence.readCommandJournal()).toHaveLength(1);

    await successorSession.receiveJson(commandJson(
      'refused-then-admitted',
      true,
      2,
      currentEvidence.sequence,
      currentEvidence.sha256,
    ));
    const admitted = await parseDeviceCommandResponseMessage(sent[2]);
    expect(admitted.payload).toMatchObject({
      type: 'device.command.result',
      operationId: 'refused-then-admitted',
      outcome: 'applied',
      commandSequence: 2,
      previousRevision: 2,
      resultingRevision: 3,
      replayed: false,
    });
    expect(successor.persistence.readCommandJournal()).toHaveLength(2);
    expect(successor.production.getSnapshot('show-1', 'preview').revision).toBe(3);
    expect(closes).toEqual([]);
  });
});
