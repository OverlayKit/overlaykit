const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
export type {
  ProductionControl,
  ProductionSnapshot,
  ProductionState,
  TakeReceipt,
} from '@overlaykit/protocol';

export interface Session {
  user: {
    id: string;
    email: string;
    displayName: string;
    roles: Array<'owner' | 'producer' | 'designer'>;
  };
  expiresAt: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  session: Session | null;
  output?: { configured: boolean; updatedAt: string | null };
}

export interface Show {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, payload?.error?.message || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json() as { data: T };
  return payload.data;
}

export { API_URL };
