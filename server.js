const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { registerHexlandsGame } = require('./hexlands');
const { registerGolfGame } = require('./golf');
const { registerImpostorGame } = require('./impostor');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Must allow ANY origin including file:// (which sends origin: null).
// This is safe for a private game server.
const allowAnyOrigin = (origin, callback) => callback(null, true);

app.use(cors({ origin: allowAnyOrigin, methods: ['GET','POST','OPTIONS'], credentials: true }));
app.options('*', cors({ origin: allowAnyOrigin }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowAnyOrigin,
    methods: ['GET','POST'],
    credentials: true,
  },
  // Support both transports — polling works when WebSocket is blocked
  transports: ['polling', 'websocket'],
});

// ─── Mount Games ──────────────────────────────────────────────────────────────
registerHexlandsGame(io.of('/hexlands'));
registerGolfGame(io.of('/golf'));
registerImpostorGame(io.of('/impostor'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', games: ['hexlands'] }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server running on port ${PORT}`));
