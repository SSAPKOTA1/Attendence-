import pg from 'pg';
import path from 'node:path';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shiftsched_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl: url,
    dir: path.resolve(__dirname, '..', '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    log: () => undefined,
  });
}
