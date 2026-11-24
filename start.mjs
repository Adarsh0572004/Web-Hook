import { workspaceAccess } from './access.mjs';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from './database.mjs';
import { createApp } from './app.mjs';
import { DemoStore } from './store.mjs';
import { deliverOne } from './delivery.mjs';

const publicDemo = process.argv.includes('--public-demo');
const demo = publicDemo || process.argv.includes('--demo');
let store, destination, key, access;
if (demo) {
  const receiver = express();
  const calls = new Map();
  receiver.post('/', (req, res) => {
    const id = req.get('x-event-id');
    const n = (calls.get(id) || 0) + 1;
    calls.set(id, n);
    res.sendStatus(n < 3 ? 503 : 204);
  });
  const server = receiver.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
  destination = 'http://127.0.0.1:' + server.address().port;
  store = new DemoStore();
  store.accept({ _id: 'sample-enrollment', body: JSON.stringify({ type: 'payment.succeeded', data: { course: 'mern' } }),
    status: 'pending', attempts: [], due: Date.now(), lease: null });
  key = randomBytes(24).toString('hex');
  if (!publicDemo) console.log('Local demo bearer key:', key);
} else {
  key = process.env.RELAY_API_KEY;
  const database = await openDatabase();
  store = database.store;
  if (process.env.JWT_SECRET) access = await workspaceAccess(database.client.db(), process.env.JWT_SECRET,
    { secure: process.env.NODE_ENV === 'production' || process.env.RELAY_LOCAL_HTTP !== '1' });
}
const port = Number(process.env.PORT || 4100);
createApp(store, key, access, { publicDemo }).listen(port, demo && !publicDemo ? '127.0.0.1' : '0.0.0.0', () => console.log('Relay listening on port', port));
while (demo) {
  try { if (await deliverOne(store, destination)) continue; }
  catch { console.error('Worker storage operation failed. Retrying.'); }
  await delay(400);
}




