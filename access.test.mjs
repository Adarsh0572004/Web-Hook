import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { createApp } from './app.mjs';
import { MongoStore } from './store.mjs';
import { provision, workspaceAccess } from './access.mjs';

test('workspace roles, tenant isolation, audited replay, key revocation and session rotation',
  { skip: process.env.RELAY_INTEGRATION !== '1' }, async t => {
    const client = await new MongoClient(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27127').connect();
    const db = client.db('relay_access_test_' + randomUUID().replaceAll('-', ''));
    t.after(async () => { await db.dropDatabase(); await client.close(); });
    const store = new MongoStore(db.collection('events'));
    const access = await workspaceAccess(db, randomUUID());
    const server = createApp(store, undefined, access).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const base = 'http://127.0.0.1:' + server.address().port;
    const password = randomUUID();
    async function member(workspace, role) {
      await provision(db, workspace, role, role, password);
      const res = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, username: role, password }) });
      assert.equal(res.status, 200);
      const cookie = res.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Secure/);
      return { jwt: (await res.json()).accessToken, cookie: cookie.split(';')[0] };
    }
    const op = await member('a', 'operator');
    const viewer = await member('a', 'viewer');
    const other = await member('b', 'operator');
    const request = (path, bearer, method = 'GET', body) => fetch(base + path, { method,
      headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'idempotency-key': 'evt' },
      body: body && JSON.stringify(body) });
    const loginCookie = (path, cookie) => fetch(base + '/auth/' + path, { method: 'POST', headers: { cookie } });
    const producer = await (await request('/keys', op.jwt, 'POST')).json();
    const body = { type: 'payment.succeeded', data: { course: 'mern' } };
    assert.equal((await request('/events', producer.key, 'POST', body)).status, 202);
    assert.equal((await request('/events/evt', viewer.jwt)).status, 200);
    assert.equal((await request('/events/evt', producer.key)).status, 403);
    assert.equal((await request('/events/evt', other.jwt)).status, 404);
    assert.equal((await request('/events/evt/replay', other.jwt, 'POST')).status, 404);
    assert.equal((await request('/events/evt/replay', viewer.jwt, 'POST')).status, 403);
    assert.equal((await request('/events/evt/replay', op.jwt, 'POST')).status, 409);
    await db.collection('events').updateOne({ _id: 'a:evt' }, { $set: { status: 'failed' } });
    const replays = await Promise.all([1, 2].map(() => request('/events/evt/replay', op.jwt, 'POST')));
    assert.deepEqual(replays.map(r => r.status).sort(), [202, 409]);
    assert.equal((await store.get('a:evt')).replays[0].actor, 'operator');
    const producerB = await (await request('/keys', other.jwt, 'POST')).json();
    assert.equal((await request('/events', producerB.key, 'POST', body)).status, 202);
    assert.notEqual((await store.get('a:evt')).deliveryId, (await store.get('b:evt')).deliveryId);
    assert.equal((await request('/keys/' + producer.id, op.jwt, 'DELETE')).status, 204);
    assert.equal((await request('/events', producer.key, 'POST', body)).status, 401);
    const rotated = await loginCookie('refresh', op.cookie);
    assert.equal(rotated.status, 200);
    assert.equal((await loginCookie('refresh', op.cookie)).status, 401);
    assert.equal((await loginCookie('logout', rotated.headers.get('set-cookie').split(';')[0])).status, 204);
    assert.equal((await request('/events/evt', op.jwt)).status, 401);
  });
