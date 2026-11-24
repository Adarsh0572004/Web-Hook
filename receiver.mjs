import express from 'express';
import { validSignature } from './signature.mjs';

export function createReceiver(enrollments, secret) {
  if (!secret) throw new Error('Signing secret required');
  const app = express();
  app.post('/enroll', express.raw({ type: 'application/json', limit: '32kb' }), async (req, res) => {
    const id = req.get('x-event-id');
    if (!Buffer.isBuffer(req.body) || !validSignature(secret, id, req.get('x-relay-time'), req.body,
      req.get('x-relay-signature'))) return res.sendStatus(401);
    let event;
    try { event = JSON.parse(req.body); } catch { return res.sendStatus(400); }
    if (event?.type !== 'payment.succeeded' || typeof event.data?.course !== 'string') return res.sendStatus(422);
    try {
      await enrollments.insertOne({ _id: id, course: event.data.course, receivedAt: new Date() });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    res.sendStatus(204);
  });
  return app;
}
