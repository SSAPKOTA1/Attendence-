import pg from 'pg';
import { config } from '../config';

// DATE stays a 'YYYY-MM-DD' string (hotel-local calendar day), NUMERIC/INT8 become numbers, TIME becomes 'HH:mm'.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));
pg.types.setTypeParser(20, (v: string) => parseInt(v, 10));
pg.types.setTypeParser(1083, (v: string) => v.slice(0, 5));

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
    pool.on('error', () => undefined);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function rows<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params as any[]);
  return res.rows as T[];
}

export async function maybeOne<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query(sql, params as any[]);
  return (res.rows[0] as T) ?? null;
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const res = await db.query(sql, params as any[]);
  if (!res.rows[0]) throw new Error('Expected one row');
  return res.rows[0] as T;
}
