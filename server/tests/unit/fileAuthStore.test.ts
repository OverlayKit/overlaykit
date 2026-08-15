import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAuthStore } from '../../src/auth/FileAuthStore';
import { LEGACY_LOCAL_AUTH_SCHEMA_VERSION, LOCAL_AUTH_SCHEMA_VERSION } from '../../src/auth/types';

describe('FileAuthStore', () => {
  it('preserves the owner and revokes an unscoped legacy Output token', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'overlaykit-auth-migration-'));
    const filePath = path.join(directory, 'auth.json');
    const owner = {
      id: 'owner-1',
      email: 'owner@overlaykit.local',
      displayName: 'Local Owner',
      roles: ['owner', 'producer', 'designer'],
      password: {
        algorithm: 'scrypt',
        salt: 'legacy-salt',
        hash: 'legacy-hash',
        cost: 32768,
        blockSize: 8,
        parallelization: 1,
        keyLength: 64,
      },
      createdAt: '2026-08-14T00:00:00.000Z',
    };

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: LEGACY_LOCAL_AUTH_SCHEMA_VERSION,
          owner,
          outputTokenDigest: 'a'.repeat(64),
          outputTokenUpdatedAt: '2026-08-14T01:00:00.000Z',
        })
      );

      const state = await new FileAuthStore(filePath).load();

      expect(state).toEqual({
        schemaVersion: LOCAL_AUTH_SCHEMA_VERSION,
        owner,
        outputCredential: null,
      });
      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        schemaVersion: LOCAL_AUTH_SCHEMA_VERSION,
        outputCredential: null,
      });
      expect(JSON.stringify(persisted)).not.toContain('outputTokenDigest');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
