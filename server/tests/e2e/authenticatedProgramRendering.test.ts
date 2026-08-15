// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveAnnouncePersonProgram } from '@overlaykit/visual-compiler';
import {
  compilationReceiptHash,
  type VisualContextFacts,
  type VisualIntent,
} from '@overlaykit/visual-protocol';
import {
  compileOverlayKitDomProgram,
  prepareOverlayKitPreviewCandidate,
  type OverlayKitDomProgramArtifact,
} from '@overlaykit/visual-target-overlaykit';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { config } from '../../src/config/environment';
import { setupWebSocketHandler } from '../../src/handlers/websocket';
import { createApp } from '../../src/index';
import { channelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import type {
  ActionRecord,
  CollectionMeta,
  CollectionRecord,
  ShowRecord,
  Storage,
} from '../../src/storage';

const VIEWPORT = { width: 1920, height: 1080 } as const;
const SHOW_ID = 'output-authority-show';
const OTHER_SHOW_ID = 'output-authority-other-show';
const ORIGIN_OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Local Owner',
  password: 'correct horse battery staple',
};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const evidenceDir = path.resolve(
  repoRoot,
  process.env.OVERLAYKIT_OUTPUT_PROOF_DIR ?? 'artifacts/output-authority-proof'
);

class TestStorage implements Storage {
  private readonly shows = new Map<string, ShowRecord>([
    [
      SHOW_ID,
      {
        id: SHOW_ID,
        name: 'Authorized Output',
        description: 'CHG-0045 proof Show',
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ],
    [
      OTHER_SHOW_ID,
      {
        id: OTHER_SHOW_ID,
        name: 'Other Output',
        description: 'Cross-Show denial target',
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ],
  ]);

  async init(): Promise<void> {}
  async listShows(includeArchived = false): Promise<ShowRecord[]> {
    return [...this.shows.values()].filter((show) => includeArchived || show.archivedAt === null);
  }
  async getShow(id: string): Promise<ShowRecord | null> {
    return this.shows.get(id) ?? null;
  }
  async saveShow(show: ShowRecord): Promise<ShowRecord> {
    this.shows.set(show.id, show);
    return show;
  }
  async archiveShow(id: string, archivedAt: number): Promise<ShowRecord | null> {
    const show = this.shows.get(id);
    if (!show) return null;
    const archived = { ...show, archivedAt, updatedAt: archivedAt };
    this.shows.set(id, archived);
    return archived;
  }
  async listCollections(_tenantId: string): Promise<CollectionMeta[]> {
    return [];
  }
  async getCollection(_tenantId: string, _id: string): Promise<CollectionRecord | null> {
    return null;
  }
  async saveCollection(record: CollectionRecord): Promise<CollectionRecord> {
    return record;
  }
  async deleteCollection(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
  async listActions(_tenantId: string): Promise<ActionRecord[]> {
    return [];
  }
  async getAction(_tenantId: string, _id: string): Promise<ActionRecord | null> {
    return null;
  }
  async saveAction(_record: ActionRecord): Promise<void> {}
  async deleteAction(_tenantId: string, _id: string): Promise<boolean> {
    return false;
  }
}

interface CompiledFixture {
  artifact: OverlayKitDomProgramArtifact;
  candidate: ReturnType<typeof prepareOverlayKitPreviewCandidate>;
  name: string;
  programId: string;
  role: string;
}

interface PixelMetrics {
  colorCount: number;
  opaquePixels: number;
  screenshotHash: string;
  totalPixels: number;
  transparentPixels: number;
  visiblePixels: number;
}

function visualContext(): VisualContextFacts {
  return {
    surface: 'broadcast.overlay',
    viewport: { ...VIEWPORT, pixelRatio: 1, transparent: true },
    temporalMode: 'live',
    interaction: 'operator',
    safeAreas: [{ x: 64, y: 64, width: 1792, height: 952 }],
    expectedDuration: 6_000,
    audienceDistance: 'medium',
    attentionBudget: 'medium',
    reducedMotion: true,
    capabilities: {
      dom: true,
      svg: true,
      canvas: false,
      cssAnimations: true,
      webAnimations: false,
      audio: false,
    },
  };
}

function compiledFixture(id: string, name: string, role: string): CompiledFixture {
  const intent: VisualIntent = {
    id,
    task: 'announce',
    subject: { type: 'person', name, role },
    desiredEffect: 'notice',
    importance: 'primary',
  };
  const program = resolveAnnouncePersonProgram({ intent, context: visualContext() });
  const artifact = compileOverlayKitDomProgram(program);
  return {
    artifact,
    candidate: prepareOverlayKitPreviewCandidate(artifact, {
      'person-name': name,
      'person-role': role,
    }),
    name,
    programId: program.id,
    role,
  };
}

function serverPort(server: Server | WebSocketServer | ViteDevServer): number {
  const address =
    server instanceof WebSocketServer
      ? server.address()
      : 'httpServer' in server
        ? server.httpServer?.address()
        : server.address();
  if (!address || typeof address === 'string') throw new Error('Proof server has no TCP port');
  return address.port;
}

function openWebSocket(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, [], { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>)
    );
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', resolve));
}

function pixelMetrics(buffer: Buffer): PixelMetrics {
  const png = PNG.sync.read(buffer);
  let opaquePixels = 0;
  let transparentPixels = 0;
  let visiblePixels = 0;
  const colors = new Set<number>();
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3];
    if (alpha === 0) transparentPixels += 1;
    if (alpha === 255) opaquePixels += 1;
    if (alpha > 0) {
      visiblePixels += 1;
      if (colors.size < 4096) {
        colors.add((png.data[index] << 16) | (png.data[index + 1] << 8) | png.data[index + 2]);
      }
    }
  }
  return {
    totalPixels: png.width * png.height,
    visiblePixels,
    opaquePixels,
    transparentPixels,
    colorCount: colors.size,
    screenshotHash: createHash('sha256').update(buffer).digest('hex'),
  };
}

