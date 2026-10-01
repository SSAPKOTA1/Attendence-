import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { anon, app } from '../helpers/api';
import { closePool } from '../../src/db/pool';

describe('Phase 0: health', () => {
  afterAll(() => closePool());

  it('GET /health is alive', async () => {
    const res = await anon.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /ready checks DB and migrations', async () => {
    const res = await anon.get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', database: 'ok' });
  });

  it('unknown routes use the error envelope', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('protected routes need a token', async () => {
    const res = await anon.get('/hotels');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
