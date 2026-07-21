import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceActionCatalogRuntime,
} from '../../src/services/DeviceActionCatalogRuntime';

describe('device action catalog runtime composition', () => {
  it('loads the ESM projector once and executes the injected protocol port', async () => {
    const protocol = await import('@overlaykit/protocol/control-action-catalog');
    const loadProtocol = vi.fn(async () => protocol);
    const runtime = await createDeviceActionCatalogRuntime({ loadProtocol });

    const catalog = runtime.projectAuthorizedControlActionCatalog(
      {
        showId: 'show-1',
        capabilities: [{
          kind: 'component.visibility',
          target: 'preview',
          componentId: 'lower-third',
          label: 'Lower third',
        }],
      },
      {
        credentialId: 'device-1',
        generation: 1,
        feedbackAudience: 'device-1.g1',
        showId: 'show-1',
        targets: ['preview'],
        controlIds: ['lower-third.visibility'],
        scopes: ['component.visibility:write'],
        expiresAt: 10_000,
      },
    );

    expect(loadProtocol).toHaveBeenCalledTimes(1);
    expect(catalog.actions).toHaveLength(1);
    expect(catalog.actions[0].subject.controlId).toBe('lower-third.visibility');
  });

  it('rejects composition when the ESM projector cannot be loaded', async () => {
    await expect(createDeviceActionCatalogRuntime({
      loadProtocol: async () => { throw new Error('catalog module unavailable'); },
    })).rejects.toThrow('catalog module unavailable');
  });
});
