// Destructive fixture operations are restricted to a new private temporary directory.
// Never pass the installed production data directory to this probe.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomBytes, X509Certificate } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { origins, verify, sha256 } from './runtime.mjs';

const release = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || 'artifacts/local-production-2026-10-23');
await verify(release);
await mkdir(output, { recursive: true });
const work = await mkdtemp(path.join(output, 'probe-'));
await import('node:fs/promises').then(fs => fs.chmod(work, 0o700));
for (const name of ['server', 'proxy-data', 'proxy-config', 'home/.pki/nssdb']) await mkdir(path.join(work, name), { recursive: true, mode: 0o700 });
let server, proxy, context, outputPage, socket;
const record = { schema: 1, releaseId: (await verify(release)).id, fixtureOnly: true, status: 'running' };
const log = createWriteStream(path.join(work, 'server.log'), { mode: 0o600 });
async function waitFor(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch { /* bounded readiness */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Readiness failed: ${label}`);
}
function startServer() {
  server = spawn(path.join(release, 'bin/node'), [path.join(release, 'server/dist/index.js')], { cwd: work, env: { PATH: process.env.PATH, HOME: path.join(work, 'home'), NODE_ENV: 'production', HOST: '127.0.0.1', WS_HOST: '127.0.0.1', REST_PORT: '40300', WS_PORT: '40301', COOKIE_SECURE: 'always', TRUST_PROXY: '1', CORS_ORIGIN: [...origins, 'http://127.0.0.1:18447'].join(','), DATA_DIR: path.join(work, 'server'), LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
}
async function stopServer() {
  if (server && server.exitCode === null) {
    const exit = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture server stop timed out')), 10000).unref())]);
  }
}
let ca;
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { ca, ...options }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout')));
    req.end(options.body);
  });
}
try {
  for (const port of [40300, 40301, 18443, 18444, 18445, 18446, 18447]) {
    const net = await import('node:net');
    await new Promise((resolve, reject) => { const listener = net.createServer(); listener.once('error', reject); listener.listen(port, '127.0.0.1', () => listener.close(resolve)); });
  }
  startServer();
  await waitFor(async () => (await request('http://127.0.0.1:40300/health')).status === 200, 'server');
  proxy = spawn(path.join(release, 'bin/caddy'), ['run', '--config', path.join(release, 'Caddyfile'), '--adapter', 'caddyfile'], { env: { PATH: process.env.PATH, HOME: path.join(work, 'home'), OVERLAYKIT_RELEASE: release, XDG_DATA_HOME: path.join(work, 'proxy-data'), XDG_CONFIG_HOME: path.join(work, 'proxy-config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const proxyLog = createWriteStream(path.join(work, 'proxy.log'), { mode: 0o600 });
  proxy.stdout.pipe(proxyLog);
  proxy.stderr.pipe(proxyLog);
  ca = await waitFor(() => readFile(path.join(work, 'proxy-data/caddy/pki/authorities/local/root.crt')), 'local CA');
  await waitFor(async () => (await request(`${origins[0]}/health`)).status === 200, 'verified HTTPS');
  record.caFingerprint256 = new X509Certificate(ca).fingerprint256;
  execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${work}/home/.pki/nssdb`], { stdio: 'pipe' });
  execFileSync('certutil', ['-A', '-n', 'OverlayKit isolated fixture CA', '-t', 'C,,', '-i', path.join(work, 'proxy-data/caddy/pki/authorities/local/root.crt'), '-d', `sql:${work}/home/.pki/nssdb`], { stdio: 'pipe' });
  context = await chromium.launchPersistentContext(path.join(work, 'chrome'), { channel: 'chrome', headless: true, env: { ...process.env, HOME: path.join(work, 'home') } });
  const page = context.pages()[0];
  await page.goto(`${origins[0]}/shows`);
  await page.waitForURL('**/setup');
  await page.getByRole('heading', { name: 'Create the owner account' }).waitFor();
  const owner = { displayName: 'Isolated deployment probe', email: `probe-${process.pid}@overlaykit.local`, password: randomBytes(24).toString('base64url') };
  await page.getByLabel('Name', { exact: true }).fill(owner.displayName);
  await page.getByLabel('Email', { exact: true }).fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Create owner', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/shows');
  await page.getByRole('heading', { name: 'Shows', exact: true }).waitFor();
  const cookies = await context.cookies();
  assert.ok(cookies.some(cookie => cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict'));
  let cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
  async function api(route, body) {
    const result = await request(`${origins[0]}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origins[0], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok(result.status < 400, `API ${route} returned ${result.status}`);
    return JSON.parse(result.body).data;
  }
  const show = await api('/shows', { name: 'Isolated deployment persistence', description: 'Disposable deployment probe' });
  const trustBefore = await api('/integrations/device-trust');
  const productionBefore = await api(`/shows/${show.id}/production`);
  const deniedSetup = await request(`${origins[0]}/api/auth/setup`, { method: 'POST', headers: { Origin: origins[0], 'Content-Type': 'application/json' }, body: JSON.stringify(owner) });
  assert.equal(deniedSetup.status, 409);
  const deniedOrigin = await request(`${origins[0]}/api/shows`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'denied' }) });
  assert.equal(deniedOrigin.status, 403);
  const outputCredential = await api('/auth/output-token', { showId: show.id });
  outputPage = await context.newPage();
  const wire = { firstFrameType: null, authenticated: false, targetsContainCredential: false };
  outputPage.on('request', req => { if (req.url().includes(outputCredential.token)) wire.targetsContainCredential = true; });
  outputPage.on('websocket', ws => {
    ws.on('framesent', frame => { if (!wire.firstFrameType) { try { wire.firstFrameType = JSON.parse(String(frame.payload)).type; } catch { wire.firstFrameType = 'invalid'; } } });
    ws.on('framereceived', frame => { try { const message = JSON.parse(String(frame.payload)); if (message.type === 'authentication.confirmed' && message.access === 'output') wire.authenticated = true; } catch { /* no payload retained */ } });
  });
  await outputPage.goto(`${origins[2]}/production?show=${encodeURIComponent(show.id)}&bus=program#output=${encodeURIComponent(outputCredential.token)}`);
  await waitFor(() => wire.authenticated, 'Output authentication');
  assert.equal(wire.firstFrameType, 'authenticate.output');
  assert.equal(wire.targetsContainCredential, false);
  assert.equal((await request('http://127.0.0.1:18447/api/auth/status')).status, 404);
  socket = new WebSocket('wss://localhost:18445/ws', { ca, origin: origins[2] });
  await once(socket, 'open');
  let next = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'authenticate.output', token: outputCredential.token }));
  assert.equal(JSON.parse(String((await next)[0])).access, 'output');
  next = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'scene_activate', sceneId: 'forbidden-fixture' }));
  assert.equal(JSON.parse(String((await next)[0])).code, 'FORBIDDEN');
  socket.close();
  await outputPage.close();
  outputPage = null;
  await stopServer();
  startServer();
  await waitFor(async () => (await request(`${origins[0]}/health`)).status === 200, 'restart');
  const priorSession = await request(`${origins[0]}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(priorSession.status, 401);
  await page.reload();
  await page.waitForURL('**/login**');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/shows');
  await page.getByRole('heading', { name: 'Shows', exact: true }).waitFor();
  cookie = (await context.cookies()).map(item => `${item.name}=${item.value}`).join('; ');
  assert.deepEqual(await api('/integrations/device-trust'), trustBefore);
  assert.deepEqual(await api(`/shows/${show.id}/production`), productionBefore);
  assert.equal((await api(`/shows/${show.id}`)).name, show.name);
  await page.reload();
  await page.getByRole('heading', { name: 'Shows', exact: true }).waitFor();
  await page.screenshot({ path: path.join(work, 'studio.png') });
  Object.assign(record, { status: 'passed', protectedBrowserSetup: true, secureHttpOnlyStrictCookie: true, setupClosed: true, untrustedOriginRejected: true, sessionInvalidatedOnRestart: true, ownerCanSignInAfterRestart: true, showSurvivedRestart: true, initialProductionStateSurvivedRestart: true, signingTrustSha256: sha256(JSON.stringify(trustBefore)), signingTrustSurvivedRestart: true, output: { ...wire, readOnlyMutationRejected: true, httpAliasApiDenied: true }, boundary: 'Isolated fixture; no real Owner, Show, Companion cutover, OBS operation or OS reboot acceptance.' });
} catch (error) {
  record.status = 'failed';
  record.failure = error.code || error.name;
  throw error;
} finally {
  socket?.terminate();
  await context?.close();
  await stopServer();
  if (proxy && proxy.exitCode === null) { const exit = once(proxy, 'exit'); proxy.kill('SIGTERM'); await exit; }
  log.end();
  await writeFile(path.join(work, 'receipt.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  console.log(path.join(work, 'receipt.json'));
}
