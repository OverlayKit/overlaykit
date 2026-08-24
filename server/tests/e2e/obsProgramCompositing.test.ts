// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { WebSocketServer } from 'ws';
import { compilationReceiptHash } from '@overlaykit/visual-protocol';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { config } from '../../src/config/environment';
import { setupWebSocketHandler } from '../../src/handlers/websocket';
import { createApp } from '../../src/index';
import { channelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import { ObsUnavailableError, ObsWebSocketClient } from './support/obsWebSocket';
import {
  ORIGIN_OWNER,
  SHOW_ID,
  TestStorage,
  VIEWPORT,
  compiledFixture,
  observeConnections,
  pixelMetrics,
  repoRoot,
  serverPort,
  type ObservedConnection,
  type PixelMetrics,
} from './support/outputProof';

/**
 * CHG-0047 real-consumer acceptance proof (ADR-0038).
 *
 * The proof ATTACHES to an operator-run OBS Studio through obs-websocket; it never launches,
 * reconfigures or switches the operator's Program scene. It creates one dedicated scene and one
 * browser_source input, observes the real server-side connection that OBS's embedded browser
 * opens, captures OBS's own render of that source before and after Take, drives an OBS-initiated
 * refresh, retires the credential and removes everything it created.
 *
 * Without a reachable, authenticated obs-websocket endpoint the whole file skips loudly and writes
 * no evidence. Set OVERLAYKIT_REQUIRE_OBS=1 to fail instead of skipping.
 */

const OBS_WEBSOCKET_URL = process.env.OVERLAYKIT_OBS_WEBSOCKET_URL ?? 'ws://127.0.0.1:4455';
const OBS_WEBSOCKET_PASSWORD = process.env.OVERLAYKIT_OBS_WEBSOCKET_PASSWORD;
const REQUIRE_OBS = process.env.OVERLAYKIT_REQUIRE_OBS === '1';
const evidenceDir = path.resolve(
  repoRoot,
  process.env.OVERLAYKIT_OBS_PROOF_DIR ?? 'artifacts/obs-acceptance-proof'
);
const PROOF_ID = `overlaykit-chg-0047-${process.pid}-${Date.now().toString(36)}`;
const SCENE_NAME = `${PROOF_ID}-scene`;
const INPUT_NAME = `${PROOF_ID}-output`;
const OBS_USER_AGENT = /\bOBS\/\d/;
const MIN_VISIBLE_PIXELS = 20_000;
const MIN_TRANSPARENT_RATIO = 0.8;
const MIN_COLORS = 20;

interface ObsProbe {
  client: ObsWebSocketClient | null;
  reason: string | null;
}

async function probeObs(): Promise<ObsProbe> {
  try {
    const client = await ObsWebSocketClient.connect({
      url: OBS_WEBSOCKET_URL,
      password: OBS_WEBSOCKET_PASSWORD,
      connectTimeoutMs: 3_000,
    });
    return { client, reason: null };
  } catch (error) {
    if (error instanceof ObsUnavailableError) {
      return { client: null, reason: `${error.reason}: ${error.message}` };
    }
    throw error;
  }
}

const probe = await probeObs();
if (!probe.client) {
  const message =
    `[obs-acceptance] obs-websocket is not usable at ${OBS_WEBSOCKET_URL} ` +
    `(${probe.reason}); no evidence was written`;
  if (REQUIRE_OBS) throw new Error(`${message}; OVERLAYKIT_REQUIRE_OBS=1 requires OBS`);
  process.stderr.write(`${message}; skipping the real OBS proof\n`);
}

const SUITE_TITLE = probe.client
  ? 'real OBS Program compositing proof'
  : `real OBS Program compositing proof (skipped: ${probe.reason})`;

interface Capture {
  buffer: Buffer;
  pixels: PixelMetrics;
}

interface RetainedScreenshot {
  file: string;
  pixels: PixelMetrics;
}

describe.skipIf(!probe.client).sequential(SUITE_TITLE, () => {
  const obs = probe.client!;
  const fixture = compiledFixture(
    'intent_obs_acceptance',
    'Rodrigo Vicente',
    'Arquitecto de software'
  );
  const auth = new AuthService(new MemoryAuthStore());
  const production = new ProductionService(channelManager, { allowEphemeral: true });
  const storage = new TestStorage();
  const pageRequestTargets: string[] = [];
  let agent: ReturnType<typeof request.agent>;
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let wsServer: WebSocketServer | undefined;
  let observed: ObservedConnection[] = [];
  let origin = '';
  let originalWsUrl: string | undefined;
  let sceneCreated = false;
  let inputCreated = false;
  let previousProgramScene: string | null = null;
  let environment: Record<string, unknown> = {};

  const obsConnections = (): ObservedConnection[] =>
    observed.filter((connection) => OBS_USER_AGENT.test(connection.userAgent));

  async function screenshot(sourceName: string): Promise<Buffer> {
    const { imageData } = await obs.request<{ imageData: string }>('GetSourceScreenshot', {
      sourceName,
      imageFormat: 'png',
      imageWidth: VIEWPORT.width,
      imageHeight: VIEWPORT.height,
    });
    const prefix = 'data:image/png;base64,';
    expect(imageData.startsWith(prefix)).toBe(true);
    return Buffer.from(imageData.slice(prefix.length), 'base64');
  }

  async function settledScreenshot(
    sourceName: string,
    accept: (pixels: PixelMetrics) => boolean,
    timeoutMs = 45_000
  ): Promise<Capture> {
    const deadline = Date.now() + timeoutMs;
    let previous: PixelMetrics | null = null;
    let last: PixelMetrics | null = null;
    while (Date.now() < deadline) {
      const buffer = await screenshot(sourceName);
      const pixels = pixelMetrics(buffer);
      // Settle on a stable visible-pixel count, not the raw PNG hash: OBS leaves the RGB channels
      // under fully transparent pixels non-deterministic, so two all-transparent frames differ
      // byte-for-byte while representing the same render.
      if (
        accept(pixels) &&
        previous !== null &&
        previous.visiblePixels === pixels.visiblePixels &&
        previous.colorCount === pixels.colorCount
      ) {
        return { buffer, pixels };
      }
      previous = accept(pixels) ? pixels : null;
      last = pixels;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `${sourceName} did not settle within ${timeoutMs}ms; last metrics ${JSON.stringify(last)}`
    );
  }

  async function retain(file: string, capture: Capture): Promise<RetainedScreenshot> {
    await writeFile(path.join(evidenceDir, file), capture.buffer);
    return { file, pixels: capture.pixels };
  }

  function frameOrder(connection: ObservedConnection): {
    authenticationIndex: number;
    subscriptionIndex: number;
    authenticationPrecedesSubscription: boolean;
  } {
    const authenticationIndex = connection.sentTypes.indexOf('authentication.confirmed');
    const subscriptionIndex = connection.sentTypes.indexOf('production.subscription.confirmed');
    return {
      authenticationIndex,
      subscriptionIndex,
      authenticationPrecedesSubscription:
        authenticationIndex >= 0 && authenticationIndex < subscriptionIndex,
    };
  }

  beforeAll(async () => {
    const stream = await obs.request<{ outputActive: boolean }>('GetStreamStatus');
    const record = await obs.request<{ outputActive: boolean }>('GetRecordStatus');
    if (stream.outputActive || record.outputActive) {
      throw new Error(
        'Refusing to run the OBS acceptance proof while OBS is streaming or recording'
      );
    }
    const version = await obs.request<{
      obsVersion: string;
      obsWebSocketVersion: string;
      platform: string;
      platformDescription: string;
      rpcVersion: number;
      supportedImageFormats: string[];
    }>('GetVersion');
    expect(version.supportedImageFormats).toContain('png');
    const video = await obs.request<Record<string, unknown>>('GetVideoSettings');
    environment = {
      obsVersion: version.obsVersion,
      obsWebSocketVersion: version.obsWebSocketVersion,
      rpcVersion: version.rpcVersion,
      platform: version.platform,
      platformDescription: version.platformDescription,
      videoSettings: video,
    };

    await mkdir(evidenceDir, { recursive: true });
    await auth.init();

    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wsServer?.once('listening', resolve);
      wsServer?.once('error', reject);
    });
    observed = observeConnections(wsServer);
    originalWsUrl = process.env.VITE_WS_URL;
    delete process.env.VITE_WS_URL;

    const clientRoot = path.join(repoRoot, 'client');
    vite = await createViteServer({
      root: clientRoot,
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        proxy: {
          '/ws': {
            target: `ws://127.0.0.1:${serverPort(wsServer)}`,
            ws: true,
          },
        },
      },
    });
    await vite.listen();
    // prependListener so the true request line is captured before Vite's history-fallback
    // middleware rewrites req.url to /index.html.
    vite.httpServer?.prependListener('request', (incoming) => {
      pageRequestTargets.push(incoming.url ?? '');
    });
    origin = `http://127.0.0.1:${serverPort(vite)}`;
    config.corsOrigin.push(origin);
    setupWebSocketHandler(wsServer, auth, [origin], production);

    restServer = createServer(createApp({ auth, dataStorage: storage, production }));
    await new Promise<void>((resolve, reject) => {
      restServer?.once('error', reject);
      restServer?.listen(0, '127.0.0.1', resolve);
    });
    agent = request.agent(`http://127.0.0.1:${serverPort(restServer)}`);
  }, 30_000);

  afterAll(async () => {
    if (previousProgramScene) {
      await obs
        .request('SetCurrentProgramScene', { sceneName: previousProgramScene })
        .catch(() => undefined);
    }
    if (inputCreated) {
      await obs.request('RemoveInput', { inputName: INPUT_NAME }).catch(() => undefined);
    }
    if (sceneCreated) {
      await obs.request('RemoveScene', { sceneName: SCENE_NAME }).catch(() => undefined);
    }
    await obs.close();
    await vite?.close();
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => restServer?.close(() => resolve()) ?? resolve());
    const originIndex = config.corsOrigin.indexOf(origin);
    if (originIndex >= 0) config.corsOrigin.splice(originIndex, 1);
    if (originalWsUrl === undefined) delete process.env.VITE_WS_URL;
    else process.env.VITE_WS_URL = originalWsUrl;
  });

  it('loads, authenticates, composites, refreshes and retires the Program in a real OBS browser source', async () => {
    expect(wsServer).toBeDefined();
    await agent.post('/api/auth/setup').set('Origin', origin).send(ORIGIN_OWNER).expect(201);

    const preview = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview`)
      .set('Origin', origin)
      .send({ scene: fixture.candidate.scene, variables: fixture.candidate.variables })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      preview: { revision: 1, scene: { id: fixture.candidate.scene.id } },
      program: { revision: 0, scene: null, elements: [] },
    });

    const issued = await agent
      .post('/api/auth/output-token')
      .set('Origin', origin)
      .send({ showId: SHOW_ID })
      .expect(201);
    const token = issued.body.data.token as string;
    expect(issued.body.data).toMatchObject({ showId: SHOW_ID });

    const outputUrl = new URL(`${origin}/production`);
    outputUrl.searchParams.set('show', SHOW_ID);
    outputUrl.searchParams.set('bus', 'program');
    outputUrl.searchParams.set('transparent', 'true');
    outputUrl.searchParams.set('hideStatus', 'true');
    outputUrl.searchParams.set('hideWatermark', 'true');
    outputUrl.hash = new URLSearchParams({ output: token }).toString();

    const currentScene = await obs.request<{ currentProgramSceneName: string }>(
      'GetCurrentProgramScene'
    );
    previousProgramScene = currentScene.currentProgramSceneName;
    await obs.request('CreateScene', { sceneName: SCENE_NAME });
    sceneCreated = true;
    await obs.request('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: INPUT_NAME,
      inputKind: 'browser_source',
      inputSettings: {
        url: outputUrl.toString(),
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        shutdown: false,
        restart_when_active: false,
        fps_custom: false,
        reroute_audio: false,
      },
      sceneItemEnabled: true,
    });
    inputCreated = true;
    // Make the proof scene the active Program scene so OBS ticks and repaints the browser source
    // (an inactive source throttles its embedded page's script and rendering). OBS is idle here —
    // the beforeAll refused to run while streaming or recording — and the previous scene is
    // restored in afterAll.
    await obs.request('SetCurrentProgramScene', { sceneName: SCENE_NAME });

    // 1. OBS's embedded browser reaches the real handler and authenticates before subscribing.
    await expect
      .poll(() => obsConnections().length, { timeout: 45_000, interval: 250 })
      .toBeGreaterThan(0);
    const initial = obsConnections()[0];
    await expect
      .poll(() => initial.sentTypes, { timeout: 45_000, interval: 250 })
      .toContain('production.subscription.confirmed');
    const initialOrder = frameOrder(initial);
    expect(initial.upgradeTarget).toBe('/ws');
    expect(initial.origin).toBe(origin);
    expect(initial.receivedTypes[0]).toBe('authenticate.output');
    expect(initialOrder.authenticationIndex).toBeGreaterThanOrEqual(0);
    expect(initialOrder.authenticationIndex).toBeLessThan(initialOrder.subscriptionIndex);
    const bearerInUpgradeRequestTarget = observed.some((connection) =>
      connection.upgradeTarget.includes(token)
    );
    const bearerInPageRequestTarget = pageRequestTargets.some((target) => target.includes(token));
    expect(bearerInUpgradeRequestTarget).toBe(false);
    expect(bearerInPageRequestTarget).toBe(false);
    // OBS could only present this exact fragment credential by loading the fragment-bearing page;
    // the authenticated connection above is itself proof the Output page was fetched and executed.
    // The document request line still names /production and, being before the fragment, carries no
    // bearer.
    const documentRequest = pageRequestTargets.find((target) => target.startsWith('/production'));
    expect(documentRequest).toBeDefined();
    expect(documentRequest).not.toContain(token);

    // 2. Before Take OBS renders the source fully transparent.
    const before = await settledScreenshot(INPUT_NAME, (pixels) => pixels.visiblePixels === 0);
    expect(before.pixels.transparentPixels).toBe(before.pixels.totalPixels);
    const beforeTake = await retain('program-before-take.png', before);

    // 3. Take publishes the exact compiled Program into OBS's own render of the source and scene.
    const taken = await agent
      .post(`/api/shows/${SHOW_ID}/production/take`)
      .set('Origin', origin)
      .send({ expectedPreviewRevision: 1, operationId: 'chg-0047-take-1' })
      .expect(200);
    expect(taken.body.data).toMatchObject({
      preview: { revision: 1 },
      program: { revision: 1, scene: { id: fixture.candidate.scene.id } },
      lastTake: { operationId: 'chg-0047-take-1', previewRevision: 1, programRevision: 1 },
    });
    const after = await settledScreenshot(
      INPUT_NAME,
      (pixels) => pixels.visiblePixels > MIN_VISIBLE_PIXELS
    );
    expect(after.pixels.transparentPixels / after.pixels.totalPixels).toBeGreaterThan(
      MIN_TRANSPARENT_RATIO
    );
    expect(after.pixels.colorCount).toBeGreaterThan(MIN_COLORS);
    const afterTake = await retain('program-after-take.png', after);
    const composited = await settledScreenshot(
      SCENE_NAME,
      (pixels) => pixels.visiblePixels > MIN_VISIBLE_PIXELS
    );
    expect(composited.pixels.transparentPixels / composited.pixels.totalPixels).toBeGreaterThan(
      MIN_TRANSPARENT_RATIO
    );
    const sceneAfterTake = await retain('scene-after-take.png', composited);

    // 4. An OBS-initiated refresh re-authenticates with the page-held credential before it
    //    subscribes again, and the Program re-presents.
    const connectionsBeforeRefresh = obsConnections().length;
    await obs.request('PressInputPropertiesButton', {
      inputName: INPUT_NAME,
      propertyName: 'refreshnocache',
    });
    await expect
      .poll(() => obsConnections().length, { timeout: 45_000, interval: 250 })
      .toBeGreaterThan(connectionsBeforeRefresh);
    const refreshed = obsConnections()[obsConnections().length - 1];
    await expect
      .poll(() => refreshed.sentTypes, { timeout: 45_000, interval: 250 })
      .toContain('production.subscription.confirmed');
    const refreshedOrder = frameOrder(refreshed);
    expect(refreshed.receivedTypes[0]).toBe('authenticate.output');
    expect(refreshedOrder.authenticationPrecedesSubscription).toBe(true);
    await expect.poll(() => initial.closeCode, { timeout: 15_000 }).not.toBeNull();
    const afterRefreshCapture = await settledScreenshot(
      INPUT_NAME,
      (pixels) => pixels.visiblePixels > MIN_VISIBLE_PIXELS
    );
    const afterRefresh = await retain('program-after-refresh.png', afterRefreshCapture);

    // 5. Rotation retires the established OBS connection and denies its reconnect with the old
    //    credential that the browser source still holds.
    const rotated = await agent
      .post('/api/auth/output-token')
      .set('Origin', origin)
      .send({ showId: SHOW_ID })
      .expect(201);
    expect(rotated.body.data.token).not.toBe(token);
    await expect.poll(() => refreshed.closeCode, { timeout: 15_000 }).toBe(1008);
    const refreshedIndex = obsConnections().indexOf(refreshed);
    const deniedReconnect = (): ObservedConnection | undefined =>
      obsConnections()
        .slice(refreshedIndex + 1)
        .find(
          (connection) =>
            connection.closeCode === 1008 &&
            connection.receivedTypes[0] === 'authenticate.output' &&
            !connection.sentTypes.includes('authentication.confirmed')
        );
    await expect.poll(() => deniedReconnect() !== undefined, { timeout: 30_000 }).toBe(true);

    const report = {
      evidenceClass: 'local-review-sample',
      ciReproducible: false,
      consumer: 'OBS Studio browser_source via obs-websocket',
      observer: 'obs-websocket GetSourceScreenshot',
      environment: {
        ...environment,
        browserSourceUserAgent: initial.userAgent,
      },
      renderer: 'client/ProductionView.vue + shared/ElementRenderer.vue',
      authority: {
        showId: SHOW_ID,
        retiredConnectionCloseCode: refreshed.closeCode,
        oldCredentialReconnectDenied: deniedReconnect() !== undefined,
      },
      transport: {
        pageScheme: 'http:',
        webSocketScheme: 'ws:',
        upgradePath: initial.upgradeTarget,
        upgradeOriginMatchesPage: initial.origin === origin,
        bearerInPageRequestTarget,
        bearerInUpgradeRequestTarget,
        firstApplicationFrame: initial.receivedTypes[0],
        authenticationConfirmedBeforeSubscription: initialOrder.authenticationPrecedesSubscription,
      },
      refresh: {
        mechanism: 'PressInputPropertiesButton refreshnocache',
        newConnectionFirstApplicationFrame: refreshed.receivedTypes[0],
        newConnectionAuthenticatedBeforeSubscription:
          refreshedOrder.authenticationPrecedesSubscription,
        previousConnectionClosed: initial.closeCode !== null,
      },
      firstTake: {
        operationId: 'chg-0047-take-1',
        previewRevision: 1,
        programRevisionBefore: 0,
        programRevisionAfter: 1,
        programHash: fixture.artifact.programHash,
        bundleHash: fixture.artifact.bundle.bundleHash,
        receiptHash: compilationReceiptHash(fixture.artifact.manifest),
      },
      screenshots: {
        beforeTake,
        afterTake,
        sceneAfterTake,
        afterRefresh,
      },
      viewport: VIEWPORT,
    };
    await writeFile(
      path.join(evidenceDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
  }, 240_000);
});
