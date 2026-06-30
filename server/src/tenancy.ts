import { Request } from 'express';

export const DEFAULT_TENANT_ID = 'default';

export function resolveTenant(_req: Request): string {
  return DEFAULT_TENANT_ID;
}

export function channelKey(_tenantId: string, channelId: string): string {
  return channelId;
}
