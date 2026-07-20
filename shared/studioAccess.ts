interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
}

export async function ensureStudioSession(): Promise<boolean> {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';
  const studioUrl = env.VITE_STUDIO_URL || 'http://localhost:5173';
  try {
    const response = await fetch(`${apiUrl}/api/auth/status`, { credentials: 'include' });
    if (!response.ok) throw new Error(`Authentication status failed (${response.status})`);
    const payload = await response.json() as { data: AuthStatus };
    if (payload.data.setupRequired) {
      location.replace(`${studioUrl}/setup`);
      return false;
    }
    if (!payload.data.authenticated) {
      location.replace(`${studioUrl}/login`);
      return false;
    }
    return true;
  } catch {
    location.replace(`${studioUrl}/login`);
    return false;
  }
}
