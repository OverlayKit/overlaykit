export const LOCAL_AUTH_SCHEMA_VERSION = 'overlaykit-local-auth/v1' as const;

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
  outputTokenDigest: string | null;
  outputTokenUpdatedAt: string | null;
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

export interface WebSocketAccess {
  kind: 'studio' | 'output';
  user: AuthenticatedUser | null;
}
