/* Forward-only migration runner (node-pg-migrate, SQL files in ./migrations). */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl,
    // scripts/ (tsx) and dist/scripts/ (compiled) sit at different depths below the migrations folder
    dir: [path.resolve(__dirname, '..', 'migrations'), path.resolve(__dirname, '..', '..', 'migrations')].find((d) => fs.existsSync(d)) as string,
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
