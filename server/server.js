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
const TEST_TOKEN = process.env.TEST_TOKEN;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'; // used for CORS and socket origins
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public'); // serve frontend if present

/* -------------------------
   Load & sanitize MONGODB_URI
   ------------------------- */
let rawUri = process.env.MONGODB_URI || process.env.MONGO_URI || '';
if (typeof rawUri === 'string') {
  rawUri = rawUri.replace(/^\s*[\']?/, '').replace(/[\']?\s*$/, '').trim();
}
const MONGODB_URI = rawUri;

function maskUri(uri = '') {
  try {
    return uri.replace(///.*@/, '//<hidden>@');
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
