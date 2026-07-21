import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyLicensing } from './verify-licensing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoots = [
  '',
  'client',
  'editor',
  'landing',
  'panel',
  'protocol',
  'server',
  'shared',
  'shared/ui',
  'studio',
  'tools/governance',
];
const distributionRoots = ['', 'protocol', 'shared', 'shared/ui'];
const surfacePaths = [
  'README.md',
  'protocol/README.md',
  'shared/README.md',
  'shared/ui/README.md',
  'landing/index.html',
];
const fixturePaths = new Set([
  ...packageRoots.map((packageRoot) => path.join(packageRoot, 'package.json')),
  ...distributionRoots.flatMap((packageRoot) => [
    path.join(packageRoot, 'LICENSE'),
    path.join(packageRoot, 'NOTICE'),
  ]),
  ...surfacePaths,
  'package-lock.json',
]);
const temporaryDirectories = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'overlaykit-licensing-'));
  temporaryDirectories.push(directory);
  for (const relativePath of fixturePaths) {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relativePath), target);
  }
  return directory;
}

async function mutateJson(directory, relativePath, mutate) {
  const target = path.join(directory, relativePath);
  const value = JSON.parse(await readFile(target, 'utf8'));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('licensing verifier', () => {
  it('accepts the repository licensing contract', async () => {
    await assert.doesNotReject(verifyLicensing(root));
  });

  const hostileCases = [
    {
      name: 'modified license bytes',
      expected: /official Apache-2.0 text/,
      mutate: async (directory) => {
        await writeFile(path.join(directory, 'shared/ui/LICENSE'), 'Apache-ish\n', 'utf8');
      },
    },
    {
      name: 'modified attribution',
      expected: /canonical attribution/,
      mutate: async (directory) => {
        await writeFile(path.join(directory, 'protocol/NOTICE'), 'OverlayKit\n', 'utf8');
      },
    },
    {
      name: 'MIT workspace metadata',
      expected: /landing\/package.json must declare Apache-2.0/,
      mutate: (directory) => mutateJson(directory, 'landing/package.json', (value) => {
        value.license = 'MIT';
      }),
    },
    {
      name: 'stale lockfile metadata',
      expected: /package-lock.json entry protocol must declare Apache-2.0/,
      mutate: (directory) => mutateJson(directory, 'package-lock.json', (value) => {
        value.packages.protocol.license = 'MIT';
      }),
    },
    {
      name: 'missing package NOTICE allowlist',
      expected: /shared\/ui must pack NOTICE/,
      mutate: (directory) => mutateJson(directory, 'shared/ui/package.json', (value) => {
        value.files = value.files.filter((file) => file !== 'NOTICE');
      }),
    },
    {
      name: 'public MIT claim',
      expected: /landing\/index.html still claims MIT/,
      mutate: async (directory) => {
        const target = path.join(directory, 'landing/index.html');
        const contents = await readFile(target, 'utf8');
        await writeFile(target, contents.replace('Apache-2.0 open source', 'MIT open source'), 'utf8');
      },
    },
  ];

  for (const hostile of hostileCases) {
    it(`fails closed for ${hostile.name}`, async () => {
      const directory = await fixture();
      await hostile.mutate(directory);
      await assert.rejects(verifyLicensing(directory), hostile.expected);
    });
  }
});
