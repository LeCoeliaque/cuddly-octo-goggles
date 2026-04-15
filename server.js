const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Deck Builder ────────────────────────────────────────────────────────────
function buildDeck() {
  const cards = [];
  // 3–8: 12 of each
  for (let n = 3; n <= 8; n++)
    for (let i = 0; i < 12; i++) cards.push({ type: 'number', value: n });
  // -1 through -4: 5 of each
  for (let n = -1; n >= -4; n--)
    for (let i = 0; i < 5; i++) cards.push({ type: 'number', value: n });
  // +10: 3 cards
  for (let i = 0; i < 3; i++) cards.push({ type: 'plus10', value: 10 });
  // Wildcard: 3 cards
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
function scoreGrid(grid) {
  // grid is 3x3 array of cards (or null), wild has a .wildValue set
  const val = (c) => {
    if (!c) return 0;
    if (c.type === 'wild') return c.wildValue ?? 0;
    return c.value;
  };

  let total = 0;

  // Check rows
  for (let r = 0; r < 3; r++) {
    const row = [grid[r * 3], grid[r * 3 + 1], grid[r * 3 + 2]];
    total += scoreLineOrRun(row, val);
  }
  // Check columns
  for (let c = 0; c < 3; c++) {
    const col = [grid[c], grid[3 + c], grid[6 + c]];
    total += scoreLineOrRun(col, val);
  }

  return total;
}

function scoreLineOrRun(line, val) {
  const [a, b, c] = line.map(val);
  // Three of a kind → negative of the value
  if (a === b && b === c) return -Math.abs(a);
  // Run (consecutive): middle card is the score, negated
  const sorted = [a, b, c].sort((x, y) => x - y);
  if (sorted[1] - sorted[0] === 1 && sorted[2] - sorted[1] === 1) return -sorted[1];
  // Otherwise each card scores its own value
  return a + b + c;
}

// ─── Room State ──────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],       // { id, name, grid:[card|null x9], flipped:[bool x9], wildPending:null }
    deck: [],
    discard1: [],
    discard2: [],
    phase: 'waiting',  // waiting | playing | finalRound | ended
    currentTurn: 0,
    finalTriggerPlayer: null,
    drawnCard: null,   // { card, source } held by current player mid-turn
    turnPhase: 'draw', // draw | place
    plus10Pending: null, // list of player ids that may flip
  };
}

function roomPublicState(room) {
  return {
    phase: room.phase,
    currentTurn: room.currentTurn,
    finalTriggerPlayer: room.finalTriggerPlayer,
    discard1Top: room.discard1.length ? room.discard1[room.discard1.length - 1] : null,
    discard2Top: room.discard2.length ? room.discard2[room.discard2.length - 1] : null,
    deckCount: room.deck.length,
    turnPhase: room.turnPhase,
    drawnCard: room.drawnCard,
    plus10Pending: room.plus10Pending,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      grid: p.grid.map((card, i) => p.flipped[i] ? card : { type: 'hidden' }),
      flipped: p.flipped,
      flippedCount: p.flipped.filter(Boolean).length,
    })),
  };
}

