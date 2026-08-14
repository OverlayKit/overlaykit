// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { PNG } from 'pngjs';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { WebSocketServer } from 'ws';
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
import { ChannelManager } from '../../src/services/ChannelManager';
import { ProductionService, type ProductionSnapshot } from '../../src/services/ProductionService';

const VIEWPORT = { width: 1920, height: 1080 } as const;
const SAFE_AREA = { x: 64, y: 64, width: 1792, height: 952 } as const;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const evidenceDir = path.resolve(
  repoRoot,
  process.env.OVERLAYKIT_VISUAL_PROOF_DIR ?? 'artifacts/visual-proof'
);

const intent: VisualIntent = {
  id: 'intent_announce_rodrigo',
  task: 'announce',
  subject: {
    type: 'person',
    name: 'Rodrigo Vicente',
    role: 'Arquitecto de software',
  },
  desiredEffect: 'notice',
  importance: 'primary',
};

interface ProofFixture {
  readonly artifact: OverlayKitDomProgramArtifact;
  readonly programId: string;
  readonly showId: string;
  readonly snapshot: ProductionSnapshot;
  readonly surface: VisualContextFacts['surface'];
}

interface RectMetrics {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly text: string;
  readonly top: number;
  readonly width: number;
}

interface PixelMetrics {
  readonly colorCount: number;
  readonly height: number;
  readonly opaquePixels: number;
  readonly screenshotHash: string;
  readonly totalPixels: number;
  readonly transparentPixels: number;
  readonly visiblePixels: number;
  readonly width: number;
}

function context(surface: VisualContextFacts['surface']): VisualContextFacts {
  return {
    surface,
    viewport: { ...VIEWPORT, pixelRatio: 1, transparent: surface === 'broadcast.overlay' },
    temporalMode: surface === 'broadcast.overlay' ? 'live' : 'presenter-paced',
    interaction: surface === 'broadcast.overlay' ? 'operator' : 'presenter',
    safeAreas: [SAFE_AREA],
    ...(surface === 'broadcast.overlay' ? { expectedDuration: 6_000 } : {}),
    audienceDistance: surface === 'broadcast.overlay' ? 'medium' : 'near',
    attentionBudget: 'medium',
    reducedMotion: false,
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

function fixture(
  production: ProductionService,
  surface: VisualContextFacts['surface']
): ProofFixture {
  const program = resolveAnnouncePersonProgram({ intent, context: context(surface) });
  const artifact = compileOverlayKitDomProgram(program);
  const candidate = prepareOverlayKitPreviewCandidate(artifact, {
    'person-name': intent.subject.name,
    'person-role': intent.subject.role,
  });
  const showId = `visual-proof-${surface.replace('.', '-')}`;
  production.loadPreview(showId, candidate.scene, candidate.variables);

  return {
    artifact,
    programId: program.id,
    showId,
    snapshot: production.getSnapshot(showId, 'preview'),
    surface,
  };
}

function serverPort(server: WebSocketServer | ViteDevServer): number {
  const address =
    server instanceof WebSocketServer ? server.address() : server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Visual proof server did not expose a TCP port');
  }
  return address.port;
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
    width: png.width,
    height: png.height,
    totalPixels: png.width * png.height,
    visiblePixels,
    opaquePixels,
    transparentPixels,
    colorCount: colors.size,
    screenshotHash: createHash('sha256').update(buffer).digest('hex'),
  };
}

function expectInsideSafeArea(rect: RectMetrics): void {
  expect(rect.left).toBeGreaterThanOrEqual(SAFE_AREA.x);
  expect(rect.top).toBeGreaterThanOrEqual(SAFE_AREA.y);
  expect(rect.right).toBeLessThanOrEqual(SAFE_AREA.x + SAFE_AREA.width);
  expect(rect.bottom).toBeLessThanOrEqual(SAFE_AREA.y + SAFE_AREA.height);
}

