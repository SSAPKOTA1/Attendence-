import request from 'supertest';
import { createApp } from '../../src/app';

export const app = createApp();

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

function call(method: Method, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  let r = request(app)[method](`/api/v1${url}`);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  if (body !== undefined) r = r.send(body as any);
  return r;
}

export function as(token?: string, headers: Record<string, string> = {}) {
  return {
    get: (url: string, h: Record<string, string> = {}) => call('get', url, token, undefined, { ...headers, ...h }),
    post: (url: string, body?: unknown, h: Record<string, string> = {}) => call('post', url, token, body ?? {}, { ...headers, ...h }),
    patch: (url: string, body?: unknown, h: Record<string, string> = {}) => call('patch', url, token, body ?? {}, { ...headers, ...h }),
    put: (url: string, body?: unknown, h: Record<string, string> = {}) => call('put', url, token, body ?? {}, { ...headers, ...h }),
    delete: (url: string, h: Record<string, string> = {}) => call('delete', url, token, undefined, { ...headers, ...h }),
  };
}

export const anon = as();

export function device(token: string) {
  return as(undefined, { 'X-Device-Token': token });
}
