// @vitest-environment node

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
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
import {
  ORIGIN_OWNER,
  OTHER_SHOW_ID,
  SHOW_ID,
  TestStorage,
  VIEWPORT,
  authenticateOutput,
  closeCode,
  compiledFixture,
  nextMessage,
  openWebSocket,
  pixelMetrics,
  repoRoot,
  serverPort,
  waitForText,
} from './support/outputProof';

const execFileAsync = promisify(execFile);
const evidenceDir = path.resolve(
  repoRoot,
  process.env.OVERLAYKIT_OUTPUT_TRANSPORT_PROOF_DIR ?? 'artifacts/output-transport-proof'
);

async function createTlsMaterial(): Promise<{
  certificate: Buffer;
  directory: string;
  privateKey: Buffer;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-output-tls-'));
  const certificatePath = path.join(directory, 'certificate.pem');
  const privateKeyPath = path.join(directory, 'private-key.pem');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    privateKeyPath,
    '-out',
    certificatePath,
  ]);
  return {
    certificate: await readFile(certificatePath),
    directory,
    privateKey: await readFile(privateKeyPath),
  };
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
  let tlsDirectory = '';
  const pageRequestTargets: string[] = [];
  const upgradeRequestTargets: string[] = [];

  beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true });
    await auth.init();

    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wsServer?.once('listening', resolve);
      wsServer?.once('error', reject);
    });
    wsServer.on('connection', (_socket, incoming) => {
      upgradeRequestTargets.push(incoming.url ?? '');
    });
    originalWsUrl = process.env.VITE_WS_URL;
    delete process.env.VITE_WS_URL;

    const clientRoot = path.join(repoRoot, 'client');
    const tls = await createTlsMaterial();
    tlsDirectory = tls.directory;
    vite = await createViteServer({
      root: clientRoot,
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        https: { cert: tls.certificate, key: tls.privateKey },
        proxy: {
          '/ws': {
            target: `ws://127.0.0.1:${serverPort(wsServer)}`,
            ws: true,
          },
        },
      },
    });
    await vite.listen();
    vite.httpServer?.on('request', (incoming) => {
      pageRequestTargets.push(incoming.url ?? '');
    });
    origin = `https://127.0.0.1:${serverPort(vite)}`;
    config.corsOrigin.push(origin);
    setupWebSocketHandler(wsServer, auth, [origin], production);

    restServer = createServer(createApp({ auth, dataStorage: storage, production }));
    await new Promise<void>((resolve, reject) => {
      restServer?.once('error', reject);
      restServer?.listen(0, '127.0.0.1', resolve);
    });
    agent = request.agent(`http://127.0.0.1:${serverPort(restServer)}`);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--ignore-certificate-errors'],
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => restServer?.close(() => resolve()) ?? resolve());
    if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
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

    const wsUrl = `ws://127.0.0.1:${serverPort(wsServer!)}`;
    const crossShow = await openWebSocket(wsUrl, origin);
    await authenticateOutput(crossShow, token);
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
    await authenticateOutput(previewProbe, token);
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
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const receivedTypes: string[] = [];
    const browserWebSocketUrls: string[] = [];
    page.on('websocket', (socket) => {
      browserWebSocketUrls.push(socket.url());
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
    outputUrl.hash = new URLSearchParams({ output: token }).toString();
    await page.goto(outputUrl.toString(), { waitUntil: 'domcontentloaded' });
    await expect.poll(() => receivedTypes).toContain('production.subscription.confirmed');
    const authenticationIndex = receivedTypes.indexOf('authentication.confirmed');
    const subscriptionIndex = receivedTypes.indexOf('production.subscription.confirmed');
    expect(authenticationIndex).toBeGreaterThanOrEqual(0);
    expect(authenticationIndex).toBeLessThan(subscriptionIndex);
    const authenticationFramePrecedesSubscription =
      authenticationIndex >= 0 && authenticationIndex < subscriptionIndex;
    const outputWebSocketUrls = browserWebSocketUrls.filter(
      (url) => new URL(url).pathname === '/ws'
    );
    expect(outputWebSocketUrls).toEqual([`${origin.replace('https:', 'wss:')}/ws`]);
    expect(browserWebSocketUrls.some((url) => url.includes(token))).toBe(false);
    expect(pageRequestTargets.some((target) => target.includes(token))).toBe(false);
    expect(upgradeRequestTargets.some((target) => target.includes(token))).toBe(false);
    expect(upgradeRequestTargets).toContain('/ws');
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
      .send({ expectedPreviewRevision: 1, operationId: 'chg-0046-take-1' })
      .expect(200);
    expect(taken.body.data).toMatchObject({
      preview: { revision: 1 },
      program: { revision: 1, scene: { id: first.candidate.scene.id } },
      lastTake: { operationId: 'chg-0046-take-1', previewRevision: 1, programRevision: 1 },
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
    await authenticateOutput(retirementProbe, token);
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

    const rejectedOldToken = await openWebSocket(wsUrl, origin);
    const rejectedOldTokenClose = closeCode(rejectedOldToken);
    rejectedOldToken.send(
      JSON.stringify({
        type: 'authenticate.output',
        token,
      })
    );
    expect(await rejectedOldTokenClose).toBe(1008);

    const secondPreview = await agent
      .post(`/api/shows/${SHOW_ID}/production/preview`)
      .set('Origin', origin)
      .send({ scene: second.candidate.scene, variables: second.candidate.variables })
      .expect(200);
    expect(secondPreview.body.data.preview.revision).toBe(2);
    await agent
      .post(`/api/shows/${SHOW_ID}/production/take`)
      .set('Origin', origin)
      .send({ expectedPreviewRevision: 2, operationId: 'chg-0046-take-2' })
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
    currentUrl.hash = new URLSearchParams({
      output: replacement.body.data.token as string,
    }).toString();
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
      transport: {
        pageScheme: 'https:',
        webSocketScheme: 'wss:',
        sameOriginWebSocket: true,
        bearerInPageRequestTarget: false,
        bearerInUpgradeRequestTarget: false,
        upgradePath: '/ws',
        authenticationFramePrecedesSubscription,
      },
      firstTake: {
        operationId: 'chg-0046-take-1',
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
