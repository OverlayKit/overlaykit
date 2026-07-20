// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../../src/auth';

const session = {
  user: {
    id: 'owner-1',
    email: 'owner@overlaykit.local',
    displayName: 'Local Owner',
    roles: ['owner', 'producer', 'designer'] as const,
  },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

function response(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(auth.state, {
    loaded: false,
    setupRequired: false,
    authenticated: false,
    session: null,
    output: undefined,
  });
});

describe('Studio authentication state', () => {
  it('refreshes first-run state from the server', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      setupRequired: true,
      authenticated: false,
      session: null,
    }));

    await auth.refresh();

    expect(auth.state).toMatchObject({ loaded: true, setupRequired: true, authenticated: false });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/auth/status', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('sets up the owner and refreshes the guarded session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ session }, 201))
      .mockResolvedValueOnce(response({ setupRequired: false, authenticated: true, session }));

    await auth.setup({
      displayName: 'Local Owner',
      email: 'owner@overlaykit.local',
      password: 'correct horse battery staple',
    });

    expect(auth.state.authenticated).toBe(true);
    expect(auth.state.session?.user.roles).toContain('owner');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears local session state after logout', async () => {
    Object.assign(auth.state, { authenticated: true, session });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(undefined, 204));

    await auth.logout();

    expect(auth.state.authenticated).toBe(false);
    expect(auth.state.session).toBeNull();
  });
});