describe.sequential('compiled Preview rendering proof', () => {
  const production = new ProductionService(new ChannelManager(), { allowEphemeral: true });
  const fixtures = [
    fixture(production, 'broadcast.overlay'),
    fixture(production, 'presentation.slide'),
  ];
  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let wsServer: WebSocketServer | undefined;
  let originalWsUrl: string | undefined;

  beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true });
    wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      wsServer?.once('listening', resolve);
      wsServer?.once('error', reject);
    });
    const snapshots = new Map(fixtures.map((entry) => [entry.showId, entry.snapshot]));
    wsServer.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          showId?: string;
          bus?: string;
        };
        if (message.type !== 'subscribe.production' || message.bus !== 'preview') return;
        const snapshot = message.showId ? snapshots.get(message.showId) : undefined;
        if (!snapshot) return;
        socket.send(
          JSON.stringify({
            type: 'production.subscription.confirmed',
            showId: message.showId,
            bus: 'preview',
            snapshot,
          })
        );
      });
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
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    if (originalWsUrl === undefined) delete process.env.VITE_WS_URL;
    else process.env.VITE_WS_URL = originalWsUrl;
  });

  it('renders both admitted surfaces as bounded, nonblank browser pixels', async () => {
    expect(browser).toBeDefined();
    expect(vite).toBeDefined();
    const report: {
      browserVersion: string;
      renderer: string;
      surfaces: Array<Record<string, unknown>>;
      viewport: typeof VIEWPORT;
    } = {
      browserVersion: browser?.version() ?? 'unknown',
      renderer: 'client/ProductionView.vue + shared/ElementRenderer.vue',
      viewport: VIEWPORT,
      surfaces: [],
    };

    for (const entry of fixtures) {
      expect(production.getSnapshot(entry.showId, 'program')).toMatchObject({
        revision: 0,
        scene: null,
        elements: [],
      });
      const browserContext = await browser!.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      const page = await browserContext.newPage();
      const url = new URL(`http://127.0.0.1:${serverPort(vite!)}/production`);
      url.searchParams.set('show', entry.showId);
      url.searchParams.set('bus', 'preview');
      url.searchParams.set('transparent', 'true');
      url.searchParams.set('hideStatus', 'true');
      url.searchParams.set('hideWatermark', 'true');
      const nameId = `${entry.programId}-name`;
      const roleId = `${entry.programId}-role`;

      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await page.locator(`#${nameId}`).waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map((animation) => animation.finished));
      });

      const dom = await page.evaluate(
        ({ criticalIds }) => {
          const metrics = (id: string): RectMetrics => {
            const element = document.getElementById(id);
            if (!element) throw new Error(`Missing critical element ${id}`);
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              text: element.textContent?.trim() ?? '',
            };
          };
          const stage = document.querySelector('.stage')?.getBoundingClientRect();
          if (!stage) throw new Error('Missing production stage');
          return {
            bodyText: document.body.textContent ?? '',
            hasVisiblePlaceholder: (document.body.textContent ?? '').includes('{{'),
            name: metrics(criticalIds.name),
            role: metrics(criticalIds.role),
            stage: {
              left: stage.left,
              top: stage.top,
              width: stage.width,
              height: stage.height,
            },
          };
        },
        { criticalIds: { name: nameId, role: roleId } }
      );

      expect(dom.bodyText).toContain(intent.subject.name);
      expect(dom.bodyText).toContain(intent.subject.role);
      expect(dom.hasVisiblePlaceholder).toBe(false);
      expect(dom.name.text).toBe(intent.subject.name);
      expect(dom.role.text).toBe(intent.subject.role);
      expect(dom.stage).toEqual({ left: 0, top: 0, ...VIEWPORT });
      expectInsideSafeArea(dom.name);
      expectInsideSafeArea(dom.role);

      const fileName = `${entry.surface.replace('.', '-')}.png`;
      const screenshot = await page.screenshot({
        path: path.join(evidenceDir, fileName),
        omitBackground: true,
      });
      const pixels = pixelMetrics(screenshot);
      expect(pixels).toMatchObject(VIEWPORT);
      expect(pixels.visiblePixels).toBeGreaterThan(20_000);
      expect(pixels.colorCount).toBeGreaterThan(20);
      if (entry.surface === 'broadcast.overlay') {
        expect(pixels.transparentPixels / pixels.totalPixels).toBeGreaterThan(0.8);
        expect(pixels.visiblePixels / pixels.totalPixels).toBeLessThan(0.2);
      } else {
        expect(pixels.opaquePixels / pixels.totalPixels).toBeGreaterThan(0.98);
      }

      report.surfaces.push({
        surface: entry.surface,
        showId: entry.showId,
        programHash: entry.artifact.programHash,
        bundleHash: entry.artifact.bundle.bundleHash,
        receiptHash: compilationReceiptHash(entry.artifact.manifest),
        previewRevision: entry.snapshot.revision,
        programRevision: production.getSnapshot(entry.showId, 'program').revision,
        safeArea: SAFE_AREA,
        criticalText: { name: dom.name, role: dom.role },
        stage: dom.stage,
        screenshot: fileName,
        pixels,
      });
      await browserContext.close();
    }

    await writeFile(
      path.join(evidenceDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
  }, 30_000);
});
