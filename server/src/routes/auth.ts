import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService';
import { AuthError } from '../auth/AuthService';
import {
  clearSessionCookie,
  requireRole,
  requireSession,
  sessionToken,
  setSessionCookie,
  type CookieSecureMode,
} from '../auth/http';

function sendError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  res.status(500).json({
    error: { code: 'AUTH_INTERNAL_ERROR', message: 'Authentication operation failed' },
  });
}

export function createAuthRouter(
  auth: AuthService,
  cookieSecure: CookieSecureMode,
): Router {
  const router = Router();

  router.get('/auth/status', (req: Request, res: Response) => {
    const session = auth.authenticateSession(sessionToken(req));
    res.json({
      data: {
        setupRequired: auth.isSetupRequired(),
        authenticated: session !== null,
        session,
        output: session?.user.roles.includes('owner') ? auth.outputTokenStatus() : undefined,
      },
    });
  });

  router.post('/auth/setup', async (req: Request, res: Response) => {
    try {
      const result = await auth.setup(req.body ?? {});
      setSessionCookie(req, res, result.token, result.session.expiresAt, cookieSecure);
      res.status(201).json({ data: { session: result.session } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/auth/login', async (req: Request, res: Response) => {
    try {
      const result = await auth.login(req.body ?? {});
      setSessionCookie(req, res, result.token, result.session.expiresAt, cookieSecure);
      res.json({ data: { session: result.session } });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/auth/logout', requireSession(auth), (req: Request, res: Response) => {
    auth.logout(sessionToken(req));
    clearSessionCookie(req, res, cookieSecure);
    res.status(204).send();
  });

  router.get('/auth/me', requireSession(auth), (req: Request, res: Response) => {
    res.json({ data: { session: req.authSession } });
  });

  router.post(
    '/auth/output-token',
    requireSession(auth),
    requireRole('owner'),
    async (req: Request, res: Response) => {
      try {
        const token = await auth.rotateOutputToken(req.authSession!.user);
        res.status(201).json({ data: token });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  return router;
}
