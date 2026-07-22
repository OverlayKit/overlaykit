import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from './AuthService';
import type { StudioRole } from './types';

export const SESSION_COOKIE = 'overlaykit_session';

export type CookieSecureMode = 'auto' | 'always' | 'never';

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function secureCookie(req: Request, mode: CookieSecureMode): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return req.secure;
}

export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
  expiresAt: string,
  mode: CookieSecureMode,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(req, mode),
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(req: Request, res: Response, mode: CookieSecureMode): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie(req, mode),
    path: '/',
  });
}

export function sessionToken(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function requireSession(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = auth.authenticateSession(sessionToken(req));
    if (!session) {
      res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Authentication required' },
      });
      return;
    }
    req.authSession = session;
    next();
  };
}

export function requireRole(role: StudioRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authSession?.user.roles.includes(role)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: `${role} role required` },
      });
      return;
    }
    next();
  };
}

export function requireAnyRole(roles: ReadonlyArray<StudioRole>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authSession?.user.roles.some((role) => roles.includes(role))) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `${roles.join(' or ')} role required`,
        },
      });
      return;
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function enforceBrowserOrigin(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const hasSessionCookie = Boolean(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    const isInteractiveAuth = req.path === '/auth/setup' || req.path === '/auth/login';
    if (!hasSessionCookie && !isInteractiveAuth) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) {
      res.status(403).json({
        error: { code: 'ORIGIN_FORBIDDEN', message: 'Request origin is not allowed' },
      });
      return;
    }
    next();
  };
}
