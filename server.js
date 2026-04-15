const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { registerImpostorGame } = require('./impostor');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Mount Impostor game ─────────────────────────────────────────────────────
registerImpostorGame(io);

// ─── Deck Builder ────────────────────────────────────────────────────────────
function buildDeck() {
  const cards = [];
  for (let n = 3; n <= 8; n++)
    for (let i = 0; i < 12; i++) cards.push({ type: 'number', value: n });

  for (let n = -1; n >= -4; n--)
    for (let i = 0; i < 5; i++) cards.push({ type: 'number', value: n });

  for (let i = 0; i < 3; i++) cards.push({ type: 'plus10', value: 10 });
  for (let i = 0; i < 3; i++) cards.push({ type: 'wild', value: null });

  return shuffle(cards);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function cardVal(c) {
  if (!c) return 0;
  if (c.type === 'wild') return c.wildValue ?? 0;
  return c.value;
}

function scoreLine(line) {
  const [a, b, c] = line.map(cardVal);
  if (a === b && b === c) return -Math.abs(a);

  const sorted = [a, b, c].sort((x, y) => x - y);
  if (sorted[1] - sorted[0] === 1 && sorted[2] - sorted[1] === 1)
    return -sorted[1];

  return a + b + c;
}

function scoreGrid(grid) {
  let total = 0;

  for (let r = 0; r < 3; r++) {
    total += scoreLine([grid[r*3], grid[r*3+1], grid[r*3+2]]);
  }

  for (let c = 0; c < 3; c++) {
    total += scoreLine([grid[c], grid[c+3], grid[c+6]]);
  }

  return total;
}

// Uses your ORIGINAL more accurate logic (not the simplified one)
function scoreKnown(grid, flipped) {
  let total = 0;
  grid.forEach((c, i) => {
    if (flipped[i]) total += cardVal(c);
  });
  return total;
}

// ─── Bounce Logic ────────────────────────────────────────────────────────────
function findMatches(player, value) {
  const matches = [];
  player.grid.forEach((c, i) => {
    if (player.flipped[i] && c && cardVal(c) === value) {
      matches.push(i);
    }
  });
  return matches;
}

// ─── Room State ──────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(id) {
  return {
    id,
    players: [],
    deck: [],
    discard1: [],
    discard2: [],
    phase: 'waiting',
    currentTurn: 0,
    finalTriggerPlayer: null,

    drawnCard: null,
    turnPhase: 'draw',

    plus10Pending: null,

    bounceCard: null,
    bounceChain: []
  };
}

function roomPublicState(room) {
  return {
    phase: room.phase,
    currentTurn: room.currentTurn,
    finalTriggerPlayer: room.finalTriggerPlayer,

    discard1Top: room.discard1.at(-1) || null,
    discard2Top: room.discard2.at(-1) || null,
    deckCount: room.deck.length,

    turnPhase: room.turnPhase,
    drawnCard: room.drawnCard,
    plus10Pending: room.plus10Pending,
    bounceCard: room.bounceCard,
    bounceChain: room.bounceChain,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      grid: p.grid.map((card, i) =>
        p.flipped[i] ? card : { type: 'hidden' }
      ),
      flipped: p.flipped,
      flippedCount: p.flipped.filter(Boolean).length,
      knownScore: scoreKnown(p.grid, p.flipped)
    }))
  };
}

