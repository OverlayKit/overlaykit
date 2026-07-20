import type { AuthenticatedSession } from '../auth/types';

declare global {
  namespace Express {
    interface Request {
      authSession?: AuthenticatedSession;
    }
  }
}

export {};
