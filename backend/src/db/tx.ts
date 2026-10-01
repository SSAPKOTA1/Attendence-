import pg from 'pg';
import { Db, getPool } from './pool';

/** Runs fn inside BEGIN/COMMIT on a dedicated client; nested calls on a client reuse it via savepoints. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, db?: Db): Promise<T> {
  if (db && !(db instanceof pg.Pool)) {
    const client = db as pg.PoolClient;
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(client);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Locks employee rows in id order (avoids deadlocks between two managers editing the same people). */
export async function lockEmployees(client: pg.PoolClient, ids: number[]): Promise<void> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return;
  await client.query('SELECT id FROM employees WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [unique]);
}
