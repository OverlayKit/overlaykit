import { AuthService } from './AuthService';
import { FileAuthStore } from './FileAuthStore';
import { config } from '../config/environment';

export const authService = new AuthService(new FileAuthStore(), {
  sessionTtlMs: config.sessionTtlMs,
});

export * from './AuthService';
export * from './AuthStore';
export * from './http';
export * from './types';
