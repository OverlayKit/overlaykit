import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'crypto';
import type { AuthStore } from './AuthStore';
import type {
  AuthenticatedSession,
  AuthenticatedUser,
  LocalAuthState,
  PasswordVerifier,
  StoredLocalUser,
  StudioRole,
} from './types';

const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SESSION_PREFIX = 'ok_session_';
const OUTPUT_TOKEN_PREFIX = 'ok_output_';

interface SessionRecord {
  user: AuthenticatedUser;
  expiresAt: number;
}

export interface AuthServiceOptions {
  sessionTtlMs?: number;
  now?: () => number;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function deriveKey(password: string, verifier: Omit<PasswordVerifier, 'hash'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(verifier.salt, 'base64url'),
      verifier.keyLength,
      {
        N: verifier.cost,
        r: verifier.blockSize,
        p: verifier.parallelization,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

function publicUser(user: StoredLocalUser): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: [...user.roles],
  };
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('INVALID_EMAIL', 400, 'Enter a valid email address');
  }
  return email;
}

function normalizeDisplayName(value: unknown): string {
  const displayName = typeof value === 'string' ? value.trim() : '';
  if (displayName.length < 2 || displayName.length > 80) {
    throw new AuthError('INVALID_DISPLAY_NAME', 400, 'Display name must be 2 to 80 characters');
  }
  return displayName;
}

function normalizePassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 12 || password.length > 256) {
    throw new AuthError('INVALID_PASSWORD', 400, 'Password must be 12 to 256 characters');
  }
  return password;
}

export class AuthService {
  private state: LocalAuthState | null = null;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private setupInProgress = false;

  constructor(
    private readonly store: AuthStore,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    this.state = await this.store.load();
  }

  isSetupRequired(): boolean {
    return this.requireState().owner === null;
  }

  async setup(input: {
    email?: unknown;
    displayName?: unknown;
    password?: unknown;
  }): Promise<{ token: string; session: AuthenticatedSession }> {
    if (this.setupInProgress || !this.isSetupRequired()) {
      throw new AuthError('SETUP_COMPLETE', 409, 'Owner setup is already complete');
    }

    this.setupInProgress = true;
    try {
      const email = normalizeEmail(input.email);
      const displayName = normalizeDisplayName(input.displayName);
      const password = normalizePassword(input.password);
      const salt = randomBytes(24).toString('base64url');
      const parameters = {
        algorithm: 'scrypt' as const,
        salt,
        cost: SCRYPT_COST,
        blockSize: SCRYPT_BLOCK_SIZE,
        parallelization: SCRYPT_PARALLELIZATION,
        keyLength: SCRYPT_KEY_LENGTH,
      };
      const hash = (await deriveKey(password, parameters)).toString('base64url');
      const roles: StudioRole[] = ['owner', 'producer', 'designer'];
      const owner: StoredLocalUser = {
        id: randomUUID(),
        email,
        displayName,
        roles,
        password: { ...parameters, hash },
        createdAt: new Date(this.now()).toISOString(),
      };
      const state = this.requireState();
      state.owner = owner;
      await this.store.save(state);
      return this.createSession(publicUser(owner));
    } finally {
      this.setupInProgress = false;
    }
  }

  async login(input: { email?: unknown; password?: unknown }): Promise<{
    token: string;
    session: AuthenticatedSession;
  }> {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    const owner = this.requireState().owner;
    if (!owner || email !== owner.email || !(await this.verifyPassword(password, owner.password))) {
      throw new AuthError('INVALID_CREDENTIALS', 401, 'Invalid email or password');
    }
    return this.createSession(publicUser(owner));
  }

  authenticateSession(token: string | null | undefined): AuthenticatedSession | null {
    if (!token) return null;
    const tokenDigest = digest(token);
    const record = this.sessions.get(tokenDigest);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(tokenDigest);
      return null;
    }
    return {
      user: { ...record.user, roles: [...record.user.roles] },
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  logout(token: string | null | undefined): void {
    if (token) this.sessions.delete(digest(token));
  }

  async rotateOutputToken(user: AuthenticatedUser): Promise<{
    token: string;
    updatedAt: string;
  }> {
    if (!user.roles.includes('owner')) {
      throw new AuthError('FORBIDDEN', 403, 'Owner role required');
    }
    const token = OUTPUT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const updatedAt = new Date(this.now()).toISOString();
    const state = this.requireState();
    state.outputTokenDigest = digest(token);
    state.outputTokenUpdatedAt = updatedAt;
    await this.store.save(state);
    return { token, updatedAt };
  }

  verifyOutputToken(token: string | null | undefined): boolean {
    if (!token || !token.startsWith(OUTPUT_TOKEN_PREFIX)) return false;
    const stored = this.requireState().outputTokenDigest;
    return stored !== null && safeDigestEqual(stored, digest(token));
  }

  outputTokenStatus(): { configured: boolean; updatedAt: string | null } {
    const state = this.requireState();
    return {
      configured: state.outputTokenDigest !== null,
      updatedAt: state.outputTokenUpdatedAt,
    };
  }

  private requireState(): LocalAuthState {
    if (!this.state) throw new Error('AuthService must be initialized before use');
    return this.state;
  }

  private createSession(user: AuthenticatedUser): {
    token: string;
    session: AuthenticatedSession;
  } {
    const token = SESSION_PREFIX + randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(digest(token), { user, expiresAt });
    return {
      token,
      session: {
        user: { ...user, roles: [...user.roles] },
        expiresAt: new Date(expiresAt).toISOString(),
      },
    };
  }

  private async verifyPassword(password: string, verifier: PasswordVerifier): Promise<boolean> {
    if (!password || verifier.algorithm !== 'scrypt') return false;
    const candidate = await deriveKey(password, verifier);
    const stored = Buffer.from(verifier.hash, 'base64url');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  }
}
