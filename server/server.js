// server.js — improved: health, root, static serving, FRONTEND_ORIGIN, defensive logging
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const server = createServer(app);

// Configuration (env-friendly)
const PORT = process.env.PORT || 4000;
const DEBUG_MONGO_TLS = (process.env.DEBUG_MONGO_TLS || 'false').toLowerCase() === 'true';
const SPOC_PIN = process.env.SPOC_PIN || 'innovex25';
const TEST_TOKEN = process.env.TEST_TOKEN || 'changeme_test_token';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'; // used for CORS and socket origins
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public'); // serve frontend if present

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
  console.error('FATAL: MONGODB_URI is empty. Add it to your .env or Render environment variables.');
  process.exit(1);
}
if (!MONGODB_URI.startsWith('mongodb://') && !MONGODB_URI.startsWith('mongodb+srv://')) {
  console.error('FATAL: MONGODB_URI must start with "mongodb://" or "mongodb+srv://".');
  process.exit(1);
}
console.log('Mongo URI:', maskUri(MONGODB_URI).slice(0, 160));

/* -------------------------
   Basic middleware & CORS
   ------------------------- */
app.use(express.json());

// CORS: allow explicit FRONTEND_ORIGIN or allow all during local dev
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow server-to-server or CLI requests
    if (FRONTEND_ORIGIN === '*' || origin === FRONTEND_ORIGIN || origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};
app.use(cors(corsOptions));

/* -------------------------
   Socket.IO setup
   ------------------------- */
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: true,
  },
});

/* -------------------------
   Mongo client state + helper
   ------------------------- */
let db = null;
let requestsCollection = null;
let mongoClient = null;

async function tryConnect(options = {}) {
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

async function connectDB() {
  const baseOptions = {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  };

  if (DEBUG_MONGO_TLS) {
    console.warn('DEBUG_MONGO_TLS=true — using relaxed TLS validation (development only).');
    const fallbackOptions = {
      ...baseOptions,
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
    };
    mongoClient = await tryConnect(fallbackOptions);
    console.warn('Connected to MongoDB (insecure debug mode).');
    db = mongoClient.db('team-service-request');
    requestsCollection = db.collection('requests');
    return;
  }

  try {
    mongoClient = await tryConnect(baseOptions);
    console.log('Connected to MongoDB (secure).');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const isTLSError = /TLS|tls|SSL|ssl|tlsv1 alert|ERR_SSL|ssl3_read_bytes/i.test(msg);

    if (isTLSError) {
      console.warn('TLS handshake issue detected. Retrying with relaxed TLS validation (development-only).');
      try {
        const fallbackOptions = {
          ...baseOptions,
          tls: true,
          tlsAllowInvalidCertificates: true,
          tlsAllowInvalidHostnames: true,
        };
        mongoClient = await tryConnect(fallbackOptions);
        console.warn('Connected to MongoDB using insecure TLS fallback. WARNING: certificate validation disabled.');
      } catch (err2) {
        console.error('TLS fallback also failed:', err2 && err2.message ? err2.message : err2);
        throw err2;
      }
    } else {
      throw err;
    }
  }

  db = mongoClient.db('team-service-request');
  requestsCollection = db.collection('requests');
}

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
   SPOC in-memory token store
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
   Auth middleware (SPOC)
   ------------------------- */
function requireSpoc(req, res, next) {
  try {
    const token = req.header('x-spoc-token') || req.body?.spocToken;
    if (token && isValidSpocToken(token)) {
      req.spocTokenInfo = spocTokens.get(token);
      return next();
    }

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
   Serve static frontend if present
   ------------------------- */
if (STATIC_DIR && require('fs').existsSync(STATIC_DIR)) {
  console.log('Serving static files from', STATIC_DIR);
  app.use(express.static(STATIC_DIR));
  // SPA fallback: serve index.html for unknown GETs (useful for client-side routing)
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(STATIC_DIR, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

/* -------------------------
   Health + root routes
   ------------------------- */
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), env: process.env.NODE_ENV || 'development' });
});

app.get('/', (req, res) => {
  res.send('API is running. Visit the frontend for UI.');
});

/* -------------------------
   Main API routes
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
    if (!location) return res.status(400).json({ error: 'Location is required' });

    const newRequest = {
      requester: requester || '',
      category,
      details: details || '',
      location,
      quantity: quantity || '',
      teamId: teamId || null,
      spocId: spocId || null,
      status: 'pending',
      createdAt: new Date(),
    };
    const result = await requestsCollection.insertOne(newRequest);
    const insertedRequest = { ...newRequest, _id: result.insertedId };

    io.emit('request:created', insertedRequest);
    if (insertedRequest.spocId) io.to(`spoc:${insertedRequest.spocId}`).emit('request:created:forSpoc', insertedRequest);
    if (insertedRequest.teamId) io.to(`team:${insertedRequest.teamId}`).emit('request:created:forTeam', insertedRequest);

    res.status(201).json(insertedRequest);
  } catch (error) {
    console.error('POST /api/requests error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/requests/:id', requireSpoc, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const result = await requestsCollection.updateOne({ _id: new ObjectId(id) }, { $set: updates });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Request not found' });

    const updatedRequest = await requestsCollection.findOne({ _id: new ObjectId(id) });
    io.emit('request:updated', updatedRequest);
    if (updatedRequest.spocId) io.to(`spoc:${updatedRequest.spocId}`).emit('request:updated', updatedRequest);
    if (updatedRequest.teamId) io.to(`team:${updatedRequest.teamId}`).emit('request:updated', updatedRequest);
    res.json(updatedRequest);
  } catch (error) {
    console.error('PATCH /api/requests/:id error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/requests/:id', requireSpoc, async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await requestsCollection.findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ error: 'Request not found' });

    const result = await requestsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Request not found' });

    io.emit('request:deleted', { _id: id });
    if (doc.spocId) io.to(`spoc:${doc.spocId}`).emit('request:deleted', { _id: id });
    if (doc.teamId) io.to(`team:${doc.teamId}`).emit('request:deleted', { _id: id });

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /api/requests/:id error:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error.message });
  }
});

/* -------------------------
   SPOC unlock endpoint
   ------------------------- */
app.post('/api/spoc/unlock', (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ error: 'PIN required' });

    if (pin === SPOC_PIN) {
      const token = generateSpocToken(60 * 15);
      return res.json({ token, expiresIn: 60 * 15, method: 'pin' });
    }

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
  if (!provided || provided !== TEST_TOKEN) return res.status(403).json({ error: 'Forbidden: x-test-token required' });
  try {
    const result = await mongoClient.db('admin').command({ ping: 1 });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('GET /api/_test-mongo error:', err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

/* -------------------------
   Socket.IO behavior
   ------------------------- */
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });

  socket.on('spoc:join', (spocId) => {
    try {
      if (typeof spocId === 'string' && spocId.length) {
        socket.join(`spoc:${spocId}`);
        console.log(`Socket ${socket.id} joined spoc:${spocId}`);
      }
    } catch (e) { console.warn(e); }
  });

  socket.on('spoc:leave', (spocId) => {
    try { socket.leave(`spoc:${spocId}`); } catch (e) {}
  });

  socket.on('team:join', (teamId) => {
    try {
      if (typeof teamId === 'string' && teamId.length) {
        socket.join(`team:${teamId}`);
        console.log(`Socket ${socket.id} joined team:${teamId}`);
      }
    } catch (e) { console.warn(e); }
  });

  socket.on('team:leave', (teamId) => {
    try { socket.leave(`team:${teamId}`); } catch (e) {}
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
