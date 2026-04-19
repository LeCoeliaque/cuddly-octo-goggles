const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { registerHexlandsGame } = require('./hexlands');
const { registerGolfGame } = require('./golf');
const { registerImpostorGame } = require('./impostor');

const app = express();

// ─── CORS on every response ───────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ─── Serve game pages ─────────────────────────────────────────────────────────
// Players visit /hexlands directly — no WordPress or file:// needed
app.get('/hexlands', (req, res) => {
  res.sendFile(path.join(__dirname, 'hexlands.html'));
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // polling only — required for Render free tier (no WebSocket support)
  transports: ['polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Mount game namespaces ────────────────────────────────────────────────────
registerHexlandsGame(io.of('/hexlands'));
registerGolfGame(io.of('/golf'));
registerImpostorGame(io.of('/impostor'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', games: ['hexlands', 'golf', 'impostor'] }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server on port ${PORT}`));
