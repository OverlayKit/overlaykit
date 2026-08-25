import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * An append-only per-event device-credential lifecycle log (ADR-0041). Each issue, rotate and
 * revoke records one immutable row carrying only lifecycle metadata — never a token or the sealed
 * verifier. Rows are ordered by a clock-independent rowid sequence so history stays deterministic
 * even when several events share a timestamp.
 */

export type DeviceCredentialEventKind = 'issued' | 'rotated' | 'revoked';

const EVENT_KINDS: ReadonlyArray<DeviceCredentialEventKind> = ['issued', 'rotated', 'revoked'];

export interface DeviceCredentialEventInput {
  readonly credentialId: string;
  readonly showId: string;
  readonly kind: DeviceCredentialEventKind;
  readonly actor: string;
  readonly generation: number;
  readonly at: number;
}

export interface DeviceCredentialEvent extends DeviceCredentialEventInput {
  readonly sequence: number;
}

export interface DeviceCredentialEventLogPort {
  record(event: DeviceCredentialEventInput): Promise<DeviceCredentialEvent>;
  listByShow(showId: string): Promise<DeviceCredentialEvent[]>;
}

export interface SqliteDeviceCredentialEventLogOptions {
  readonly database: () => DatabaseSync;
}

interface EventRow {
  id: number;
  credential_id: string;
  show_id: string;
  kind: string;
  actor: string;
  generation: number;
  at: number;
}

export function initializeDeviceCredentialEventSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS device_credential_events (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id > 0),
      credential_id TEXT NOT NULL,
      show_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('issued', 'rotated', 'revoked')),
      actor TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      at INTEGER NOT NULL CHECK (at >= 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS device_credential_events_show_id
      ON device_credential_events (show_id);
    CREATE TRIGGER IF NOT EXISTS device_credential_events_no_update
    BEFORE UPDATE ON device_credential_events
    BEGIN
      SELECT RAISE(ABORT, 'device credential events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS device_credential_events_no_delete
    BEFORE DELETE ON device_credential_events
    BEGIN
      SELECT RAISE(ABORT, 'device credential events are append-only');
    END;
  `);
}

function eventFromRow(row: EventRow): DeviceCredentialEvent {
  return {
    sequence: row.id,
    credentialId: row.credential_id,
    showId: row.show_id,
    kind: row.kind as DeviceCredentialEventKind,
    actor: row.actor,
    generation: row.generation,
    at: row.at,
  };
}

export class SqliteDeviceCredentialEventLog implements DeviceCredentialEventLogPort {
  private readonly database: () => DatabaseSync;
  private preparedOn: DatabaseSync | null = null;
  private insertStatement: StatementSync | null = null;
  private listStatement: StatementSync | null = null;

  constructor(options: SqliteDeviceCredentialEventLogOptions) {
    this.database = options.database;
  }

  private statements(): { insert: StatementSync; list: StatementSync } {
    // The owning store owns the connection and may close/reopen it; re-prepare whenever the
    // resolved handle changes so we never run a statement bound to a stale connection.
    const database = this.database();
    if (this.preparedOn !== database || !this.insertStatement || !this.listStatement) {
      this.insertStatement = database.prepare(`
        INSERT INTO device_credential_events (credential_id, show_id, kind, actor, generation, at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      this.listStatement = database.prepare(`
        SELECT id, credential_id, show_id, kind, actor, generation, at
        FROM device_credential_events
        WHERE show_id = ?
        ORDER BY id ASC
      `);
      this.preparedOn = database;
    }
    return { insert: this.insertStatement, list: this.listStatement };
  }

  async record(event: DeviceCredentialEventInput): Promise<DeviceCredentialEvent> {
    if (!EVENT_KINDS.includes(event.kind)) {
      throw new Error(`Unknown device credential event kind: ${String(event.kind)}`);
    }
    const { insert } = this.statements();
    const result = insert.run(
      event.credentialId,
      event.showId,
      event.kind,
      event.actor,
      event.generation,
      event.at,
    );
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }

  async listByShow(showId: string): Promise<DeviceCredentialEvent[]> {
    const { list } = this.statements();
    const rows = list.all(showId) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }
}
