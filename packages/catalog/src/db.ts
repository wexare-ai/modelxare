/**
 * Minimal synchronous SQLite surface shared by the Node binding (node:sqlite)
 * and the browser binding (official SQLite WASM in a worker). All values are
 * bound positionally; user text is never interpolated into SQL.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlDatabase {
  /** Execute one or more statements without parameters (DDL). */
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  all<T = SqlRow>(sql: string, params?: SqlValue[]): T[];
  get<T = SqlRow>(sql: string, params?: SqlValue[]): T | undefined;
  /** Run fn atomically; rolls back and rethrows on error. Nested calls use savepoints. */
  transaction<T>(fn: () => T): T;
}

/** Savepoint-based transaction helper for adapters. */
export function makeTransaction(exec: (sql: string) => void) {
  let depth = 0;
  return function transaction<T>(fn: () => T): T {
    const name = `sp${depth}`;
    exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    depth++;
    try {
      const out = fn();
      depth--;
      exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return out;
    } catch (e) {
      depth--;
      exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  };
}
