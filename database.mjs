import { MongoClient } from 'mongodb';
import { MongoStore } from './store.mjs';
export async function openDatabase() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI');
  const client = await new MongoClient(process.env.MONGODB_URI).connect();
  const store = new MongoStore(client.db().collection('events'));
  await store.init();
  return { client, store };
}
