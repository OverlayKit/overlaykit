import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const proxyImage = 'caddy@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f';
export const ports = { rest: 40300, ws: 40301, studio: 18443, editor: 18444, output: 18445, panel: 18446, obs: 18447 };
export const origins = ['studio', 'editor', 'output', 'panel'].map(key => `https://localhost:${ports[key]}`);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function inventory(root) {
  const files = {};
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Release symlink refused: ${relative}`);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        if (relative !== 'release.json') files[relative] = { sha256: sha256(await readFile(file)), executable: Boolean(stat.mode & 0o111) };
      } else throw new Error(`Unsupported release entry: ${relative}`);
    }
  }
  await walk(root);
  return files;
}

export async function verify(root, expectedId = path.basename(root)) {
  const receipt = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'));
  if (receipt.schema !== 1 || receipt.id !== expectedId || receipt.id !== sha256(JSON.stringify(receipt.files))) throw new Error('Invalid release manifest');
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(receipt.files)) throw new Error('Release integrity mismatch');
  return receipt;
}

export function proxyConfiguration() {
  const global = '{\n admin off\n auto_https disable_redirects\n skip_install_trust\n default_bind 127.0.0.1\n}\n';
  function site(key, directory, http = false) {
    const address = http ? `http://127.0.0.1:${ports.obs}` : `https://localhost:${ports[key]}`;
    return `${address} {
 ${http ? '' : 'tls internal'}
 handle /ws { 
  reverse_proxy 127.0.0.1:${ports.ws}
 }
 ${key === 'studio' ? `handle /device {\n  reverse_proxy 127.0.0.1:${ports.ws}\n }\n handle /api/* {\n  reverse_proxy 127.0.0.1:${ports.rest}\n }\n handle /health {\n  reverse_proxy 127.0.0.1:${ports.rest}\n }` : 'handle /api/* {\n  respond 404\n }'}
 handle /sounds/* {
  reverse_proxy 127.0.0.1:${ports.rest}
 }
 handle {
  root * {env.OVERLAYKIT_RELEASE}/web/${directory}
  try_files {path} /index.html
  file_server
 }
}\n`;
  }
  return global + ['studio', 'editor', 'output', 'panel'].map(key => site(key, key)).join('\n') + site('obs', 'obs', true);
}

export function systemdQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid unit argument');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}
