import { describe, it, expect } from 'vitest';
import { resolveTenant, channelKey, DEFAULT_TENANT_ID } from '../../src/tenancy';
import { Request } from 'express';

describe('OSS tenancy', () => {
  it('always resolves the single default tenant', () => {
    expect(resolveTenant({ headers: { 'x-tenant-id': 'ignored' } } as unknown as Request)).toBe(DEFAULT_TENANT_ID);
  });

  it('uses the bare channel id as the realtime route key', () => {
    expect(channelKey(DEFAULT_TENANT_ID, 'main')).toBe('main');
    expect(channelKey('anything', 'alerts')).toBe('alerts');
  });
});
