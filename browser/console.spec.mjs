import { test, expect } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../app.mjs';
import { MongoStore } from '../store.mjs';
import { workspaceAccess, provision } from '../access.mjs';

test.use({ channel: process.env.RELAY_BROWSER || 'msedge' });
test('operator can page and replay; viewer sees live history and cannot replay', async ({ browser }) => {
  const mongo = await new MongoClient(process.env.TEST_MONGO || 'mongodb://127.0.0.1:27127').connect();
  const db = mongo.db('console_test_' + randomUUID().replaceAll('-', ''));
  let server;
  try {
    const password = randomUUID(), store = new MongoStore(db.collection('events'));
    const access = await workspaceAccess(db, randomUUID(), { secure: false });
    for (const role of ['viewer','operator']) await provision(db, 'campus', role, role, password);
    for (const prefix of ['campus','another']) {
      for (let i = 0; i < 26; i++) await store.accept({ _id: prefix + ':evt-' + String(i).padStart(2,'0'),
        status:'failed', attempts:[{ number:1, at:new Date().toISOString(), httpStatus:400 }] });
    }
    server = createApp(store, null, access).listen(0,'127.0.0.1');
    await once(server,'listening');
    async function login(role) {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port);
      for (const [field,value] of [['Workspace','campus'],['Username',role],['Password',password]]) {
        await page.getByLabel(field,{exact:true}).fill(value);
      }
      await page.getByRole('button',{name:'Sign in'}).click();
      await page.getByRole('button',{name:'Next',exact:true}).click();
      await expect(page.getByRole('button',{name:'Next',exact:true})).toBeDisabled();
      await page.getByRole('button',{name:'evt-25'}).click();
      await expect(page.getByText('Attempt 1')).toBeVisible();
      return page;
    }
    const viewer = await login('viewer');
    await expect(viewer.getByRole('button',{name:'Replay delivery'})).toHaveCount(0);
    const operator = await login('operator');
    await operator.getByRole('button',{name:'Replay delivery'}).click();
    await expect(operator.getByText(/Replay requested by operator/)).toBeVisible();
    await expect(viewer.getByText(/Replay requested by operator/)).toBeVisible({timeout:10000});
    await viewer.reload();
    await expect(viewer.getByRole('button',{name:'evt-00'})).toBeVisible();
    await viewer.getByRole('button',{name:'Sign out'}).click();
    await expect(viewer.getByLabel('Password')).toBeVisible();
    expect((await store.get('another:evt-25')).status).toBe('failed');
  } finally {
    if (server) { server.closeAllConnections(); server.close(); }
    await db.dropDatabase(); await mongo.close();
  }
});