// ─── Socket Handlers ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Golf] Connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.phase !== 'waiting') {
      socket.emit('error', 'Game already in progress');
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      grid: Array(9).fill(null),
      flipped: Array(9).fill(false)
    });

    socket.join(roomId);
    socket.data.roomId = roomId;

    io.to(roomId).emit('roomState', roomPublicState(room));
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.players.length < 2) return;

    room.deck = buildDeck();

    for (const p of room.players) {
      p.grid = room.deck.splice(0, 9);
      p.flipped = Array(9).fill(false);
    }

    room.discard1.push(room.deck.pop());
    room.discard2.push(room.deck.pop());

    room.phase = 'playing';
    room.currentTurn = 0;
    room.turnPhase = 'draw';
    room.bounceCard = null;
    room.bounceChain = [];

    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  socket.on('draw', ({ source }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.turnPhase !== 'draw') return;

    const player = room.players[room.currentTurn];
    if (player.id !== socket.id) return;

    let card;

    if (source === 'deck') {
      if (!room.deck.length) reshuffleDeck(room);
      card = room.deck.pop();
    } else {
      const pile = source === 'discard2' ? 'discard2' : 'discard1';
      if (!room[pile].length) return;
      card = room[pile].pop();
    }

    room.drawnCard = { card, source };
    room.turnPhase = 'place';

    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  socket.on('placeCard', ({ gridIndex, discard, discardPile, wildValue }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;

    const player = room.players[room.currentTurn];
    if (player.id !== socket.id) return;

    const activeCard =
      room.turnPhase === 'bounce'
        ? room.bounceCard
        : room.drawnCard?.card;

    if (!activeCard) return;

    if (discard) {
      const pile = discardPile === 2 ? 'discard2' : 'discard1';

      room[pile].push(activeCard);
      room.drawnCard = null;
      room.bounceCard = null;
      room.bounceChain = [];

      room.turnPhase = 'draw';
      advanceTurn(room);
      io.to(room.id).emit('roomState', roomPublicState(room));
      return;
    }

    if (activeCard.type === 'wild') {
      if (wildValue == null) {
        socket.emit('needWildValue');
        return;
      }
      activeCard.wildValue = parseInt(wildValue);
    }

    const displaced = player.grid[gridIndex];
    const wasFlipped = player.flipped[gridIndex];

    player.grid[gridIndex] = activeCard;
    player.flipped[gridIndex] = true;

    room.drawnCard = null;
    room.bounceCard = null;

    if (displaced) {
      if (!wasFlipped) {
        // CRITICAL: keep your original reveal chain logic
        room.bounceCard = displaced;
        room.turnPhase = 'bounce';
        room.bounceChain.push(`?→${cardVal(displaced)}`);

        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }

      const val = cardVal(displaced);
      const matches = findMatches(player, val).filter(i => i !== gridIndex);

      if (matches.length) {
        room.bounceCard = displaced;
        room.turnPhase = 'bounce';
        room.bounceChain.push(val);

        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }

      pushDiscard(room, displaced);
    }

    if (activeCard.type === 'plus10') {
      const eligible = room.players
        .filter(p => p.flipped.filter(Boolean).length < 4)
        .map(p => p.id);

      if (eligible.length) {
        room.plus10Pending = eligible;
        room.turnPhase = 'plus10';

        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }
    }

    room.bounceChain = [];
    checkEndTrigger(room, player);

    room.turnPhase = 'draw';
    advanceTurn(room);

    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);

    if (!room.players.length) delete rooms[roomId];
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pushDiscard(room, card) {
  (room.discard1.length <= room.discard2.length
    ? room.discard1
    : room.discard2
  ).push(card);
}

function reshuffleDeck(room) {
  const keep1 = room.discard1.pop();
  const keep2 = room.discard2.pop();

  room.deck = shuffle([...room.discard1, ...room.discard2]);

  room.discard1 = keep1 ? [keep1] : [];
  room.discard2 = keep2 ? [keep2] : [];
}

function checkEndTrigger(room, player) {
  if (player.flipped.every(Boolean)) {
    room.phase = 'finalRound';
    room.finalTriggerPlayer = player.id;
  }
}

function advanceTurn(room) {
  const next = (room.currentTurn + 1) % room.players.length;

  if (room.phase === 'finalRound' &&
      room.players[next].id === room.finalTriggerPlayer) {

    room.players.forEach(p => p.flipped.fill(true));
    room.phase = 'ended';

    const scores = room.players
      .map(p => ({ name: p.name, score: scoreGrid(p.grid) }))
      .sort((a, b) => a.score - b.score);

    io.to(room.id).emit('gameOver', scores);
    return;
  }

  room.currentTurn = next;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
