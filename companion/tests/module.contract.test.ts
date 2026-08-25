import { describe, expect, it, vi } from 'vitest';
import {
  COMPONENT_VISIBILITY_ACTION_KIND,
  projectAuthorizedControlActionCatalog,
  type ControlActionInventory,
  type DeviceCredentialAuthority,
} from '@overlaykit/protocol';
import { projectCompanionActions } from '../src/catalog';
import {
  COMPANION_CONFIG_FIELDS,
  buildCompanionActionDefinitions,
  parseModuleConfig,
} from '../src/module';
import type { CommandResult } from '../src/transport';

const SHOW = 'show-1';

const AUTHORITY: DeviceCredentialAuthority = {
  credentialId: 'cred-1',
  audienceCredentialId: 'aud-1',
  generation: 1,
  showId: SHOW,
  targets: ['preview'],
  controlIds: ['scoreboard.visibility'],
  scopes: ['component.visibility:write'],
  expiresAt: 4_102_444_800_000,
};

const INVENTORY: ControlActionInventory = {
  showId: SHOW,
  capabilities: [
    { kind: COMPONENT_VISIBILITY_ACTION_KIND, target: 'preview', componentId: 'scoreboard', label: 'Scoreboard' },
  ],
};

const ACTIONS = projectCompanionActions(projectAuthorizedControlActionCatalog(INVENTORY, AUTHORITY));
const APPLIED: CommandResult = {
  ok: true,
  outcome: {
    status: 'applied',
    resultCode: 'APPLIED',
    globalSequence: 1,
    operationId: 'op',
    intentHash: 'h',
    authorityGeneration: 1,
    expectedRevision: 0,
    previousRevision: 0,
    resultingRevision: 1,
    resultingSnapshotHash: 's',
    committedAt: 1,
    replayed: false,
  },
};

describe('module config', () => {
  it('declares the three connection fields a Companion module needs', () => {
    expect(COMPANION_CONFIG_FIELDS.map((f) => f.id)).toEqual(['baseUrl', 'token', 'showId']);
    expect(COMPANION_CONFIG_FIELDS.every((f) => f.type === 'textinput' && f.required)).toBe(true);
  });

  it('parses a complete config, trimming whitespace', () => {
    const result = parseModuleConfig({ baseUrl: ' http://ctrl:4000 ', token: 'ok_device_x', showId: SHOW });
    expect(result).toEqual({ ok: true, config: { baseUrl: 'http://ctrl:4000', token: 'ok_device_x', showId: SHOW } });
  });

  it('reports every missing or blank field rather than a partial config', () => {
    expect(parseModuleConfig({ baseUrl: 'http://ctrl', token: '   ', showId: '' })).toEqual({
      ok: false,
      missing: ['token', 'showId'],
    });
    expect(parseModuleConfig({})).toEqual({ ok: false, missing: ['baseUrl', 'token', 'showId'] });
  });
});

describe('buildCompanionActionDefinitions', () => {
  it('maps each discovered action to a definition keyed by actionId', () => {
    const definitions = buildCompanionActionDefinitions(ACTIONS, async () => APPLIED);
    const [action] = ACTIONS;

    expect(Object.keys(definitions)).toEqual(['component.visibility/preview/scoreboard']);
    expect(definitions[action.actionId]).toMatchObject({
      name: action.name,
      options: action.options,
    });
  });

  it('presses a button by running the command for that action and the visible option', async () => {
    const run = vi.fn(async () => APPLIED);
    const definitions = buildCompanionActionDefinitions(ACTIONS, run);
    const [action] = ACTIONS;

    const result = await definitions[action.actionId].callback({ visible: false });

    expect(run).toHaveBeenCalledWith(action, { visible: false });
    expect(result).toBe(APPLIED);
  });

  it('coerces a missing or non-boolean visible option to false', async () => {
    const run = vi.fn(async () => APPLIED);
    const definitions = buildCompanionActionDefinitions(ACTIONS, run);
    const [action] = ACTIONS;

    await definitions[action.actionId].callback({});
    expect(run).toHaveBeenCalledWith(action, { visible: false });
  });
});
