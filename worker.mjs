import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { openDatabase } from './database.mjs';
import { deliverOne } from './delivery.mjs';

const { REDIS_URL, RECEIVER_URL, SIGNING_SECRET } = process.env;
if (!REDIS_URL || !SIGNING_SECRET) throw new Error('Set REDIS_URL and SIGNING_SECRET');
const url = new URL(RECEIVER_URL);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
  throw new Error('Use HTTPS or a loopback test receiver');
}
const { client, store } = await openDatabase();
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const name = process.env.RELAY_QUEUE || 'relay-delivery';
const queue = new Queue(name, { connection });
// A persistent scheduled scan closes the gap between MongoDB acceptance and Redis availability.
await queue.upsertJobScheduler('pending-scan', { every: 1000 }, {
  name: 'scan', opts: { removeOnComplete: 10, removeOnFail: 50 }
});
const worker = new Worker(name, async () => {
  for (let n = 0; n < 20; n++) {
    if (!await deliverOne(store, url, Date.now, SIGNING_SECRET)) break;
  }
}, { connection });
worker.on('error', err => console.error('Worker error', err.name));
worker.on('failed', job => console.error('Scan failed', job?.id));
async function stop() {
  await worker.close();
  await queue.close();
  await connection.quit();
  await client.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
