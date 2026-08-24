// @vitest-environment node

import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { config } from '../../src/config/environment';
import { createApp } from '../../src/index';
import { channelManager } from '../../src/services/ChannelManager';
import { ProductionService } from '../../src/services/ProductionService';
import { SHOW_ID, TestStorage } from './support/outputProof';

/**
 * CHG-0052: prove AC-008 (Editor Send to Preview) at the browser tier — the embedded Editor sends a
 * scene to the Show's Preview, and Program stays clear. This requires making the Studio EditorView
 * iframe URL env-driven (VITE_EDITOR_URL) so the harness can serve the real editor/ app on a second
 * loopback origin; the CHG-0049 harness pattern is reused and a second Vite server is added.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER = {
  displayName: 'Local Owner',
  email: 'owner@overlaykit.local',
  password: 'correct horse battery staple',
};

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('reservePort: no port'));
        return;
      }
      const reserved = address.port;
      probe.close(() => resolve(reserved));
    });
  });
}

describe.sequential('Studio editor authoring: Send to Preview (browser)', () => {
  const auth = new AuthService(new MemoryAuthStore());
  const storage = new TestStorage();
  let restServer: Server | undefined;
  let studioVite: ViteDevServer | undefined;
  let editorVite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let studioOrigin = '';
  let editorOrigin = '';
  let previousApiUrl: string | undefined;
  let previousEditorUrl: string | undefined;

  beforeAll(async () => {
    await auth.init();
    const production = new ProductionService(channelManager, { allowEphemeral: true });

    const serverPort = await reservePort();
    const studioPort = await reservePort();
    const editorPort = await reservePort();
    studioOrigin = `http://127.0.0.1:${studioPort}`;
    editorOrigin = `http://127.0.0.1:${editorPort}`;

    previousApiUrl = process.env.VITE_API_URL;
    previousEditorUrl = process.env.VITE_EDITOR_URL;
    process.env.VITE_API_URL = `http://127.0.0.1:${serverPort}`;
    process.env.VITE_EDITOR_URL = editorOrigin;

    studioVite = await createViteServer({
      root: path.join(repoRoot, 'studio'),
      configFile: path.join(repoRoot, 'studio', 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: studioPort, strictPort: true },
    });
    await studioVite.listen();

    editorVite = await createViteServer({
      root: path.join(repoRoot, 'editor'),
      configFile: path.join(repoRoot, 'editor', 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: editorPort, strictPort: true },
    });
    await editorVite.listen();

    config.corsOrigin.push(studioOrigin, editorOrigin);
    restServer = createServer(createApp({ auth, dataStorage: storage, production }));
    await new Promise<void>((resolve, reject) => {
      restServer?.once('error', reject);
      restServer?.listen(serverPort, '127.0.0.1', resolve);
    });

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await editorVite?.close();
    await studioVite?.close();
    await new Promise<void>((resolve) => restServer?.close(() => resolve()) ?? resolve());
    for (const origin of [studioOrigin, editorOrigin]) {
      const index = config.corsOrigin.indexOf(origin);
      if (index >= 0) config.corsOrigin.splice(index, 1);
    }
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
    if (previousEditorUrl === undefined) delete process.env.VITE_EDITOR_URL;
    else process.env.VITE_EDITOR_URL = previousEditorUrl;
  });

  it('sends a scene from the embedded Editor to the Show Preview, leaving Program clear', async () => {
    // Bootstrap the owner (fresh instance) so Studio is authenticated.
    await page!.goto(`${studioOrigin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    // Open the embedded Editor for a new scene in the seeded Show.
    await page!.goto(`${studioOrigin}/shows/${SHOW_ID}/new-scene`, { waitUntil: 'networkidle' });
    await page!.getByText('New scene').first().waitFor({ state: 'visible' });

    // The Editor is served on its own origin via VITE_EDITOR_URL and embedded as an iframe.
    // The Editor is served on its own origin via VITE_EDITOR_URL and embedded as a cross-origin
    // iframe; Playwright drives it through a frame locator.
    const editor = page!.frameLocator('iframe[title="Scene editor"]');
    const sendButton = editor.getByRole('button', { name: 'Enviar a Preview' });
    await sendButton.waitFor({ state: 'visible', timeout: 45_000 });

    // AC-008: Send to Preview delivers a runtime snapshot to Preview.
    await sendButton.click();
    await editor.getByText('Enviado a Preview').waitFor({ state: 'visible', timeout: 30_000 });

    // Server-observable through the same ProductionService: Preview advanced, Program stayed clear.
    await page!.goto(`${studioOrigin}/shows/${SHOW_ID}/production`, { waitUntil: 'networkidle' });
    await page!.getByRole('heading', { name: 'Production' }).waitFor({ state: 'visible' });
    await page!.getByText('REV 1').waitFor({ state: 'visible' });
    await page!.getByText('Clear output').waitFor({ state: 'visible' });
  }, 90_000);
});
