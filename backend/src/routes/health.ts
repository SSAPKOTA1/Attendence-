import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getPool } from '../db/pool';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

function migrationFiles(): string[] {
  const dir = path.resolve(__dirname, '..', '..', 'migrations');
  const alt = path.resolve(__dirname, '..', '..', '..', 'migrations');
  const use = fs.existsSync(dir) ? dir : alt;
  return fs.readdirSync(use).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort();
}

healthRouter.get('/ready', async (_req, res) => {
  try {
    const applied = (await getPool().query('SELECT name FROM pgmigrations')).rows.map((r) => r.name);
    const pending = migrationFiles().filter((f) => !applied.includes(f));
    if (pending.length > 0) return res.status(503).json({ status: 'not_ready', database: 'ok', pendingMigrations: pending });
    res.json({ status: 'ready', database: 'ok', migrations: applied.length });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'unreachable' });
  }
});
