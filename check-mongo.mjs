import { MongoClient } from 'mongodb';
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI in .env or the process environment');
let client;
try {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  await client.db().command({ ping: 1 });
  console.log('MongoDB connection verified.');
} catch {
  console.error('MongoDB connection failed. Check the project URI, credentials and network access.');
  process.exitCode = 1;
} finally { await client?.close(); }
