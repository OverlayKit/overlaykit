import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apacheLicenseHash = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const author = {
  name: 'Rodrigo Vicente',
  url: 'https://x.com/rodrigoteamx',
};
const notice = [
  'OverlayKit',
  'Copyright 2026 Rodrigo Vicente',
  '',
  'OverlayKit was created by Rodrigo Vicente (@rodrigoteamx).',
  'https://x.com/rodrigoteamx',
  '',
].join('\n');
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

async function text(root, relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyLicensing(root = defaultRoot) {
  for (const packageRoot of packageRoots) {
    const relativePath = path.join(packageRoot, 'package.json');
    const manifest = JSON.parse(await text(root, relativePath));
    assert(manifest.license === 'Apache-2.0', `${relativePath} must declare Apache-2.0`);
    assert(
      JSON.stringify(manifest.author) === JSON.stringify(author),
      `${relativePath} must attribute Rodrigo Vicente`,
    );
  }

  for (const distributionRoot of distributionRoots) {
    const licensePath = path.join(distributionRoot, 'LICENSE');
    const license = await text(root, licensePath);
    const digest = createHash('sha256').update(license).digest('hex');
    assert(digest === apacheLicenseHash, `${licensePath} must match the official Apache-2.0 text`);

    const noticePath = path.join(distributionRoot, 'NOTICE');
    assert(await text(root, noticePath) === notice, `${noticePath} must preserve canonical attribution`);

    if (distributionRoot) {
      const manifest = JSON.parse(await text(root, path.join(distributionRoot, 'package.json')));
      assert(manifest.files.includes('LICENSE'), `${distributionRoot} must pack LICENSE`);
      assert(manifest.files.includes('NOTICE'), `${distributionRoot} must pack NOTICE`);
    }
  }

  const lockfile = JSON.parse(await text(root, 'package-lock.json'));
  for (const packageRoot of packageRoots) {
    assert(
      lockfile.packages?.[packageRoot]?.license === 'Apache-2.0',
      `package-lock.json entry ${packageRoot || '<root>'} must declare Apache-2.0`,
    );
  }

  for (const surface of [
    'README.md',
    'protocol/README.md',
    'shared/README.md',
    'shared/ui/README.md',
    'landing/index.html',
  ]) {
    const contents = await text(root, surface);
    assert(!/\bMIT(?:-licensed| Licensed| open source)?\b/i.test(contents), `${surface} still claims MIT`);
    assert(contents.includes('Apache-2.0') || contents.includes('Apache License 2.0'), `${surface} omits Apache-2.0`);
    assert(contents.includes('https://x.com/rodrigoteamx'), `${surface} omits Rodrigo Vicente attribution`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyLicensing();
  console.log(`licensing ok Apache-2.0 ${apacheLicenseHash}`);
}
