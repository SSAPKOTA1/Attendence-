import { execSync } from 'node:child_process';
import { backendEnv } from '../../playwright.config';

/** Fresh database for every run: create, migrate, seed (demo password Demo-Password-2026). */
export default async function globalSetup() {
  const env = { ...process.env, ...backendEnv };
  const url = new URL(backendEnv.DATABASE_URL);
  const db = url.pathname.slice(1);
  const admin = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;
  execSync(`psql "${admin}" -qc "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" -c "CREATE DATABASE ${db}"`, { stdio: 'inherit' });
  execSync('npm run migrate --silent', { cwd: '../backend', env, stdio: 'inherit' });
  execSync('npx tsx scripts/seed.ts', { cwd: '../backend', env, stdio: 'ignore' });
}
