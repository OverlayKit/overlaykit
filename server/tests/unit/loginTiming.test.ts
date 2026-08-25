import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';

/**
 * CHG-0075 hardening: login must run a password derivation on every path — matching and
 * non-matching email — so its timing cannot reveal whether the submitted email is the owner's.
 */
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

describe('Login password-derivation timing', () => {
  it('runs a derivation for a non-matching email, a wrong password, and correct credentials', async () => {
    let derivations = 0;
    const auth = new AuthService(new MemoryAuthStore(), {
      onPasswordVerification: () => {
        derivations += 1;
      },
    });
    await auth.init();
    await auth.setup(OWNER);

    // Non-matching email: a derivation still runs (against the decoy verifier), then rejects.
    derivations = 0;
    await expect(
      auth.login({ email: 'ghost@overlaykit.local', password: 'a-nonempty-password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(derivations).toBe(1);

    // Matching email, wrong password: a derivation runs, then rejects.
    derivations = 0;
    await expect(
      auth.login({ email: OWNER.email, password: 'wrong-password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(derivations).toBe(1);

    // Correct credentials: a derivation runs, then a session is issued.
    derivations = 0;
    const ok = await auth.login({ email: OWNER.email, password: OWNER.password });
    expect(ok.token).toBeTruthy();
    expect(derivations).toBe(1);
  });
});
