import { getPool } from '../../src/db/pool';

let tables: string[] | null = null;

/** Empties every table (identities restart) – used per test file / test. */
export async function resetDb(): Promise<void> {
  const pool = getPool();
  if (!tables) {
    tables = (
      await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'pgmigrations'`)
    ).rows.map((r) => `"${r.tablename}"`);
  }
  await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params as any[])).rows as T[];
}

export async function q1<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await q<T>(sql, params))[0];
}
