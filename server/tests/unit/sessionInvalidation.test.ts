import request from 'supertest';
import { describe, it } from 'vitest';
import { AuthService } from '../../src/auth/AuthService';
import { MemoryAuthStore } from '../../src/auth/AuthStore';
import { createApp } from '../../src/index';
import { SESSION_COOKIE } from '../../src/auth/http';

/**
 * CHG-0059 / AC-004: after sign-out or expiry, protected requests are rejected AND the session
 * cannot be reused. The load-bearing assertion replays the pre-logout token value on a fresh
 * request: if rejection came only from the client dropping its cookie, the replay would still
 * authenticate. It must be the server that invalidated the session.
 */

function tokenFromSetCookie(header: string[] | undefined): string {
  const cookie = (header ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const match = cookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) throw new Error('no session cookie set');
  return decodeURIComponent(match[1]);
}

const ORIGIN = 'http://localhost:5173';
const OWNER = {
  email: 'owner@overlaykit.local',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

function replay(app: ReturnType<typeof createApp>, token: string) {
  return request(app).get('/api/shows').set('Cookie', `${SESSION_COOKIE}=${token}`);
}

describe('a signed-out or expired session cannot be reused (AC-004)', () => {
  it('rejects a replayed token after sign-out (server invalidation, not cookie removal)', async () => {
    const auth = new AuthService(new MemoryAuthStore());
    await auth.init();
    const app = createApp({ auth });
    const agent = request.agent(app);

    const setup = await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
    const token = tokenFromSetCookie(setup.headers['set-cookie']);

    // While the session is live the replayed token authenticates.
    await replay(app, token).expect(200);

    await agent.post('/api/auth/logout').set('Origin', ORIGIN).expect(204);

    // After logout the same token value is rejected by the server.
    await replay(app, token).expect(401);
  });

  it('rejects a replayed token once the session has expired', async () => {
    let clock = 1_000_000;
    const auth = new AuthService(new MemoryAuthStore(), { sessionTtlMs: 50, now: () => clock });
    await auth.init();
    const app = createApp({ auth });
    const agent = request.agent(app);

    const setup = await agent.post('/api/auth/setup').set('Origin', ORIGIN).send(OWNER).expect(201);
    const token = tokenFromSetCookie(setup.headers['set-cookie']);
    await replay(app, token).expect(200);

    clock += 51; // past the session TTL

    await replay(app, token).expect(401);
  });
});
