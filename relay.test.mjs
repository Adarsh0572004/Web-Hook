import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from './app.mjs';
import { DemoStore } from './store.mjs';
import { deliverOne } from './delivery.mjs';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('authenticated intake, conflicting retries and recovery over HTTP', async t => {
  const store = new DemoStore();
  const api = await listen(t, createApp(store, 'example'));
  const headers = { authorization: 'Bearer example', 'content-type': 'application/json', 'idempotency-key': 'evt1' };
  const post = type => fetch(api + '/events', { method: 'POST', headers, body: JSON.stringify({ type, data: {} }) });
  assert.equal((await fetch(api + '/events/evt1')).status, 401);
  assert.equal((await post('invalid type')).status, 400);
  for (const res of await Promise.all([post('payment.ok'), post('payment.ok')])) assert.equal(res.status, 202);
  assert.equal((await post('different')).status, 409);
  const ids = [];
  const receiver = await listen(t, (req, res) => {
    ids.push(req.headers['x-event-id']);
    res.writeHead(ids.length < 3 ? 503 : 204).end();
  });
  let now = Date.now();
  for (let i = 0; i < 3; i++) {
    assert.equal(await deliverOne(store, receiver, () => now), true);
    assert.equal(await deliverOne(store, receiver, () => now), false);
    now += 5000;
  }
  const event = await (await fetch(api + '/events/evt1', { headers })).json();
  assert.equal(event.status, 'delivered');
  assert.deepEqual(event.attempts.map(a => a.httpStatus), [503, 503, 204]);
  assert.deepEqual(ids, ['evt1', 'evt1', 'evt1']);
});

test('expired lease can be reclaimed and a stale worker cannot finalize it', () => {
  const store = new DemoStore();
  store.accept({ _id: 'evt', status: 'pending', due: 0, attempts: [] });
  const first = store.claim(0, 'first');
  assert.equal(store.claim(100, 'second'), null);
  const second = store.claim(30000, 'second');
  store.finish(first, {}, 'failed', 0);
  assert.equal(store.get('evt').status, 'pending');
  store.finish(second, {}, 'delivered', 0);
  assert.equal(store.get('evt').attempts.length, 1);
});

test('public showcase exposes sample reads and rejects anonymous writes', async t => {
  const store = new DemoStore();
  store.accept({ _id: 'sample', status: 'pending', attempts: [] });
  const api = await listen(t, createApp(store, null, null, { publicDemo: true }));
  assert.equal((await fetch(api + '/healthz')).status, 200);
  assert.deepEqual(await (await fetch(api + '/console-mode')).json(), { publicDemo: true });
  assert.equal((await (await fetch(api + '/events/sample')).json()).id, 'sample');
  for (const path of ['/events', '/events/sample/replay']) {
    assert.equal((await fetch(api + path, { method: 'POST' })).status, 403);
  }
});
