// server.js — updated: TLS-fallback + SPOC token mapping + defensive logging + targeted emits
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", // Vite dev server
    methods: ["GET", "POST", "PATCH", "DELETE"]
  }
});

const PORT = process.env.PORT || 4000;

/* -------------------------
   Load & sanitize MONGODB_URI
   ------------------------- */
let rawUri = process.env.MONGODB_URI || process.env.MONGO_URI || '';
if (typeof rawUri === 'string') {
  rawUri = rawUri.replace(/^\s*["']?/, '').replace(/["']?\s*$/, '').trim();
}
const MONGODB_URI = rawUri;

function maskUri(uri = '') {
  try {
    return uri.replace(/\/\/.*@/, '//<hidden>@');
  } catch (e) {
    return '<invalid-uri>';
  }
}

if (!MONGODB_URI) {
  console.error('FATAL: MONGODB_URI is empty. Add a line to your .env:');
  console.error('  MONGODB_URI=mongodb+srv://<USER>:<PASSWORD>@<CLUSTER>.mongodb.net/<DB_NAME>?retryWrites=true&w=majority');
  process.exit(1);
}
if (!MONGODB_URI.startsWith('mongodb://') && !MONGODB_URI.startsWith('mongodb+srv://')) {
  console.error('FATAL: MONGODB_URI must start with "mongodb://" or "mongodb+srv://".');
  console.error('Value preview:', JSON.stringify(MONGODB_URI).slice(0, 200));
  process.exit(1);
}

console.log('Mongo URI:', maskUri(MONGODB_URI).slice(0, 160));

/* -------------------------
   Config & env helpers
   ------------------------- */
const DEBUG_MONGO_TLS = (process.env.DEBUG_MONGO_TLS || 'false').toLowerCase() === 'true';
const SPOC_PIN = process.env.SPOC_PIN || 'innovex25';
const TEST_TOKEN = process.env.TEST_TOKEN || 'changeme_test_token';

/* -------------------------
   Mongo client state + helper
   ------------------------- */
let db = null;
let requestsCollection = null;
let mongoClient = null;

/**
 * tryConnect: helper to attempt a connection using provided options.
 * Throws on failure (caller will decide how to handle).
 */
async function tryConnect(options = {}, label = 'connect') {
  const client = new MongoClient(MONGODB_URI, options);
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch (err) {
    try { await client.close(); } catch (e) {}
    throw err;
  }
}

/**
 * connectDB: try secure connect first; if TLS handshake error detected,
 * retry once with relaxed TLS validation (development fallback).
 *
 * SECURITY: relaxed TLS disables certificate validation. ONLY use for local dev.
 */
async function connectDB() {
  const baseOptions = {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  };

  // If DEBUG_MONGO_TLS env is set to true, skip the first secure try and go directly
  // to relaxed mode (useful if you already know you need it).
  if (DEBUG_MONGO_TLS) {
    console.warn('DEBUG_MONGO_TLS=true — using relaxed TLS validation (development only).');
    const fallbackOptions = {
      ...baseOptions,
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true
    };
    mongoClient = await tryConnect(fallbackOptions, 'insecure-debug');
    console.log('Connected to MongoDB (insecure debug mode).');
    db = mongoClient.db('team-service-request');
    requestsCollection = db.collection('requests');
    return;
  }

  // try secure connect first
  try {
    mongoClient = await tryConnect(baseOptions, 'secure');
    console.log('Connected to MongoDB (secure).');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const isTLSError =
      /TLS|tls|SSL|ssl|tlsv1 alert|ERR_SSL|ssl3_read_bytes/i.test(msg);

    if (isTLSError) {
      console.warn('TLS handshake issue detected when connecting to MongoDB.');
      console.warn('Retrying with relaxed TLS validation (development-only).');
      // attempt insecure fallback
      try {
        const fallbackOptions = {
          ...baseOptions,
          tls: true,
          tlsAllowInvalidCertificates: true,
          tlsAllowInvalidHostnames: true
        };
        mongoClient = await tryConnect(fallbackOptions, 'insecure-fallback');
        console.warn('Connected to MongoDB using insecure TLS fallback. WARNING: certificate validation disabled.');
      } catch (err2) {
        console.error('TLS fallback also failed:', err2 && err2.message ? err2.message : err2);
        throw err2;
      }
    } else {
      // rethrow non-TLS error for retry/backoff logic
      throw err;
    }
  }

  db = mongoClient.db('team-service-request');
  requestsCollection = db.collection('requests');
}

/* connectDBWithRetry with exponential backoff */
async function connectDBWithRetry({ attempts = 3, backoffMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await connectDB();
      return;
    } catch (err) {
      console.error(`MongoDB connect attempt ${i} failed:`, err && err.message ? err.message : err);
      if (i < attempts) {
        console.log(`Retrying in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs *= 2;
      } else {
        console.error('All MongoDB connection attempts failed.');
        throw err;
      }
    }
  }
}

/* -------------------------
   Middleware
   ------------------------- */
app.use(cors());
app.use(express.json());

/* -------------------------
   SPOC token store (in-memory)
   token -> { expiresAt, spocId? }
   ------------------------- */
const spocTokens = new Map();

function generateSpocToken(ttlSeconds = 600, spocId = undefined) {
  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = Date.now() + ttlSeconds * 1000;
  spocTokens.set(token, { expiresAt, spocId });
  setTimeout(() => spocTokens.delete(token), ttlSeconds * 1000 + 5000);
  return token;
}

function isValidSpocToken(token) {
  if (!token) return false;
  const entry = spocTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    spocTokens.delete(token);
    return false;
  }
  return true;
}

/* -------------------------
   Auth middleware for SPOC-protected routes
   - Checks x-spoc-token and optionally matches spocId if present.
   - Dev fallback: accept x-spoc-pin header equal to SPOC_PIN
------------------------- */
function requireSpoc(req, res, next) {
  try {
    const token = req.header('x-spoc-token') || req.body?.spocToken;
    if (token && isValidSpocToken(token)) {
      // Optionally attach token info to request for further checks
      const info = spocTokens.get(token);
      req.spocTokenInfo = info;
      return next();
    }

    // Dev fallback: allow direct pin in header (only for development convenience)
    const pinHeader = req.header('x-spoc-pin');
    if (pinHeader && pinHeader === SPOC_PIN) {
      console.warn('Development fallback: x-spoc-pin used to authorize request.');
      return next();
    }

    return res.status(403).json({ error: 'Forbidden: valid SPOC token required' });
  } catch (err) {
    console.error('requireSpoc error:', err);
    return res.status(500).json({ error: 'Server error in auth' });
  }
}

/* -------------------------
   Routes
   ------------------------- */
app.get('/api/requests', async (req, res) => {
  try {
    const requests = await requestsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(requests);
  } catch (error) {
    console.error('GET /api/requests error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/requests', async (req, res) => {
  try {
    const { requester, category, details, location, quantity, teamId, spocId } = req.body;
    if (!location) {
      return res.status(400).json({ error: 'Location is required' });
    }
    const newRequest = {
      requester: requester || '',
      category,
      details: details || '',
      location,
      quantity: quantity || '',
      teamId: teamId || null,
      spocId: spocId || null,
      status: 'pending',
      createdAt: new Date()
    };
    const result = await requestsCollection.insertOne(newRequest);
    const insertedRequest = { ...newRequest, _id: result.insertedId };

    // emit global event for legacy or admin viewers
    io.emit('request:created', insertedRequest);

    // targeted emits:
    if (insertedRequest.spocId) {
      // notify only the spoc(s) in that room
      io.to(`spoc:${insertedRequest.spocId}`).emit('request:created:forSpoc', insertedRequest);
    }
    if (insertedRequest.teamId) {
      // notify only team room
      io.to(`team:${insertedRequest.teamId}`).emit('request:created:forTeam', insertedRequest);
    }

    res.status(201).json(insertedRequest);
  } catch (error) {
    console.error('POST /api/requests error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

// PATCH requires SPOC token
app.patch('/api/requests/:id', requireSpoc, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const result = await requestsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const updatedRequest = await requestsCollection.findOne({ _id: new ObjectId(id) });

    // global notify
    io.emit('request:updated', updatedRequest);
    // targeted notify
    if (updatedRequest.spocId) io.to(`spoc:${updatedRequest.spocId}`).emit('request:updated', updatedRequest);
    if (updatedRequest.teamId) io.to(`team:${updatedRequest.teamId}`).emit('request:updated', updatedRequest);

    res.json(updatedRequest);
  } catch (error) {
    console.error('PATCH /api/requests/:id error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE requires SPOC token
app.delete('/api/requests/:id', requireSpoc, async (req, res) => {
  try {
    const { id } = req.params;

    // find document first to get teamId/spocId for targeted notifications
    const doc = await requestsCollection.findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Request not found' });

    const result = await requestsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // global notify
    io.emit('request:deleted', { _id: id });

    // targeted notify using the found doc
    if (doc.spocId) io.to(`spoc:${doc.spocId}`).emit('request:deleted', { _id: id });
    if (doc.teamId) io.to(`team:${doc.teamId}`).emit('request:deleted', { _id: id });

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /api/requests/:id error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

/* -------------------------
   SPOC unlock endpoint (server-side)
   Accepts either the server PIN or a SPOC id. Returns { token, expiresIn, spocId? }
------------------------- */
app.post('/api/spoc/unlock', (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ error: 'PIN required' });

    // If matches server PIN exactly, issue token (no spocId attached)
    if (pin === SPOC_PIN) {
      const token = generateSpocToken(60 * 15);
      return res.json({ token, expiresIn: 60 * 15, method: 'pin' });
    }

    // Treat the provided value as a SPOC id (development-friendly)
    const spocId = String(pin).trim();
    if (spocId.length === 0) return res.status(401).json({ error: 'Invalid PIN / SPOC id' });

    const token = generateSpocToken(60 * 15, spocId);
    return res.json({ token, expiresIn: 60 * 15, method: 'spocId', spocId });
  } catch (error) {
    console.error('POST /api/spoc/unlock error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'Server error' });
  }
});

/* -------------------------
   Test endpoint to ping Mongo (protected by TEST_TOKEN)
------------------------- */
app.get('/api/_test-mongo', async (req, res) => {
  const provided = req.header('x-test-token');
  if (!provided || provided !== TEST_TOKEN) {
    return res.status(403).json({ error: 'Forbidden: x-test-token required' });
  }
  try {
    const result = await mongoClient.db('admin').command({ ping: 1 });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('GET /api/_test-mongo error:', err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

/* -------------------------
   Socket.IO
------------------------- */
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id);
  });

  // allow spocs to join a room by spocId (so server can target them)
  socket.on('spoc:join', (spocId) => {
    try {
      if (typeof spocId === 'string' && spocId.length) {
        socket.join(`spoc:${spocId}`);
        console.log(`Socket ${socket.id} joined room spoc:${spocId}`);
      }
    } catch (e) { console.warn(e) }
  });

  socket.on('spoc:leave', (spocId) => {
    try { socket.leave(`spoc:${spocId}`) } catch (e) {}
  });

  // allow team room joins so members can observe team-only events
  socket.on('team:join', (teamId) => {
    try {
      if (typeof teamId === 'string' && teamId.length) {
        socket.join(`team:${teamId}`);
        console.log(`Socket ${socket.id} joined room team:${teamId}`);
      }
    } catch (e) { console.warn(e) }
  });
  socket.on('team:leave', (teamId) => {
    try { socket.leave(`team:${teamId}`) } catch (e) {}
  });
});

/* -------------------------
   Graceful shutdown
------------------------- */
async function gracefulShutdown() {
  console.log('Shutting down server...');
  try {
    if (mongoClient) {
      await mongoClient.close();
      console.log('MongoDB connection closed.');
    }
  } catch (err) {
    console.warn('Error closing Mongo client:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err && err.stack ? err.stack : err);
  gracefulShutdown();
});

/* -------------------------
   Start server (with retry)
------------------------- */
(async function startServer() {
  try {
    await connectDBWithRetry({ attempts: 3, backoffMs: 2000 });
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server due to DB connection error:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
