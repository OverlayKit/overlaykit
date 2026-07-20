import { reactive } from 'vue';
import { api, type AuthStatus, type Session } from './api';

const state = reactive<AuthStatus & { loaded: boolean }>({
  loaded: false,
  setupRequired: false,
  authenticated: false,
  session: null,
});

async function refresh(): Promise<AuthStatus> {
  const status = await api<AuthStatus>('/api/auth/status');
  Object.assign(state, status, { loaded: true });
  return status;
}

async function setup(input: { displayName: string; email: string; password: string }): Promise<void> {
  await api<{ session: Session }>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) });
  await refresh();
}

async function login(input: { email: string; password: string }): Promise<void> {
  await api<{ session: Session }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
  await refresh();
}

async function logout(): Promise<void> {
  await api<void>('/api/auth/logout', { method: 'POST' });
  Object.assign(state, { authenticated: false, session: null });
}

export const auth = { state, refresh, setup, login, logout };
