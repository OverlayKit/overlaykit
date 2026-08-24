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
import { storage, type CollectionRecord, type ShowRecord } from '../../src/storage';
import { compiledFixture } from './support/outputProof';

/**
 * CHG-0050: prove the Studio production arc at the browser tier by reusing the CHG-0049 harness —
 * open a Show, load a saved Scene into Preview, and Take it to Program (AC-011, AC-012, and
 * REQ-NAV-002 / REQ-NAV-004: the rundown, monitors and Take on one Production surface).
 *
 * The Show and Scene are seeded into the shared storage the collections and production routers read,
 * and removed afterwards.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SHOW_ID = 'production-arc-show';
const SCENE_ID = 'production-arc-scene';
const SCENE_NAME = 'Opening Lower Third';
const OWNER = {
  displayName: 'Local Owner',
  email: 'owner@overlaykit.local',
  password: 'correct horse battery staple',
};

const show: ShowRecord = {
  id: SHOW_ID,
  name: 'Production Arc Show',
  description: 'CHG-0050 browser production arc',
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};

function seededCollection(): CollectionRecord {
  const fixture = compiledFixture('intent_production_arc', 'Rodrigo Vicente', 'Arquitecto');
  return {
    id: SCENE_ID,
    tenantId: DEFAULT_TENANT_ID,
    name: SCENE_NAME,
    channelId: SHOW_ID,
    scene: fixture.candidate.scene,
    variables: fixture.candidate.variables,
    updatedAt: 1,
  };
}

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

describe.sequential('Studio production arc (browser)', () => {
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
    await storage.saveCollection(seededCollection());
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

  it('opens a Show, loads a saved Scene into Preview, and Takes it to Program', async () => {
    // Bootstrap the owner (fresh instance) so Studio is authenticated.
    await page!.goto(`${origin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    // REQ-NAV-002: opening the seeded Show lands on its Production surface (the Open link is scoped
    // by href so leftover shows in shared storage cannot make the selector ambiguous).
    await page!.locator(`a[href$="/shows/${SHOW_ID}/production"]`).first().click();
    await page!.waitForURL(`**/shows/${SHOW_ID}/production`);
    await page!.getByRole('heading', { name: 'Production' }).waitFor({ state: 'visible' });

    // REQ-NAV-004: the rundown lists the saved Scene on the Production surface.
    const rundownItem = page!.getByRole('button', { name: new RegExp(SCENE_NAME) });
    await rundownItem.waitFor({ state: 'visible' });

    // AC-011: loading the Scene advances Preview to revision 1 while Program stays clear.
    await rundownItem.click();
    await page!.getByText('REV 1').waitFor({ state: 'visible' });

    // AC-012: Take promotes Preview to Program and acknowledges the promotion to the operator.
    await page!.getByRole('button', { name: /Take/ }).click();
    await page!.getByText('Last Take: Preview 1 to Program 1').waitFor({ state: 'visible' });
  }, 60_000);
});
