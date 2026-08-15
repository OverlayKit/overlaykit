export const LEGACY_LOCAL_AUTH_SCHEMA_VERSION = 'overlaykit-local-auth/v1' as const;
export const LOCAL_AUTH_SCHEMA_VERSION = 'overlaykit-local-auth/v2' as const;

export type StudioRole = 'owner' | 'producer' | 'designer';

export interface PasswordVerifier {
  algorithm: 'scrypt';
  salt: string;
  hash: string;
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
}

export interface StoredLocalUser {
  id: string;
  email: string;
  displayName: string;
  roles: StudioRole[];
  password: PasswordVerifier;
  createdAt: string;
}

export interface LocalAuthState {
  schemaVersion: typeof LOCAL_AUTH_SCHEMA_VERSION;
  owner: StoredLocalUser | null;
  outputCredential: {
    digest: string;
    showId: string;
    updatedAt: string;
  } | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  roles: StudioRole[];
}

export interface AuthenticatedSession {
  user: AuthenticatedUser;
  expiresAt: string;
}

export type WebSocketAccess =
  | { kind: 'studio'; user: AuthenticatedUser }
  | { kind: 'output'; user: null; showId: string };
