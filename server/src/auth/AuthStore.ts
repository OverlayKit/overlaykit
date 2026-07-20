import {
  LOCAL_AUTH_SCHEMA_VERSION,
  type LocalAuthState,
} from './types';

export interface AuthStore {
  load(): Promise<LocalAuthState>;
  save(state: LocalAuthState): Promise<void>;
}

export function emptyAuthState(): LocalAuthState {
  return {
    schemaVersion: LOCAL_AUTH_SCHEMA_VERSION,
    owner: null,
    outputTokenDigest: null,
    outputTokenUpdatedAt: null,
  };
}

export class MemoryAuthStore implements AuthStore {
  private state: LocalAuthState;

  constructor(initial: LocalAuthState = emptyAuthState()) {
    this.state = structuredClone(initial);
  }

  async load(): Promise<LocalAuthState> {
    return structuredClone(this.state);
  }

  async save(state: LocalAuthState): Promise<void> {
    this.state = structuredClone(state);
  }
}
