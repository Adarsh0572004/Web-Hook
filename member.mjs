import { openDatabase } from './database.mjs';
import { provision } from './access.mjs';
const [workspace, username, role] = process.argv.slice(2);
const { client } = await openDatabase();
try {
  await provision(client.db(), workspace, username, role, process.env.RELAY_MEMBER_PASSWORD);
  console.log('Workspace member created');
} finally { await client.close(); }
