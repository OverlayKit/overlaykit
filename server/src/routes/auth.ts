import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../auth/AuthService';
import { AuthError } from '../auth/AuthService';
import type { Storage } from '../storage';
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
  storage: Storage,
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
        const showId = typeof req.body?.showId === 'string' ? req.body.showId.trim() : '';
        if (!showId || showId.length > 100) {
          res.status(400).json({
            error: { code: 'INVALID_SHOW_ID', message: 'A valid Show is required' },
          });
          return;
        }
        const show = await storage.getShow(showId);
        if (!show || show.archivedAt !== null) {
          res.status(404).json({
            error: { code: 'SHOW_NOT_FOUND', message: 'Show not found' },
          });
          return;
        }
        const token = await auth.rotateOutputToken(req.authSession!.user, showId);
        res.status(201).json({ data: token });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  return router;
}
