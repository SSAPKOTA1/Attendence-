/* Forward-only migration runner (node-pg-migrate, SQL files in ./migrations). */
import path from 'node:path';
import 'dotenv/config';

export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl,
    dir: path.resolve(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    log,
  });
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