async function waitForText(page: Page, fixture: CompiledFixture): Promise<void> {
  await page.locator(`#${fixture.programId}-name`).filter({ hasText: fixture.name }).waitFor({
    state: 'visible',
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
  });
}

describe.sequential('authenticated Program rendering proof', () => {
  const first = compiledFixture(
    'intent_output_authority_first',
    'Rodrigo Vicente',
    'Arquitecto de software'
  );
  const second = compiledFixture(
    'intent_output_authority_second',
    'Grace Hopper',
    'Pionera de software'
  );
  const auth = new AuthService(new MemoryAuthStore());
  const production = new ProductionService(channelManager, { allowEphemeral: true });
  const storage = new TestStorage();
  let agent: ReturnType<typeof request.agent>;
  let browser: Browser | undefined;
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let wsServer: WebSocketServer | undefined;
  let origin = '';
  let originalWsUrl: string | undefined;

  beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true });
    await auth.init();

    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wsServer?.once('listening', resolve);
      wsServer?.once('error', reject);
    });
    originalWsUrl = process.env.VITE_WS_URL;
    process.env.VITE_WS_URL = `ws://127.0.0.1:${serverPort(wsServer)}/ws`;

    const clientRoot = path.join(repoRoot, 'client');
    vite = await createViteServer({
      root: clientRoot,
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await vite.listen();
    origin = `http://127.0.0.1:${serverPort(vite)}`;
    config.corsOrigin.push(origin);
    setupWebSocketHandler(wsServer, auth, [origin], production);

    restServer = createServer(createApp({ auth, dataStorage: storage, production }));
    await new Promise<void>((resolve, reject) => {
      restServer?.once('error', reject);
      restServer?.listen(0, '127.0.0.1', resolve);
    });
    agent = request.agent(`http://127.0.0.1:${serverPort(restServer)}`);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => restServer?.close(() => resolve()) ?? resolve());
    const originIndex = config.corsOrigin.indexOf(origin);
    if (originIndex >= 0) config.corsOrigin.splice(originIndex, 1);
    if (originalWsUrl === undefined) delete process.env.VITE_WS_URL;
    else process.env.VITE_WS_URL = originalWsUrl;
  });

  it('publishes Take pixels only to the exact Show and retires the old URL', async () => {
    expect(browser).toBeDefined();
    expect(wsServer).toBeDefined();
    await agent.post('/api/auth/setup').set('Origin', origin).send(ORIGIN_OWNER).expect(201);

    const preview = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview`)
      .set('Origin', origin)
      .send({ scene: first.candidate.scene, variables: first.candidate.variables })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      preview: { revision: 1, scene: { id: first.candidate.scene.id } },
      program: { revision: 0, scene: null, elements: [] },
    });

    const issued = await agent
      .post('/api/auth/output-token')
      .set('Origin', origin)
      .send({ showId: SHOW_ID })
      .expect(201);
    const token = issued.body.data.token as string;
    expect(issued.body.data).toMatchObject({ showId: SHOW_ID });

    const wsUrl = `ws://127.0.0.1:${serverPort(wsServer!)}?token=${encodeURIComponent(token)}`;
    const crossShow = await openWebSocket(wsUrl, origin);
    const crossShowMessage = nextMessage(crossShow);
    crossShow.send(
      JSON.stringify({
        type: 'subscribe.production',
        showId: OTHER_SHOW_ID,
        bus: 'program',
      })
    );
    expect(await crossShowMessage).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    crossShow.close();

    const previewProbe = await openWebSocket(wsUrl, origin);
    const previewMessage = nextMessage(previewProbe);
    previewProbe.send(
      JSON.stringify({
        type: 'subscribe.production',
        showId: SHOW_ID,
        bus: 'preview',
      })
    );
    expect(await previewMessage).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    previewProbe.close();

    const context = await browser!.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const receivedTypes: string[] = [];
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(String(payload)) as { type?: string };
          if (message.type) receivedTypes.push(message.type);
        } catch {
          // Binary or non-JSON frames are irrelevant to the production contract.
        }
      });
    });
    const outputUrl = new URL(`${origin}/production`);
    outputUrl.searchParams.set('show', SHOW_ID);
    outputUrl.searchParams.set('bus', 'program');
    outputUrl.searchParams.set('transparent', 'true');
    outputUrl.searchParams.set('hideStatus', 'true');
    outputUrl.searchParams.set('hideWatermark', 'true');
    outputUrl.searchParams.set('token', token);
    await page.goto(outputUrl.toString(), { waitUntil: 'domcontentloaded' });
    await expect.poll(() => receivedTypes).toContain('production.subscription.confirmed');
    expect(await page.locator('.elements-container').locator(':scope > *').count()).toBe(0);

    const beforeBuffer = await page.screenshot({
      path: path.join(evidenceDir, 'program-before-take.png'),
      omitBackground: true,
    });
    const beforePixels = pixelMetrics(beforeBuffer);
    expect(beforePixels.visiblePixels).toBe(0);

    const taken = await agent
      .post(`/api/shows/${SHOW_ID}/production/take`)
      .set('Origin', origin)
      .send({ expectedPreviewRevision: 1, operationId: 'chg-0045-take-1' })
      .expect(200);
    expect(taken.body.data).toMatchObject({
      preview: { revision: 1 },
      program: { revision: 1, scene: { id: first.candidate.scene.id } },
      lastTake: { operationId: 'chg-0045-take-1', previewRevision: 1, programRevision: 1 },
    });
    await waitForText(page, first);
    expect(await page.locator(`#${first.programId}-role`).textContent()).toBe(first.role);

    const afterBuffer = await page.screenshot({
      path: path.join(evidenceDir, 'program-after-take.png'),
      omitBackground: true,
    });
    const afterPixels = pixelMetrics(afterBuffer);
    expect(afterPixels.visiblePixels).toBeGreaterThan(20_000);
    expect(afterPixels.transparentPixels / afterPixels.totalPixels).toBeGreaterThan(0.8);
    expect(afterPixels.colorCount).toBeGreaterThan(20);

    const retirementProbe = await openWebSocket(wsUrl, origin);
    const retirementSubscription = nextMessage(retirementProbe);
    retirementProbe.send(
      JSON.stringify({
        type: 'subscribe.production',
        showId: SHOW_ID,
        bus: 'program',
      })
    );
    expect(await retirementSubscription).toMatchObject({
      type: 'production.subscription.confirmed',
      showId: SHOW_ID,
      bus: 'program',
    });
    const retiredClose = closeCode(retirementProbe);
    const replacement = await agent
      .post('/api/auth/output-token')
      .set('Origin', origin)
      .send({ showId: SHOW_ID })
      .expect(201);
    expect(await retiredClose).toBe(1008);

    const rejectedOldToken = new WebSocket(wsUrl, [], { origin });
    expect(await closeCode(rejectedOldToken)).toBe(1008);

    const secondPreview = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview`)
      .set('Origin', origin)
      .send({ scene: second.candidate.scene, variables: second.candidate.variables })
      .expect(200);
    expect(secondPreview.body.data.preview.revision).toBe(2);
    await agent
      .post(`/api/shows/${SHOW_ID}/production/take`)
      .set('Origin', origin)
      .send({ expectedPreviewRevision: 2, operationId: 'chg-0045-take-2' })
      .expect(200);
    await page.waitForTimeout(2_500);
    expect(await page.locator(`#${first.programId}-name`).textContent()).toBe(first.name);
    expect(await page.getByText(second.name, { exact: true }).count()).toBe(0);

    const currentPage = await context.newPage();
    const currentUrl = new URL(`${origin}/production`);
    currentUrl.searchParams.set('show', SHOW_ID);
    currentUrl.searchParams.set('bus', 'program');
    currentUrl.searchParams.set('transparent', 'true');
    currentUrl.searchParams.set('hideStatus', 'true');
    currentUrl.searchParams.set('hideWatermark', 'true');
    currentUrl.searchParams.set('token', replacement.body.data.token as string);
    await currentPage.goto(currentUrl.toString(), { waitUntil: 'domcontentloaded' });
    await waitForText(currentPage, second);

    const report = {
      browserVersion: browser!.version(),
      renderer: 'client/ProductionView.vue + shared/ElementRenderer.vue',
      authority: {
        showId: SHOW_ID,
        crossShowProgramDenied: true,
        previewDenied: true,
        retiredConnectionCloseCode: 1008,
        oldTokenReconnectDenied: true,
        retiredClientReceivedSecondProgram: false,
      },
      firstTake: {
        operationId: 'chg-0045-take-1',
        previewRevision: 1,
        programRevisionBefore: 0,
        programRevisionAfter: 1,
        programHash: first.artifact.programHash,
        bundleHash: first.artifact.bundle.bundleHash,
        receiptHash: compilationReceiptHash(first.artifact.manifest),
      },
      screenshots: {
        beforeTake: { file: 'program-before-take.png', pixels: beforePixels },
        afterTake: { file: 'program-after-take.png', pixels: afterPixels },
      },
      secondTakeVisibleOnlyWithReplacementCredential: true,
      viewport: VIEWPORT,
    };
    await writeFile(
      path.join(evidenceDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
    await context.close();
  }, 30_000);
});
