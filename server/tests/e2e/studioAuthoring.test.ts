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
import { TestStorage } from './support/outputProof';

/**
 * CHG-0051: prove AC-005 at the browser tier — creating a Show opens it on its Production surface.
 * Reuses the CHG-0049 Studio browser harness.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SHOW_NAME = 'Autotest Broadcast';
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

describe.sequential('Studio authoring: open a Show on create (browser)', () => {
  const auth = new AuthService(new MemoryAuthStore());
  const storage = new TestStorage();
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let origin = '';
  let previousApiUrl: string | undefined;

  beforeAll(async () => {
    await auth.init();
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
    const index = config.corsOrigin.indexOf(origin);
    if (index >= 0) config.corsOrigin.splice(index, 1);
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
  });

  it('opens the new Show on its Production surface after create', async () => {
    // Bootstrap the owner (fresh instance) so Studio is authenticated.
    await page!.goto(`${origin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    // AC-005: create a Show with valid metadata, then OverlayKit opens it on Production.
    await page!.getByRole('button', { name: 'New show' }).click();
    await page!.getByLabel('Name').fill(SHOW_NAME);
    await page!.getByRole('button', { name: 'Create show' }).click();

    await page!.waitForURL('**/shows/*/production');
    await page!.getByRole('heading', { name: 'Production' }).waitFor({ state: 'visible' });
    // The opened Show is the one just created (its name appears in the workspace breadcrumb).
    await page!.getByText(SHOW_NAME).first().waitFor({ state: 'visible' });
  }, 60_000);
});
