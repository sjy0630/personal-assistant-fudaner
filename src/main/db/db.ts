import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { COLUMN_MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema';

type Param = string | number | null | bigint | Uint8Array;

/** node:sqlite 的薄封装：零原生依赖，Electron 主进程和 Node 测试都能直接用。 */
export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.raw.exec(SCHEMA);
    for (const m of COLUMN_MIGRATIONS) {
      const columns = this.all<{ name: string }>(`PRAGMA table_info(${m.table})`);
      if (!columns.some((c) => c.name === m.column)) this.raw.exec(m.ddl);
    }
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'schema_version', String(SCHEMA_VERSION));
  }

  run(sql: string, ...params: (Param | undefined)[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params.map(norm));
    return { changes: Number(r.changes) };
  }

  get<T>(sql: string, ...params: (Param | undefined)[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(norm)) as T | undefined;
  }

  all<T>(sql: string, ...params: (Param | undefined)[]): T[] {
    return this.raw.prepare(sql).all(...params.map(norm)) as T[];
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

const norm = (p: Param | undefined): Param => (p === undefined ? null : p);

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
export const toJson = (v: unknown): string => JSON.stringify(v ?? null);
export function fromJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
