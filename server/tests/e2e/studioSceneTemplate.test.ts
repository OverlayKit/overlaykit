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
 * CHG-0058 / AC-006 (Template branch): choosing a Template on the Studio Scenes surface creates a
 * new Scene pre-populated from that Template (not blank) and opens it in the Editor.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SHOW_ID = `template-show-${process.pid}`;
const OWNER = {
  displayName: 'Local Owner',
  email: 'owner@overlaykit.local',
  password: 'correct horse battery staple',
};

const show: ShowRecord = {
  id: SHOW_ID,
  name: 'Template Show',
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

describe.sequential('Studio New Scene from a Template (browser)', () => {
  const auth = new AuthService(new MemoryAuthStore());
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let origin = '';
  let previousApiUrl: string | undefined;
  const createdIds: string[] = [];

  beforeAll(async () => {
    await auth.init();
    await storage.init();
    await storage.saveShow(show);
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
    for (const meta of (await storage.listCollections(DEFAULT_TENANT_ID)).filter(
      (c) => c.channelId === SHOW_ID
    )) {
      await storage.deleteCollection(DEFAULT_TENANT_ID, meta.id).catch(() => undefined);
    }
    await storage.archiveShow(SHOW_ID, 2).catch(() => undefined);
    const index = config.corsOrigin.indexOf(origin);
    if (index >= 0) config.corsOrigin.splice(index, 1);
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
    void createdIds;
  });

  it('creates a Scene from the Lower Third Template and opens the Editor', async () => {
    await page!.goto(`${origin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    await page!.goto(`${origin}/shows/${SHOW_ID}/scenes`, { waitUntil: 'networkidle' });
    await page!.getByRole('heading', { name: 'Scenes', exact: true }).waitFor({ state: 'visible' });

    // AC-006 Template branch: open the New Scene chooser and pick a Template.
    await page!.getByRole('button', { name: 'New scene' }).first().click();
    await page!.getByRole('button', { name: 'Lower Third' }).first().click();

    // The Scene opens in the Editor.
    await page!.waitForURL(`**/shows/${SHOW_ID}/scenes/*/edit`);
    await page!.getByText('Edit scene').first().waitFor({ state: 'visible' });

    // Back on the Scenes surface, the created Scene carries the Template's elements (not blank).
    await page!.goto(`${origin}/shows/${SHOW_ID}/scenes`, { waitUntil: 'networkidle' });
    await page!.getByText('3 elements').first().waitFor({ state: 'visible' });
  }, 60_000);
});
