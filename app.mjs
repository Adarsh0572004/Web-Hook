import { fileURLToPath } from 'node:url';
import express from 'express';
import { allow } from './access.mjs';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();

export function createApp(store, apiKey, access, { publicDemo = false } = {}) {
  if (!apiKey && !access && !publicDemo) throw new Error('A relay API key is required');
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/console-mode', (_req, res) => res.json({ publicDemo }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(fileURLToPath(new URL('./dist/', import.meta.url))));
  access?.mount(app);
  app.use('/events', access?.authenticate || ((req, res, next) => {
    if (publicDemo) {
      req.actor = { role: 'viewer' };
      return next();
    }
    if (!timingSafeEqual(digest(req.get('authorization') || ''), digest('Bearer ' + apiKey))) {
      return res.sendStatus(401);
    }
    req.actor = { role: 'legacy' };
    next();
  }));
  const storageId = (req, id) => req.actor.workspace ? req.actor.workspace + ':' + id : id;
  app.use('/events', rateLimit({ windowMs: 60000, limit: 180, keyGenerator: req => req.actor.workspace || 'legacy' }));
  app.param('id', (req, res, next, id) => /^[\w-]{1,100}$/.test(id) ? next() : res.sendStatus(404));
  app.post('/events', allow('producer', 'legacy'), async (req, res) => {
    const { type, data } = req.body ?? {};
    const key = req.get('Idempotency-Key') || '';
    if (!/^[\w-]{1,100}$/.test(key) || typeof type !== 'string' ||
        !/^[a-z][a-z0-9_.-]{0,79}$/.test(type) || !data ||
        Array.isArray(data) || typeof data !== 'object') {
      return res.status(400).json({ error: 'Supply an Idempotency-Key, event type and data object' });
    }
    const body = JSON.stringify({ type, data });
    const event = await store.accept({ _id: storageId(req, key), ...(access && { deliveryId: randomUUID() }), body, status: 'pending', attempts: [],
      due: Date.now(), lease: null });
    if (event.body !== body) return res.status(409).json({ error: 'Key already used for another payload' });
    res.location('/events/' + key).status(202).json({ id: key, status: event.status });
  });
  app.get('/events', allow('viewer', 'operator', 'legacy'), async (req, res) => {
    const { after = '', limit = '25' } = req.query;
    if (typeof after !== 'string' || !/^[\w-]{0,100}$/.test(after) ||
        typeof limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) return res.sendStatus(400);
    const prefix = req.actor.workspace ? req.actor.workspace + ':' : '';
    const rows = await store.list(prefix, after, Number(limit) + 1);
    const items = rows.slice(0, Number(limit)).map(row => ({
      id: row._id.slice(prefix.length), status: row.status, attempts: row.count
    }));
    res.set('Cache-Control', 'no-store').json({ items, role: req.actor.role,
      workspace: req.actor.workspace || 'Local demo', next: rows.length > items.length ? items.at(-1).id : null });
  });
  app.get('/events/:id', allow('viewer', 'operator', 'legacy'), async (req, res) => {
    const event = await store.get(storageId(req, req.params.id));
    if (!event) return res.sendStatus(404);
    res.json({ id: req.params.id, status: event.status, attempts: event.attempts, replays: event.replays || [] });
  });
  app.post('/events/:id/replay', allow('operator'), async (req, res) => {
    const id = storageId(req, req.params.id);
    const event = await store.replay(id, req.actor.id);
    if (event) return res.status(202).json({ id: req.params.id, status: event.status });
    res.sendStatus(await store.get(id) ? 409 : 404);
  });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.status === 413 ? 'Payload too large' :
      err.status === 400 ? 'Invalid JSON' : 'Request failed' });
  });
  return app;
}



