const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { registerHexlandsGame } = require('./hexlands');
// const { registerGolfGame } = require('./golf');
// const { registerImpostorGame } = require('./impostor');

const app = express();

// ─── CORS — set on every response before anything else ───────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ─── Serve game HTML pages directly ──────────────────────────────────────────
// Players just visit https://your-render-url.onrender.com/hexlands
// No WordPress, no file://, no CORS issues ever.
app.get('/hexlands', (req, res) => {
  res.sendFile(path.join(__dirname, 'hexlands.html'));
});


const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Mount game namespaces ────────────────────────────────────────────────────
registerHexlandsGame(io.of('/hexlands'));
// registerGolfGame(io.of('/golf'));
// registerImpostorGame(io.of('/impostor'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', games: ['hexlands'] }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server on port ${PORT}`));
