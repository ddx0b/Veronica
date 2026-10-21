import crypto from 'node:crypto';
import type { SqliteDatabase } from '../db.js';
import type { Channel, RouteRecord } from '../../domain/types.js';

interface RouteRow {
  id: string;
  source_channel: Channel;
  source_identity: string;
  destination_channel: Channel;
  destination_identity: string;
  enabled: number;
}

function mapRow(row: RouteRow): RouteRecord {
  return {
    id: row.id,
    sourceChannel: row.source_channel,
    sourceIdentity: row.source_identity,
    destinationChannel: row.destination_channel,
    destinationIdentity: row.destination_identity,
    enabled: row.enabled === 1,
  };
}

export interface UpsertRouteInput {
  sourceChannel: Channel;
  sourceIdentity: string;
  destinationChannel: Channel;
  destinationIdentity: string;
  enabled: boolean;
}

export class RouteRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  public upsertRoute(input: UpsertRouteInput): RouteRecord {
    const id = crypto.randomUUID();
    const enabledInt = input.enabled ? 1 : 0;

    const stmt = this.db.raw.prepare(`
      INSERT INTO routes (
        id, source_channel, source_identity, destination_channel, destination_identity, enabled
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_channel, source_identity, destination_channel, destination_identity)
      DO UPDATE SET enabled = excluded.enabled
    `);

    stmt.run(
      id,
      input.sourceChannel,
      input.sourceIdentity,
      input.destinationChannel,
      input.destinationIdentity,
      enabledInt
    );

    const fetchStmt = this.db.raw.prepare(`
      SELECT id, source_channel, source_identity, destination_channel, destination_identity, enabled
      FROM routes
      WHERE source_channel = ?
        AND source_identity = ?
        AND destination_channel = ?
        AND destination_identity = ?
    `);

    const row = fetchStmt.get(
      input.sourceChannel,
      input.sourceIdentity,
      input.destinationChannel,
      input.destinationIdentity
    ) as RouteRow | undefined;

    if (!row) {
      throw new Error('Failed to load upserted route');
    }

    return mapRow(row);
  }

  public syncConfiguredRoutes(routes: UpsertRouteInput[]): RouteRecord[] {
    return this.db.transaction(() => {
      // Disable all existing routes first so stale routes from previous configs are deactivated
      this.db.raw.prepare('UPDATE routes SET enabled = 0').run();
      return routes.map((r) => this.upsertRoute(r));
    });
  }

  public findEnabledRoutes(sourceChannel: Channel, sourceIdentity: string): RouteRecord[] {
    const stmt = this.db.raw.prepare(`
      SELECT id, source_channel, source_identity, destination_channel, destination_identity, enabled
      FROM routes
      WHERE source_channel = ? AND source_identity = ? AND enabled = 1
    `);

    const rows = stmt.all(sourceChannel, sourceIdentity) as unknown as RouteRow[];
    return rows.map(mapRow);
  }

  public listAll(): RouteRecord[] {
    const stmt = this.db.raw.prepare(`
      SELECT id, source_channel, source_identity, destination_channel, destination_identity, enabled
      FROM routes
    `);
    const rows = stmt.all() as unknown as RouteRow[];
    return rows.map(mapRow);
  }
}
