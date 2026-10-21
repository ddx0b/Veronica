import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export interface DatabaseOptions {
  dbPath: string;
  migrationsDir?: string;
}

export class SqliteDatabase {
  public readonly raw: DatabaseSync;
  public readonly dbPath: string;
  private closed = false;
  private savepointCounter = 0;

  constructor(options: DatabaseOptions) {
    this.dbPath = options.dbPath;
    if (options.dbPath !== ':memory:') {
      const dir = path.dirname(options.dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.raw = new DatabaseSync(options.dbPath);
    this.configurePragmas();
  }

  private configurePragmas(): void {
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  public runMigrations(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): string[] {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const appliedStmt = this.raw.prepare('SELECT version FROM schema_migrations WHERE version = ?');
    const insertMigrationStmt = this.raw.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    );

    const newlyApplied: string[] = [];

    for (const file of files) {
      const existing = appliedStmt.get(file) as { version: string } | undefined;
      if (existing) {
        continue;
      }

      const sqlPath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');

      this.transaction(() => {
        this.raw.exec(sqlContent);
        insertMigrationStmt.run(file, new Date().toISOString());
      });

      newlyApplied.push(file);
    }

    return newlyApplied;
  }

  public transaction<T>(fn: () => T): T {
    const spName = `sp_${++this.savepointCounter}`;
    this.raw.exec(`SAVEPOINT ${spName}`);
    try {
      const result = fn();
      this.raw.exec(`RELEASE SAVEPOINT ${spName}`);
      return result;
    } catch (err) {
      try {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
        this.raw.exec(`RELEASE SAVEPOINT ${spName}`);
      } catch {
        // Ignore secondary rollback errors
      }
      throw err;
    }
  }

  public ping(): boolean {
    if (this.closed) {
      return false;
    }
    try {
      const row = this.raw.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  public close(): void {
    if (!this.closed) {
      this.closed = true;
      this.raw.close();
    }
  }
}
