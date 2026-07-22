import { createHash, generateKeyPairSync, sign as signBytes, verify, type KeyObject } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  admitDeviceControlFrame,
  type DeviceControlFrameAuthorityContext,
} from '@overlaykit/protocol/device-control-frame';
import type { DeviceCredentialAuthority } from '@overlaykit/protocol/device-credential';
import type { Scene } from '../../src/types/scene';
import { ChannelManager } from '../../src/services/ChannelManager';
import { createDeviceActionCatalogRuntime } from '../../src/services/DeviceActionCatalogRuntime';
import {
  createDeviceBootstrapSnapshotIssuer,
  DeviceBootstrapSnapshotIssuerError,
  type DeviceBootstrapSigner,
  type DeviceBootstrapSigningAuthority,
} from '../../src/services/DeviceBootstrapSnapshotIssuer';
import type {
  CatalogGenerationAuthority,
  CatalogGenerationStoreState,
  CatalogGenerationToken,
} from '../../src/services/FileCatalogGenerationStore';
import type { FeedbackSequenceStore } from '../../src/services/FileFeedbackSequenceStore';
import { ProductionService } from '../../src/services/ProductionService';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class MemoryCatalogGenerationAuthority implements CatalogGenerationAuthority {
  readonly events: string[];
  readonly init = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  private current: CatalogGenerationToken | null = null;
  private durable: CatalogGenerationToken | null = null;
  private confirmationGate: ReturnType<typeof deferred> | null = null;
  private confirmationStarted: ReturnType<typeof deferred> | null = null;
  failNextConfirmation = false;

  constructor(
    private readonly audienceCredentialId: string,
    events: string[] = []
  ) {
    this.events = events;
  }

  observe(catalogHash: string): CatalogGenerationToken {
    this.events.push(`catalog.observe:${catalogHash}`);
    if (this.current?.catalogHash === catalogHash) return this.current;
    this.current = Object.freeze({
      audienceCredentialId: this.audienceCredentialId,
      generation: (this.current?.generation ?? this.durable?.generation ?? 0) + 1,
      catalogHash,
    });
    return this.current;
  }

  async confirm(token: CatalogGenerationToken): Promise<void> {
    this.events.push(`catalog.persist:${token.generation}`);
    this.confirmationStarted?.resolve();
    if (this.confirmationGate) await this.confirmationGate.promise;
    if (this.failNextConfirmation) {
      this.failNextConfirmation = false;
      throw Object.assign(new Error('catalog persistence unavailable'), {
        code: 'CATALOG_GENERATION_STORE_IO',
      });
    }
    if (this.current !== token) {
      throw Object.assign(new Error('stale catalog generation'), {
        code: 'STALE_CATALOG_GENERATION',
      });
    }
    this.durable = token;
  }

  gateNextConfirmation(): { readonly started: Promise<void>; release(): void } {
    this.confirmationGate = deferred();
    this.confirmationStarted = deferred();
    return {
      started: this.confirmationStarted.promise,
      release: () => {
        this.confirmationGate?.resolve();
        this.confirmationGate = null;
        this.confirmationStarted = null;
      },
    };
  }

  isCurrent(token: CatalogGenerationToken): boolean {
    return this.current === token && this.durable === token;
  }

  getState(): CatalogGenerationStoreState {
    return {
      phase: this.current === this.durable ? 'ready' : 'blocked',
      durability: 'power_loss_resilient',
      authorityHeld: true,
      currentGeneration: this.current?.generation ?? null,
      durableGeneration: this.durable?.generation ?? null,
      lastErrorCode: null,
    };
  }
}

class MemorySequenceStore implements FeedbackSequenceStore {
  readonly init = vi.fn(async () => undefined);
  readonly events: string[];
  readonly reservations: Array<{ issuerKeyId: string; sequence: number }> = [];
  private readonly values = new Map<string, number>();

  constructor(events: string[] = []) {
    this.events = events;
  }

