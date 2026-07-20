import { describe, expect, it } from 'vitest';
import { AuthError, AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';

const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Local Owner',
  password: 'correct horse battery staple',
};

describe('AuthService', () => {
  it('creates exactly one owner and stores verifiers instead of plaintext credentials', async () => {
    const store = new MemoryAuthStore();
    const auth = new AuthService(store);
    await auth.init();

    const first = await auth.setup(OWNER);
    expect(first.session.user.roles).toEqual(['owner', 'producer', 'designer']);
    expect(auth.authenticateSession(first.token)?.user.email).toBe(OWNER.email);

    const state = await store.load();
    expect(state.owner?.password.algorithm).toBe('scrypt');
    expect(JSON.stringify(state)).not.toContain(OWNER.password);

    await expect(auth.setup(OWNER)).rejects.toMatchObject<AuthError>({
      code: 'SETUP_COMPLETE',
      status: 409,
    });
  });

  it('expires sessions and rotates the read-only output credential', async () => {
    let now = 1_000;
    const auth = new AuthService(new MemoryAuthStore(), {
      sessionTtlMs: 60_000,
      now: () => now,
    });
    await auth.init();
    const owner = await auth.setup(OWNER);
    const first = await auth.rotateOutputToken(owner.session.user);
    const second = await auth.rotateOutputToken(owner.session.user);

    expect(auth.verifyOutputToken(first.token)).toBe(false);
    expect(auth.verifyOutputToken(second.token)).toBe(true);

    now += 60_001;
    expect(auth.authenticateSession(owner.token)).toBeNull();
  });

  it('rejects invalid credentials without revealing which field failed', async () => {
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    await auth.setup(OWNER);

    await expect(auth.login({ email: OWNER.email, password: 'incorrect password' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
  });
});
