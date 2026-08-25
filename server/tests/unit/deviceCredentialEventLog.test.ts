import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeDeviceCredentialEventSchema,
  SqliteDeviceCredentialEventLog,
} from '../../src/auth/SqliteDeviceCredentialEventLog';

/**
 * CHG-0065 / ADR-0041: the device-credential lifecycle event log is append-only and orders history
 * by a clock-independent monotonic sequence, so a tamper cannot rewrite it and events stay ordered
 * even when they share a timestamp.
 */
describe('SqliteDeviceCredentialEventLog', () => {
  let database: DatabaseSync;
  let log: SqliteDeviceCredentialEventLog;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    initializeDeviceCredentialEventSchema(database);
    log = new SqliteDeviceCredentialEventLog({ database: () => database });
  });

  afterEach(() => {
    database.close();
  });

  it('appends events in a clock-independent monotonic sequence, scoped by Show', async () => {
    // Every event shares at=1000; ordering must come from the rowid sequence, not the clock.
    await log.record({ credentialId: 'c1', showId: 's1', kind: 'issued', actor: 'owner', generation: 1, at: 1_000 });
    await log.record({ credentialId: 'c1', showId: 's1', kind: 'rotated', actor: 'owner', generation: 2, at: 1_000 });
    await log.record({ credentialId: 'c2', showId: 's2', kind: 'issued', actor: 'owner', generation: 1, at: 1_000 });

    const s1 = await log.listByShow('s1');
    expect(s1.map((event) => event.sequence)).toEqual([1, 2]);
    expect(s1.map((event) => event.kind)).toEqual(['issued', 'rotated']);
    const s2 = await log.listByShow('s2');
    expect(s2.map((event) => event.credentialId)).toEqual(['c2']);
    expect(s2[0].sequence).toBe(3);
    expect(await log.listByShow('missing')).toEqual([]);
  });

  it('orders by the record sequence, not the timestamp', async () => {
    // Record a LATER timestamp first, then an EARLIER one. Ordered by the rowid sequence they come
    // back in insertion order; a clock-based ORDER BY at would return them reversed.
    await log.record({ credentialId: 'c1', showId: 's1', kind: 'issued', actor: 'owner', generation: 1, at: 2_000 });
    await log.record({ credentialId: 'c1', showId: 's1', kind: 'rotated', actor: 'owner', generation: 2, at: 1_000 });

    const events = await log.listByShow('s1');
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.at)).toEqual([2_000, 1_000]);
    expect(events.map((event) => event.kind)).toEqual(['issued', 'rotated']);
  });

  it('rejects updates and deletes so history cannot be rewritten', async () => {
    await log.record({ credentialId: 'c1', showId: 's1', kind: 'issued', actor: 'owner', generation: 1, at: 1_000 });
    expect(() => database.exec("UPDATE device_credential_events SET actor = 'tamper'")).toThrow(/append-only/);
    expect(() => database.exec('DELETE FROM device_credential_events')).toThrow(/append-only/);
    const events = await log.listByShow('s1');
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe('owner');
  });

  it('rejects an unknown event kind', async () => {
    await expect(
      log.record({
        credentialId: 'c1',
        showId: 's1',
        kind: 'tampered' as 'issued',
        actor: 'owner',
        generation: 1,
        at: 1_000,
      }),
    ).rejects.toThrow(/Unknown device credential event kind/);
  });
});
