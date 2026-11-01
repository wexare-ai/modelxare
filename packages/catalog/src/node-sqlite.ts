// Node binding (node:sqlite, bundled with Node 22 and built with FTS5).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { makeTransaction, type SqlDatabase, type SqlValue } from './db.ts';

export class NodeSqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  readonly transaction: SqlDatabase['transaction'];

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.transaction = makeTransaction((sql) => this.raw.exec(sql));
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }
  run(sql: string, params: SqlValue[] = []): void {
    this.stmt(sql).run(...(params as never[]));
  }
  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }
  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }
  close(): void {
    this.stmts.clear();
    this.raw.close();
  }
}

/** In-memory database, e.g. for building the archive's convenience catalog.sqlite. */
export const openNodeDatabase = (path = ':memory:') => new NodeSqliteDatabase(path);
