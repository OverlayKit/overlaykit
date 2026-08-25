import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { resolveCookieSecure } from '../../src/config/environment';
import { setSessionCookie, type CookieSecureMode } from '../../src/auth/http';

/**
 * CHG-0070 hardening: the session cookie must fail safe to Secure in production. Under the default
 * COOKIE_SECURE='auto', a misconfigured proxy (TRUST_PROXY unset, req.secure false) must never be
 * able to downgrade the cookie to non-Secure.
 */
describe('Session cookie Secure fail-safe', () => {
  it('resolves auto to always only in production', () => {
    expect(resolveCookieSecure('auto', 'production')).toBe('always');
    expect(resolveCookieSecure('auto', 'development')).toBe('auto');
    // Explicit modes are never overridden.
    expect(resolveCookieSecure('always', 'production')).toBe('always');
    expect(resolveCookieSecure('never', 'production')).toBe('never');
    expect(resolveCookieSecure('never', 'development')).toBe('never');
  });

  function cookieSecureFor(mode: CookieSecureMode, requestSecure: boolean): boolean | undefined {
    let options: { secure?: boolean } = {};
    const req = { secure: requestSecure } as Request;
    const res = {
      cookie: (_name: string, _value: string, opts: { secure?: boolean }) => {
        options = opts;
      },
    } as unknown as Response;
    setSessionCookie(req, res, 'token', new Date(Date.now() + 60_000).toISOString(), mode);
    return options.secure;
  }

  it('sets Secure for the always mode regardless of the request, and follows the request for auto', () => {
    // 'always' (what production 'auto' resolves to) is Secure even when req.secure is false — the
    // misconfigured-proxy case the fail-safe defends.
    expect(cookieSecureFor('always', false)).toBe(true);
    expect(cookieSecureFor('always', true)).toBe(true);
    // 'never' is never Secure.
    expect(cookieSecureFor('never', true)).toBe(false);
    // 'auto' (development) follows the request's TLS state.
    expect(cookieSecureFor('auto', false)).toBe(false);
    expect(cookieSecureFor('auto', true)).toBe(true);
  });
});