// ─── Socket Handlers ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.phase !== 'waiting') {
      socket.emit('error', 'Game already in progress');
      return;
    }
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      grid: Array(9).fill(null),
      flipped: Array(9).fill(false),
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    io.to(roomId).emit('roomState', roomPublicState(room));
    io.to(roomId).emit('message', `${playerName} joined the room.`);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'waiting') return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }

    room.deck = buildDeck();
    // Deal 9 cards to each player
    for (const p of room.players) {
      p.grid = room.deck.splice(0, 9);
      p.flipped = Array(9).fill(false);
    }
    // Seed both discard piles
    room.discard1.push(room.deck.pop());
    room.discard2.push(room.deck.pop());
    room.phase = 'playing';
    room.currentTurn = 0;
    room.turnPhase = 'draw';

    io.to(room.id).emit('roomState', roomPublicState(room));
    io.to(room.id).emit('message', 'Game started! Good luck.');
  });

  // Draw from deck or discard pile
  socket.on('draw', ({ source }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.turnPhase !== 'draw') return;
    const player = room.players[room.currentTurn];
    if (player.id !== socket.id) return;

    let card;
    if (source === 'deck') {
      if (room.deck.length === 0) reshuffleDeck(room);
      card = room.deck.pop();
    } else if (source === 'discard1') {
      if (!room.discard1.length) return;
      card = room.discard1.pop();
    } else if (source === 'discard2') {
      if (!room.discard2.length) return;
      card = room.discard2.pop();
    }

    room.drawnCard = { card, source };
    room.turnPhase = 'place';
    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  // Place drawn card into grid position, or discard it
  socket.on('placeCard', ({ gridIndex, discard, wildValue }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.turnPhase !== 'place') return;
    const player = room.players[room.currentTurn];
    if (player.id !== socket.id) return;
    if (!room.drawnCard) return;

    const { card } = room.drawnCard;

    if (discard) {
      // Discard the drawn card (only allowed if drawn from deck)
      if (room.drawnCard.source !== 'deck') { socket.emit('error', 'Cannot discard a card taken from discard pile'); return; }
      pushDiscard(room, card);
      room.drawnCard = null;
      room.turnPhase = 'draw';
      advanceTurn(room);
      io.to(room.id).emit('roomState', roomPublicState(room));
      return;
    }

    if (gridIndex < 0 || gridIndex > 8) return;

    // Handle wild card value assignment
    if (card.type === 'wild') {
      if (wildValue === undefined || wildValue === null) { socket.emit('needWildValue'); return; }
      card.wildValue = parseInt(wildValue);
    }

    const displaced = player.grid[gridIndex];
    player.grid[gridIndex] = card;
    player.flipped[gridIndex] = true;

    // Discard the displaced card
    if (displaced) pushDiscard(room, displaced);
    room.drawnCard = null;

    // Check +10 trigger
    if (card.type === 'plus10') {
      const eligible = room.players.filter(p => p.flipped.filter(Boolean).length < 4).map(p => p.id);
      if (eligible.length > 0) {
        room.plus10Pending = eligible;
        room.turnPhase = 'plus10';
        io.to(room.id).emit('roomState', roomPublicState(room));
        io.to(room.id).emit('message', `+10 played! Players with fewer than 4 flipped cards may reveal one.`);
        return;
      }
    }

    checkEndTrigger(room, player);
    room.turnPhase = 'draw';
    advanceTurn(room);
    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  // Handle +10 flip
  socket.on('plus10Flip', ({ gridIndex }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.turnPhase !== 'plus10') return;
    if (!room.plus10Pending?.includes(socket.id)) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (player.flipped[gridIndex]) return; // already flipped

    player.flipped[gridIndex] = true;
    room.plus10Pending = room.plus10Pending.filter(id => id !== socket.id);

    if (room.plus10Pending.length === 0) {
      room.turnPhase = 'draw';
      const currentPlayer = room.players[room.currentTurn];
      checkEndTrigger(room, currentPlayer);
      advanceTurn(room);
    }

    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  // Player skips their +10 flip
  socket.on('plus10Skip', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.turnPhase !== 'plus10') return;
    if (!room.plus10Pending?.includes(socket.id)) return;
    room.plus10Pending = room.plus10Pending.filter(id => id !== socket.id);

    if (room.plus10Pending.length === 0) {
      room.turnPhase = 'draw';
      const currentPlayer = room.players[room.currentTurn];
      checkEndTrigger(room, currentPlayer);
      advanceTurn(room);
    }

    io.to(room.id).emit('roomState', roomPublicState(room));
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      io.to(roomId).emit('message', `${name} left the game.`);
      if (room.players.length === 0) { delete rooms[roomId]; return; }
      if (room.phase === 'playing' && room.currentTurn >= room.players.length)
        room.currentTurn = 0;
      io.to(roomId).emit('roomState', roomPublicState(room));
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pushDiscard(room, card) {
  // Alternate between piles to keep them balanced
  if (room.discard1.length <= room.discard2.length) room.discard1.push(card);
  else room.discard2.push(card);
}

function reshuffleDeck(room) {
  const keep1 = room.discard1.pop();
  const keep2 = room.discard2.pop();
  room.deck = shuffle([...room.discard1, ...room.discard2]);
  room.discard1 = keep1 ? [keep1] : [];
  room.discard2 = keep2 ? [keep2] : [];
}

function checkEndTrigger(room, player) {
  if (room.phase !== 'playing') return;
  if (player.flipped.every(Boolean)) {
    room.phase = 'finalRound';
    room.finalTriggerPlayer = player.id;
    io.to(room.id).emit('message', `${player.name} flipped all cards! Final round begins.`);
  }
}

function advanceTurn(room) {
  if (room.phase === 'ended') return;
  const next = (room.currentTurn + 1) % room.players.length;

  if (room.phase === 'finalRound') {
    if (room.players[next].id === room.finalTriggerPlayer) {
      // Full loop done — end game, flip everything
      for (const p of room.players) p.flipped = Array(9).fill(true);
      room.phase = 'ended';
      const scores = room.players.map(p => ({ name: p.name, score: scoreGrid(p.grid) }));
      scores.sort((a, b) => a.score - b.score);
      io.to(room.id).emit('gameOver', scores);
      return;
    }
  }

  room.currentTurn = next;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
