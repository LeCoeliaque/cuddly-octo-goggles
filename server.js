const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { registerHexlandsGame } = require('./hexlands');
const { registerGolfGame } = require('./golf');
const { registerImpostorGame } = require('./impostor');

const app = express();

// ─── CORS middleware — runs on EVERY response including errors ────────────────
// Must be the very first middleware so even 503/404 responses get the header.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, true),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Mount Games ──────────────────────────────────────────────────────────────
registerHexlandsGame(io.of('/hexlands'));
registerGolfGame(io.of('/golf'));
registerImpostorGame(io.of('/impostor'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', games: ['hexlands'] }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server running on port ${PORT}`));
