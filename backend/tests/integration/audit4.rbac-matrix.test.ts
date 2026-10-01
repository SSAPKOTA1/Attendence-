import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { as } from '../helpers/api';
import { setupWorld, token, World } from '../helpers/fixtures';
import { closePool } from '../../src/db/pool';

/** Parses the endpoint catalog of docs/SPEC.md section 8: | ID | METHOD | /path | ROLE | PHASE | */
const spec = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'SPEC.md'), 'utf8');
const rows = [...spec.matchAll(/^\| ([A-Z]{1,2}\d{1,2}) \| (GET|POST|PATCH|PUT|DELETE) \| (\/\S*) \| ([PSMAD]) \| \d+ \|$/gm)].map((m) => ({ id: m[1], method: m[2].toLowerCase(), path: m[3], role: m[4] }));

let w: World;

describe('RBAC matrix derived from the SPEC endpoint table', () => {
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => closePool());

  it('the table has all 121 endpoints', () => {
    expect(rows).toHaveLength(121);
  });

  const url = (p: string) => p.replace(':id', '999999').replace(':employeeId', '999999');
  const call = async (token: string | undefined, r: (typeof rows)[number]) => {
    const client = as(token) as any;
    return client[r.method](url(r.path), ...(['get', 'delete'].includes(r.method) ? [] : [{}]));
  };

  for (const r of rows) {
    it(`${r.id} ${r.method.toUpperCase()} ${r.path} [${r.role}]`, async () => {
      if (r.role === 'P' || r.role === 'D') {
        // public / device endpoints never answer 403 FORBIDDEN for a missing user session
        const res = await call(undefined, r);
        expect(res.status).not.toBe(403);
        if (r.role === 'D') expect([401, 429]).toContain(res.status);
        return;
      }
      const anon = await call(undefined, r);
      expect(anon.status, 'anonymous').toBe(401);
      // fresh sessions per case: endpoints such as logout-all must not invalidate the tokens of later cases
      const staff = await call(await token(w.uMaria), r);
      const manager = await call(await token(w.manager1), r);
      const admin = await call(await token(w.admin), r);
      const forbidden = (res: any) => res.status === 403 && res.body.error.code === 'FORBIDDEN';
      expect(admin.status, 'admin is never forbidden').not.toBe(403);
      expect(manager.status, 'manager').not.toBe(401);
      if (r.role === 'A') {
        expect(forbidden(staff), 'staff on admin endpoint').toBe(true);
        expect(forbidden(manager), 'manager on admin endpoint').toBe(true);
      } else if (r.role === 'M') {
        expect(forbidden(staff), 'staff on manager endpoint').toBe(true);
        expect(forbidden(manager), 'manager on manager endpoint').toBe(false);
      } else {
        // S: staff allowed at the role level (item-level rules may still answer 403/404 for foreign data)
        expect(staff.status, 'staff').not.toBe(401);
      }
      for (const res of [staff, manager, admin]) expect(res.status, 'no server error').toBeLessThan(500);
    });
  }
});
