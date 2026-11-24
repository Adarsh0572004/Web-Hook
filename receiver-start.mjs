import { openDatabase } from './database.mjs';
import { createReceiver } from './receiver.mjs';
const { client } = await openDatabase();
const app = createReceiver(client.db().collection('enrollments'), process.env.SIGNING_SECRET);
app.listen(Number(process.env.RECEIVER_PORT || 4101), '127.0.0.1');
