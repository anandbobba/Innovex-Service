// test-mongo.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = (process.env.MONGODB_URI || '').replace(/^\s*["']?/, '').replace(/["']?\s*$/, '').trim();
  console.log('URI preview:', uri ? uri.slice(0, 120) : '<empty>');
  if (!uri) return console.error('No MONGODB_URI found in .env');

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('Ping OK — MongoDB reachable');
  } catch (err) {
    console.error('CONNECT ERROR (full):', err);
  } finally {
    try { await client.close(); } catch (e) {}
  }
})();
