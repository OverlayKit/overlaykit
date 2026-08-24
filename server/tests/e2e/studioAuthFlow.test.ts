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
 * CHG-0049 / ADR-0040: a browser harness that drives the real Studio SPA against the real server,
 * proving the first-run and authentication route guards SPEC-0001 demands at the E2E tier
 * (AC-001 first-run bootstrap and guarded routes, AC-003 sign-in and redirect, REQ-SEC-001).
 *
 * The Studio app is served by Vite; its API base points at the real server on the same loopback
 * host so the SameSite=Strict session cookie is carried across ports, and the page origin is
 * allow-listed for credentialed CORS.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER = {
  displayName: 'Local Owner',
  email: 'owner@overlaykit.local',
  password: 'correct horse battery staple',
};

// Reserve a free loopback port up front so the page origin can be allow-listed before createApp
// snapshots the origin allowlist (enforceBrowserOrigin builds a Set at construction time).
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

describe.sequential('Studio authentication flow (browser)', () => {
  const auth = new AuthService(new MemoryAuthStore());
  const storage = new TestStorage();
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let origin = '';
  let previousApiUrl: string | undefined;

  async function goto(pathname: string): Promise<void> {
    await page!.goto(`${origin}${pathname}`, { waitUntil: 'networkidle' });
  }

  beforeAll(async () => {
    await auth.init();
    const production = new ProductionService(channelManager, { allowEphemeral: true });

    // Reserve both ports so the wiring is deterministic: the Studio page origin must be allow-listed
    // before createApp, and the Studio bundle must point at the real server before Vite bakes env.
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

    // Allow-list the page origin BEFORE createApp so the mutation Origin check accepts it.
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

  it('guards a fresh instance to owner setup, then bootstraps, closes setup, and gates sign-in', async () => {
    // AC-001 / REQ-SEC-001: a fresh instance restricts any Studio route to owner setup.
    await goto('/shows');
    await page!.waitForURL('**/setup');
    await page!
      .getByRole('heading', { name: 'Create the owner account' })
      .waitFor({ state: 'visible' });

    // Bootstrap the owner through the real Studio form and the real server.
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();

    // Setup logs the owner in and lands on the Shows workspace.
    await page!.waitForURL('**/shows');
    await page!.getByRole('heading', { name: 'Shows' }).waitFor({ state: 'visible' });

    // AC-002 at the route tier: setup is closed; visiting /setup while authenticated returns to Shows.
    await goto('/setup');
    await page!.waitForURL('**/shows');

    // Sign out, then a protected route is gated to sign-in (REQ-SEC-001 route guard).
    await page!.getByRole('button', { name: 'Sign out' }).click();
    await page!.waitForURL('**/login**');
    await goto('/shows');
    await page!.waitForURL('**/login**');
    await page!.getByRole('heading', { name: 'Sign in to Studio' }).waitFor({ state: 'visible' });

    // AC-003: valid owner credentials create a session and redirect to Shows.
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Sign in' }).click();
    await page!.waitForURL('**/shows');
    await page!.getByRole('heading', { name: 'Shows' }).waitFor({ state: 'visible' });
  }, 60_000);
});