  async reserve(
    issuerKeyId: string,
    audienceCredentialId: string,
    count: number
  ): Promise<ReadonlyArray<number>> {
    this.events.push(`sequence.reserve:${issuerKeyId}`);
    if (count !== 1) throw new Error('unexpected reservation size');
    const key = JSON.stringify([issuerKeyId, audienceCredentialId]);
    const sequence = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, sequence);
    this.reservations.push({ issuerKeyId, sequence });
    return [sequence];
  }
}

class MutableSigningAuthority implements DeviceBootstrapSigningAuthority {
  readonly events: string[];
  private issuerKeyId = 'server-key-1';
  private privateKey: KeyObject;
  private signGate: ReturnType<typeof deferred> | null = null;
  private signStarted: ReturnType<typeof deferred> | null = null;
  failNext = false;

  constructor(privateKey: KeyObject, events: string[] = []) {
    this.privateKey = privateKey;
    this.events = events;
  }

  current(): DeviceBootstrapSigner {
    const issuerKeyId = this.issuerKeyId;
    const privateKey = this.privateKey;
    return {
      issuerKeyId,
      sign: async (bytes) => {
        this.events.push(`sign:${issuerKeyId}`);
        this.signStarted?.resolve();
        if (this.signGate) await this.signGate.promise;
        if (this.failNext) {
          this.failNext = false;
          throw new Error('signer unavailable');
        }
        return signBytes(null, bytes, privateKey).toString('base64url');
      },
    };
  }

  rotate(issuerKeyId: string, privateKey: KeyObject): void {
    this.issuerKeyId = issuerKeyId;
    this.privateKey = privateKey;
  }

  gateNextSignature(): { readonly started: Promise<void>; release(): void } {
    this.signGate = deferred();
    this.signStarted = deferred();
    return {
      started: this.signStarted.promise,
      release: () => {
        this.signGate?.resolve();
        this.signGate = null;
        this.signStarted = null;
      },
    };
  }
}

