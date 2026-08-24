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
import { DEFAULT_TENANT_ID } from '../../src/tenancy';
import { storage, type ShowRecord } from '../../src/storage';

/**
 * CHG-0056 / AC-006 (UI half): choosing New Scene on the Studio Scenes surface creates a new
 * independent Scene in the Show and opens it in the Editor. Reuses the CHG-0049 harness and the
 * Show-scoped create-Scene endpoint from CHG-0055.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SHOW_ID = `new-scene-show-${process.pid}`;
const SCENE_ID = `col-scene-1-col-${SHOW_ID}`;
const OWNER = {
  displayName: 'Local Owner',
  email: 'owner@overlaykit.local',
  password: 'correct horse battery staple',
};

const show: ShowRecord = {
  id: SHOW_ID,
  name: 'New Scene Show',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
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

describe.sequential('Studio New Scene creates and opens the Editor (browser)', () => {
  const auth = new AuthService(new MemoryAuthStore());
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let origin = '';
  let previousApiUrl: string | undefined;

  beforeAll(async () => {
    await auth.init();
    await storage.init();
    await storage.saveShow(show);
    await storage.deleteCollection(DEFAULT_TENANT_ID, SCENE_ID).catch(() => undefined);
    const production = new ProductionService(channelManager, { allowEphemeral: true });

    const serverPort = await reservePort();
    const vitePort = await reservePort();
    origin = `http://127.0.0.1:${vitePort}`;
    previousApiUrl = process.env.VITE_API_URL;
    process.env.VITE_API_URL = `http://127.0.0.1:${serverPort}`;

    vite = await createViteServer({
      root: path.join(repoRoot, 'studio'),
      configFile: path.join(repoRoot, 'studio', 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    });
    await vite.listen();

    config.corsOrigin.push(origin);
    restServer = createServer(createApp({ auth, dataStorage: storage, production }));
    await new Promise<void>((resolve, reject) => {
      restServer?.once('error', reject);
      restServer?.listen(serverPort, '127.0.0.1', resolve);
    });

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await vite?.close();
    await new Promise<void>((resolve) => restServer?.close(() => resolve()) ?? resolve());
    await storage.deleteCollection(DEFAULT_TENANT_ID, SCENE_ID).catch(() => undefined);
    await storage.archiveShow(SHOW_ID, 2).catch(() => undefined);
    const index = config.corsOrigin.indexOf(origin);
    if (index >= 0) config.corsOrigin.splice(index, 1);
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
  });

  it('creates a Scene in the Show and opens the Editor when New Scene is chosen', async () => {
    // Bootstrap the owner (fresh instance) so Studio is authenticated.
    await page!.goto(`${origin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    // Open the Show's Scenes surface (empty).
    await page!.goto(`${origin}/shows/${SHOW_ID}/scenes`, { waitUntil: 'networkidle' });
    await page!.getByRole('heading', { name: 'Scenes', exact: true }).waitFor({ state: 'visible' });

    // AC-006: choosing New Scene creates a Scene in the Show and opens it in the Editor.
    await page!.getByRole('button', { name: 'New scene' }).first().click();
    await page!.waitForURL(`**/shows/${SHOW_ID}/scenes/*/edit`);
    await page!.getByText('Edit scene').first().waitFor({ state: 'visible' });

    // The created Scene now appears on the Show's Scenes surface.
    await page!.goto(`${origin}/shows/${SHOW_ID}/scenes`, { waitUntil: 'networkidle' });
    await page!.getByText('Scene 1').first().waitFor({ state: 'visible' });
  }, 60_000);
});
