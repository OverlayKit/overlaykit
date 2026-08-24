// @vitest-environment node

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { config } from '../../src/config/environment';
import { createApp } from '../../src/index';
import { createDeviceCredentialRuntime } from '../../src/auth/DeviceCredentialRuntime';
import { SqliteDeviceCredentialStore } from '../../src/auth/SqliteDeviceCredentialStore';
import { createDeviceCredentialCryptoOptions } from '../../src/auth/DeviceCredentialCrypto';
import { TestStorage } from './support/outputProof';

/**
 * CHG-0061 / AC-016 (UI half): the owner issues a scoped device token for a Show through the Studio
 * Integrations surface, and the token is shown exactly once.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER = { displayName: 'Local Owner', email: 'owner@overlaykit.local', password: 'correct horse battery staple' };

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

describe.sequential('Studio Integrations issues a scoped device token (browser)', () => {
  let restServer: Server | undefined;
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let store: SqliteDeviceCredentialStore | undefined;
  let dbDir = '';
  let origin = '';
  let previousApiUrl: string | undefined;

  beforeAll(async () => {
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const storage = new TestStorage();
    dbDir = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-devcred-'));
    let entropy = 0;
    store = new SqliteDeviceCredentialStore({ databasePath: path.join(dbDir, 'devcred.sqlite') });
    const deviceCredentials = await createDeviceCredentialRuntime({
      store,
      lifecycleOptions: createDeviceCredentialCryptoOptions({
        now: () => 1_000,
        primitives: {
          randomUUID: () => 'device-1',
          randomBytes: (size: number) => new Uint8Array(size).fill(++entropy),
        },
      }),
    });

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
    restServer = createServer(createApp({ auth, dataStorage: storage, deviceCredentials }));
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
    store?.close?.();
    if (dbDir) await rm(dbDir, { recursive: true, force: true });
    const index = config.corsOrigin.indexOf(origin);
    if (index >= 0) config.corsOrigin.splice(index, 1);
    if (previousApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previousApiUrl;
  });

  it('issues a device token for the selected Show and shows it once', async () => {
    await page!.goto(`${origin}/shows`, { waitUntil: 'networkidle' });
    await page!.waitForURL('**/setup');
    await page!.getByLabel('Name').fill(OWNER.displayName);
    await page!.getByLabel('Email').fill(OWNER.email);
    await page!.getByLabel('Password').fill(OWNER.password);
    await page!.getByRole('button', { name: 'Create owner' }).click();
    await page!.waitForURL('**/shows');

    await page!.goto(`${origin}/settings/integrations`, { waitUntil: 'networkidle' });
    await page!.getByRole('heading', { name: 'Integrations', exact: true }).waitFor({ state: 'visible' });

    // AC-016: issue a scoped device token; it is shown once.
    await page!.getByRole('button', { name: 'Issue device token' }).click();
    const token = page!.getByTestId('device-token');
    await token.waitFor({ state: 'visible', timeout: 12000 });
    await page!.getByText('SHOWN ONCE').first().waitFor({ state: 'visible' });
    const value = (await token.textContent()) ?? '';
    if (!/^ok_device_/.test(value)) {
      throw new Error(`expected a device token, got: ${value.slice(0, 40)}`);
    }
  }, 60_000);
});