function authority(overrides: Partial<DeviceCredentialAuthority> = {}): DeviceCredentialAuthority {
  return {
    credentialId: 'device-1',
    audienceCredentialId: 'device-1.g1',
    generation: 1,
    showId: 'show-1',
    targets: ['preview', 'program'],
    controlIds: ['alpha.visibility', 'zulu.visibility'],
    scopes: ['feedback:read', 'component.visibility:write'],
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function scene(ids: ReadonlyArray<string> = ['zulu', 'alpha']): Scene {
  return {
    id: `scene-${ids.join('-') || 'empty'}`,
    name: 'Bootstrap scene',
    elements: ids.map((id) => ({
      id,
      tag: 'div',
      content: id === 'alpha' ? 'Alpha' : id === 'zulu' ? 'Zulu' : id,
      styles: id === 'alpha' ? { display: 'none' } : {},
    })),
  };
}

function admissionAuthority(
  device: DeviceCredentialAuthority,
  issuerKeyId: string,
  lastAcceptedSequence = 0
): DeviceControlFrameAuthorityContext {
  return {
    issuerKeyId,
    audienceCredentialId: device.audienceCredentialId,
    showId: device.showId,
    targets: [...device.targets],
    controlIds: [...device.controlIds],
    scopes: ['feedback:read', 'component.visibility:write'],
    lastAcceptedSequence,
  };
}

async function harness(
  options: {
    readonly device?: DeviceCredentialAuthority;
    readonly production?: ProductionService;
    readonly now?: () => number;
    readonly events?: string[];
  } = {}
) {
  const events = options.events ?? [];
  const device = options.device ?? authority();
  const production = options.production
    ?? new ProductionService(new ChannelManager(), { allowEphemeral: true });
  const productionPort = { getState: vi.fn((showId: string) => production.getState(showId)) };
  const keys = generateKeyPairSync('ed25519');
  const signing = new MutableSigningAuthority(keys.privateKey, events);
  const catalogGenerations = new MemoryCatalogGenerationAuthority(
    device.audienceCredentialId,
    events
  );
  const sequences = new MemorySequenceStore(events);
  const issuer = await createDeviceBootstrapSnapshotIssuer({
    authority: device,
    production: productionPort,
    actionCatalog: await createDeviceActionCatalogRuntime(),
    catalogGenerations,
    sequences,
    signing,
    now: options.now,
  });
  return {
    device,
    production,
    productionPort,
    keys,
    signing,
    catalogGenerations,
    sequences,
    issuer,
    events,
  };
}

describe('DeviceBootstrapSnapshotIssuer', () => {
  it('builds one-cut canonical signed payloads, including an empty authorized target', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    let now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const events: string[] = [];
    const context = await harness({ production, now: () => now, events });
    context.events.splice(0);
    context.productionPort.getState.mockClear();

    const preview = await context.issuer.create('preview');
    expect(context.productionPort.getState).toHaveBeenCalledTimes(1);
    expect(context.events.map((event) => event.split(':')[0])).toEqual([
      'catalog.observe',
      'catalog.persist',
      'sequence.reserve',
      'sign',
    ]);
    expect(JSON.parse(new TextDecoder().decode(preview.bytes))).not.toHaveProperty('signature');
    expect(
      verify(
        null,
        preview.bytes,
        context.keys.publicKey,
        Buffer.from(preview.signature, 'base64url')
      )
    ).toBe(true);
    const admittedPreview = await admitDeviceControlFrame(
      preview.bytes,
      preview.signature,
      admissionAuthority(context.device, preview.issuerKeyId),
      (bytes, signature) =>
        verify(null, bytes, context.keys.publicKey, Buffer.from(signature, 'base64url'))
    );
    expect(admittedPreview.frame).toMatchObject({
      mode: 'bootstrap',
      target: 'preview',
      revision: 1,
      catalogGeneration: 1,
      confirmedAt: now,
    });
    expect(
      admittedPreview.frame.observations.map((item) => [item.subject.controlId, item.value])
    ).toEqual([
      ['alpha.visibility', 'inactive'],
      ['zulu.visibility', 'active'],
    ]);

    now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const program = await context.issuer.create('program');
    const admittedProgram = await admitDeviceControlFrame(
      program.bytes,
      program.signature,
      admissionAuthority(context.device, program.issuerKeyId, 1),
      (bytes, signature) =>
        verify(null, bytes, context.keys.publicKey, Buffer.from(signature, 'base64url'))
    );
    expect(admittedProgram.frame).toMatchObject({
      target: 'program',
      revision: 0,
      catalogGeneration: 1,
      addedActions: [],
      observations: [],
    });
    expect(createHash('sha256').update(program.bytes).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isolates target revisions while a catalog generation invalidates both targets', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    let now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const context = await harness({ production, now: () => now });
    const preview = await context.issuer.create('preview');
    const program = await context.issuer.create('program');

    production.executeVisibilityIntent(
      {
        kind: 'component.visibility',
        showId: 'show-1',
        target: 'preview',
        componentId: 'alpha',
        visible: true,
        operationId: 'visibility-1',
        expectedRevision: 1,
      },
      { directProgram: false }
    );
    context.issuer.observeCurrentProductionState();
    now += 1;
    expect(context.issuer.isCurrent(preview)).toBe(false);
    expect(context.issuer.isCurrent(program)).toBe(true);

    production.loadPreview('show-1', scene(['zulu']));
    const removed = context.issuer.observeCurrentProductionState();
    production.loadPreview('show-1', scene());
    const returned = context.issuer.observeCurrentProductionState();
    expect([removed.generation, returned.generation]).toEqual([2, 3]);
    expect(context.issuer.isCurrent(program)).toBe(false);

    now += 1;
    const currentProgram = await context.issuer.create('program');
    production.loadPreview('show-1', scene(['zulu', 'alpha', 'outsider']));
    const unrelated = context.issuer.observeCurrentProductionState();
    expect(unrelated.generation).toBe(3);
    expect(context.issuer.isCurrent(currentProgram)).toBe(true);
  });

  it('invalidates both targets on key rotation and uses the new issuer sequence lane', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    let now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const context = await harness({ production, now: () => now });
    const first = await context.issuer.create('preview');
    const rotatedKeys = generateKeyPairSync('ed25519');
    context.signing.rotate('server-key-2', rotatedKeys.privateKey);

    expect(context.issuer.isCurrent(first)).toBe(false);
    now += 1;
    const rotated = await context.issuer.create('preview');
    expect(rotated).toMatchObject({ issuerKeyId: 'server-key-2', sequence: 1 });
    expect(context.sequences.reservations).toEqual([
      { issuerKeyId: 'server-key-1', sequence: 1 },
      { issuerKeyId: 'server-key-2', sequence: 1 },
    ]);
    expect(
      verify(
        null,
        rotated.bytes,
        rotatedKeys.publicKey,
        Buffer.from(rotated.signature, 'base64url')
      )
    ).toBe(true);
  });

  it('burns a reserved sequence when state changes during signing or signing fails', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    let now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const context = await harness({ production, now: () => now });
    const gate = context.signing.gateNextSignature();
    const pending = context.issuer.create('preview');
    await gate.started;

    production.loadPreview('show-1', scene(['zulu']));
    context.issuer.observeCurrentProductionState();
    gate.release();
    const stale = await pending;
    expect(stale.sequence).toBe(1);
    expect(context.issuer.isCurrent(stale)).toBe(false);

    now += 1;
    const fresh = await context.issuer.create('preview');
    expect(fresh.sequence).toBe(2);
    context.signing.failNext = true;
    await expect(
      context.issuer.create('preview')
    ).rejects.toMatchObject<DeviceBootstrapSnapshotIssuerError>({
      code: 'DEVICE_BOOTSTRAP_SIGNING_FAILED',
    });
    const afterFailure = await context.issuer.create('preview');
    expect(afterFailure.sequence).toBe(4);
  });

  it('coalesces a catalog change during persistence before reserving a sequence', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    let now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const context = await harness({ production, now: () => now });
    const gate = context.catalogGenerations.gateNextConfirmation();
    const pending = context.issuer.create('preview');
    await gate.started;

    production.loadPreview('show-1', scene(['zulu']));
    now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const replacement = context.issuer.observeCurrentProductionState();
    expect(replacement.generation).toBe(2);
    gate.release();

    const snapshot = await pending;
    expect(snapshot.freshness.catalog.generation).toBe(2);
    expect(context.sequences.reservations).toEqual([{ issuerKeyId: 'server-key-1', sequence: 1 }]);
  });

  it('does not reserve or sign until catalog persistence recovers', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    const now = (production.getSnapshot('show-1', 'preview').updatedAt as number) + 1;
    const context = await harness({ production, now: () => now });
    context.catalogGenerations.failNextConfirmation = true;

    await expect(context.issuer.create('preview')).rejects.toMatchObject({
      code: 'CATALOG_GENERATION_STORE_IO',
    });
    expect(context.sequences.reservations).toEqual([]);
    expect(context.events.some((event) => event.startsWith('sign:'))).toBe(false);

    const recovered = await context.issuer.create('preview');
    expect(recovered.sequence).toBe(1);
    expect(context.catalogGenerations.isCurrent(recovered.freshness.catalog)).toBe(true);
  });

  it('expires old capture evidence and fails closed when the clock predates state', async () => {
    const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
    production.loadPreview('show-1', scene());
    const updatedAt = production.getSnapshot('show-1', 'preview').updatedAt as number;
    let now = updatedAt + 1;
    const context = await harness({ production, now: () => now });
    const snapshot = await context.issuer.create('preview');

    now = snapshot.freshness.confirmedAt + 2_999;
    expect(context.issuer.isCurrent(snapshot)).toBe(true);
    now += 1;
    expect(context.issuer.isCurrent(snapshot)).toBe(false);
    now = updatedAt - 1;
    await expect(context.issuer.create('preview')).rejects.toMatchObject({
      code: 'DEVICE_BOOTSTRAP_CLOCK_INVALID',
    });
  });
});
