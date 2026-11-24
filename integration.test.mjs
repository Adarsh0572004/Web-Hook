import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import express from 'express';
import { createReceiver } from './receiver.mjs';
import { createApp } from './app.mjs';
import { MongoStore } from './store.mjs';

const enabled = process.env.RELAY_INTEGRATION === '1';
test('worker crash after enrollment recovers the durable event exactly once at the receiver',
  { skip: !enabled, timeout: 90000 }, async t => {
    const dbName = 'relay_test_' + randomUUID().replaceAll('-', '');
    const mongo = new URL(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27127');
    mongo.pathname = '/' + dbName;
    const redis = process.env.TEST_REDIS || 'redis://127.0.0.1:16387';
    const client = await new MongoClient(mongo.href, { serverSelectionTimeoutMS: 3000 }).connect();
    const db = client.db();
    t.after(async () => { await db.dropDatabase(); await client.close(); });
    const store = new MongoStore(db.collection('events'));
    await store.init();
    const enrollments = db.collection('enrollments');
    const secret = randomUUID();
    const receiver = express();
    let acknowledgeFirst;
    const firstCommit = new Promise(resolve => { acknowledgeFirst = resolve; });
    let deliveries = 0;
    receiver.use((req, res, next) => {
      if (req.get('x-relay-signature') && ++deliveries === 1) {
        // Enrollment is committed. Hold the acknowledgement until the worker is killed.
        res.end = () => { acknowledgeFirst(); return res; };
      }
      next();
    });
    receiver.use(createReceiver(enrollments, secret));
    async function serve(app) {
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => { server.closeAllConnections(); server.close(); });
      return 'http://127.0.0.1:' + server.address().port;
    }
    const destination = await serve(receiver) + '/enroll';
    const api = await serve(createApp(store, secret));
    const body = JSON.stringify({ type: 'payment.succeeded', data: { course: 'mern' } });
    assert.equal((await fetch(destination, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
    const accepted = await fetch(api + '/events', { method: 'POST', body, headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + secret, 'idempotency-key': 'payment-001'
    } });
    assert.equal(accepted.status, 202);
    const connection = new Redis(redis, { maxRetriesPerRequest: 1 });
    const queue = new Queue(dbName, { connection });
    let child;
    async function killWorker() {
      if (!child || child.exitCode !== null || child.signalCode) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    t.after(async () => {
      await killWorker();
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    });
    function startWorker() {
      child = spawn(process.execPath, ['worker.mjs'], { cwd: import.meta.dirname, stdio: 'inherit',
        env: { ...process.env, MONGODB_URI: mongo.href, REDIS_URL: redis, RELAY_QUEUE: dbName,
          SIGNING_SECRET: secret, RECEIVER_URL: destination } });
    }
    startWorker();
    await firstCommit;
    await killWorker();
    assert.equal(await enrollments.countDocuments(), 1);
    assert.equal((await store.get('payment-001')).status, 'pending');
    startWorker();
    const deadline = Date.now() + 60000;
    while ((await store.get('payment-001')).status !== 'delivered') {
      assert.ok(Date.now() < deadline, 'redelivery deadline exceeded');
      await delay(250);
    }
    assert.equal(deliveries, 2);
    assert.equal(await enrollments.countDocuments(), 1);
  });
