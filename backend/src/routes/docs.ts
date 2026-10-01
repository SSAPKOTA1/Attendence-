import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

export const docsRouter = Router();

function specPath(): string {
  const a = path.resolve(__dirname, '..', '..', 'openapi.yaml');
  return fs.existsSync(a) ? a : path.resolve(__dirname, '..', '..', '..', 'openapi.yaml');
}

docsRouter.get('/docs/openapi.yaml', (_req, res) => {
  res.type('application/yaml').send(fs.readFileSync(specPath(), 'utf8'));
});

docsRouter.get('/docs', (_req, res) => {
  res
    .set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data:")
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>Shift Scheduler API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: './docs/openapi.yaml', dom_id: '#ui' });</script></body></html>`);
});
