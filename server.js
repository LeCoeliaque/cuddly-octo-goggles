const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const { registerHexlandsGame } = require('./hexlands');
const { registerGolfGame } = require('./golf');
const { registerImpostorGame } = require('./impostor');
// const { registerGnominGame } = require('./gnomin'); // uncomment when ready

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Mount Games ──────────────────────────────────────────────────────────────
// Each game uses a socket.io namespace to keep events isolated
registerHexlandsGame(io.of('/hexlands'));
registerGolfGame(io.of('/golf'));
registerImpostorGame(io.of('/impostor'));
// registerGnominGame(io.of('/gnomin'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', games: ['hexlands', 'golf', 'impostor'] });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server running on port ${PORT}`));
