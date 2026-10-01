import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as, anon } from '../helpers/api';
import { setupWorld, World } from '../helpers/fixtures';
import { closePool } from '../../src/db/pool';

let w: World;
const doc = YAML.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'openapi.yaml'), 'utf8'));
const ops: { method: string; path: string; id: string }[] = [];
for (const [p, methods] of Object.entries<any>(doc.paths)) for (const [m, op] of Object.entries<any>(methods)) ops.push({ method: m, path: p, id: op.operationId });

describe('every catalogued endpoint is routed', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('catalog has all 121 operations of spec section 8', () => {
    expect(ops).toHaveLength(121);
  });

  it.each(ops)('$id $method $path', async ({ method, path: p }) => {
    const url = p.replace('{id}', '999999');
    const client = as(w.tokens.admin, { 'X-Device-Token': 'x' }) as any;
    const res = await client[method](url, ...(method === 'get' || method === 'delete' ? [] : [{}]));
    const routeMissing = res.status === 404 && JSON.stringify(res.body.error?.details ?? []).includes('route not found');
    expect(routeMissing).toBe(false);
  });

  it('serves the OpenAPI document', async () => {
    const res = await anon.get('/docs/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('openapi: 3.1.0');
    expect((await anon.get('/docs')).status).toBe(200);
  });
});
