// ─── Golf Card Game ───────────────────────────────────────────────────────────

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

// ─── Scoring ──────────────────────────────────────────────────────────────────
function cardVal(c) {
  if (!c) return 0;
  if (c.type === 'wild') return c.wildValue ?? 0;
  return c.value;
}

function scoreLine(line) {
  const [a, b, c] = line.map(cardVal);
  if (a === b && b === c) return -Math.abs(a);
  const sorted = [a, b, c].slice().sort((x, y) => x - y);
  if (sorted[1] - sorted[0] === 1 && sorted[2] - sorted[1] === 1) return -sorted[1];
  return a + b + c;
}

function scoreGrid(grid) {
  let total = 0;
  for (let r = 0; r < 3; r++)
    total += scoreLine([grid[r*3], grid[r*3+1], grid[r*3+2]]);
  for (let c = 0; c < 3; c++)
    total += scoreLine([grid[c], grid[c+3], grid[c+6]]);
  return total;
}

// Live score: score complete lines properly, sum raw values for incomplete lines
function scoreKnown(grid, flipped) {
  const allLines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
  ];
  let total = 0;
  for (const line of allLines) {
    if (line.every(i => flipped[i])) {
      total += scoreLine(line.map(i => grid[i]));
    } else {
      line.forEach(i => { if (flipped[i]) total += cardVal(grid[i]); });
    }
  }
  return total;
}

// ─── Bounce ───────────────────────────────────────────────────────────────────
// Returns true if a face-up card matching `value` exists in player's grid (excluding excludeIndex)
function hasFaceUpMatch(player, value, excludeIndex) {
  return player.grid.some((c, i) =>
    i !== excludeIndex && player.flipped[i] && c && cardVal(c) === value
  );
}

// ─── Room State ───────────────────────────────────────────────────────────────
const rooms = {};
const joinedSockets = {};

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
    bounceChain: [],
    bounceCanPlace: false,
    roundNumber: 0,
    goalScore: null,
    lastRoundResults: null,
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
    bounceCanPlace: room.bounceCanPlace,
    roundNumber: room.roundNumber,
    goalScore: room.goalScore,
    lastRoundResults: room.lastRoundResults,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      grid: p.grid.map((card, i) => p.flipped[i] ? card : { type: 'hidden' }),
      flipped: p.flipped,
      flippedCount: p.flipped.filter(Boolean).length,
      knownScore: scoreKnown(p.grid, p.flipped),
      totalScore: p.totalScore || 0,
    })),
  };
}

function pushDiscard(room, card) {
  (room.discard1.length <= room.discard2.length ? room.discard1 : room.discard2).push(card);
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

function endRound(io, room) {
  room.players.forEach(p => p.flipped.fill(true));
  room.phase = 'ended';

  const roundScores = room.players.map(p => {
    const rs = scoreGrid(p.grid);
    p.totalScore = (p.totalScore || 0) + rs;
    return {
      id: p.id,
      name: p.name,
      roundScore: rs,
      totalScore: p.totalScore,
      grid: p.grid.slice(),
    };
  });

  const results = roundScores.slice().sort((a, b) => a.totalScore - b.totalScore);
  room.lastRoundResults = results;

  let gameOver = false;
  if (room.goalScore !== null) {
    gameOver = results.some(r => r.totalScore <= room.goalScore);
  } else {
    gameOver = true;
  }

  io.to(room.id).emit('roundOver', { results, gameOver, goalScore: room.goalScore });
}

function advanceTurn(io, room) {
  const next = (room.currentTurn + 1) % room.players.length;
  if (room.phase === 'finalRound' && room.players[next].id === room.finalTriggerPlayer) {
    endRound(io, room);
    return;
  }
  room.currentTurn = next;
}

// ─── Register with namespace ───────────────────────────────────────────────────
function registerGolfGame(io) {
  io.on('connection', (socket) => {

    socket.on('joinRoom', ({ roomId, playerName }) => {
      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      if (!joinedSockets[roomId]) joinedSockets[roomId] = new Set();
      const room = rooms[roomId];

      if (joinedSockets[roomId].has(socket.id)) {
        socket.emit('roomState', roomPublicState(room));
        return;
      }
      if (room.phase !== 'waiting') { socket.emit('error', 'Game already in progress'); return; }

      joinedSockets[roomId].add(socket.id);
      room.players.push({
        id: socket.id,
        name: playerName || `Player ${room.players.length + 1}`,
        grid: Array(9).fill(null),
        flipped: Array(9).fill(false),
        totalScore: 0,
      });
      socket.join(roomId);
      socket.data.roomId = roomId;
      io.to(roomId).emit('roomState', roomPublicState(room));
    });

    socket.on('setGoal', ({ goalScore }) => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'waiting') return;
      room.goalScore = (goalScore != null && goalScore !== '') ? parseInt(goalScore) : null;
      io.to(room.id).emit('roomState', roomPublicState(room));
    });

    function startRound(room) {
      room.deck = buildDeck();
      for (const p of room.players) {
        p.grid = room.deck.splice(0, 9);
        p.flipped = Array(9).fill(false);
      }
      room.discard1 = [];
      room.discard2 = [];
      room.discard1.push(room.deck.pop());
      room.discard2.push(room.deck.pop());
      room.phase = 'playing';
      room.currentTurn = 0;
      room.turnPhase = 'draw';
      room.finalTriggerPlayer = null;
      room.drawnCard = null;
      room.bounceCard = null;
      room.bounceChain = [];
      room.bounceCanPlace = false;
      room.plus10Pending = null;
      room.roundNumber = (room.roundNumber || 0) + 1;
    }

    socket.on('startGame', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.players.length < 2) return;
      startRound(room);
      io.to(room.id).emit('roomState', roomPublicState(room));
    });

    socket.on('nextRound', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'ended') return;
      startRound(room);
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

      // ── Bounce phase ──────────────────────────────────────────────────────
      if (room.turnPhase === 'bounce') {
        if (discard) {
          const pile = discardPile === 2 ? 'discard2' : 'discard1';
          room[pile].push(room.bounceCard);
          room.bounceCard = null;
          room.bounceChain = [];
          room.bounceCanPlace = false;
          room.turnPhase = 'draw';
          checkEndTrigger(room, player);
          advanceTurn(io, room);
          io.to(room.id).emit('roomState', roomPublicState(room));
          return;
        }
        if (!room.bounceCanPlace) {
          socket.emit('error', 'No matching face-up card — you must discard this card.');
          return;
        }

        const bounceCard = room.bounceCard;
        const displaced = player.grid[gridIndex];
        const wasFlipped = player.flipped[gridIndex];
        player.grid[gridIndex] = bounceCard;
        player.flipped[gridIndex] = true;
        room.bounceCard = null;
        room.bounceChain = [];
        room.bounceCanPlace = false;

        if (displaced) {
          const val = cardVal(displaced);
          const canPlace = hasFaceUpMatch(player, val, gridIndex);
          room.bounceCard = displaced;
          room.bounceCanPlace = canPlace;
          room.turnPhase = 'bounce';
          room.bounceChain = wasFlipped ? [val] : [`?→${val}`];
          io.to(room.id).emit('roomState', roomPublicState(room));
          return;
        }

        checkEndTrigger(room, player);
        room.turnPhase = 'draw';
        advanceTurn(io, room);
        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }

      // ── Normal place phase ────────────────────────────────────────────────
      const activeCard = room.drawnCard?.card;
      if (!activeCard) return;

      if (discard) {
        const pile = discardPile === 2 ? 'discard2' : 'discard1';
        room[pile].push(activeCard);
        room.drawnCard = null;
        room.turnPhase = 'draw';
        advanceTurn(io, room);
        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }

      if (activeCard.type === 'wild') {
        if (wildValue == null) { socket.emit('needWildValue'); return; }
        activeCard.wildValue = parseInt(wildValue);
      }

      const displaced = player.grid[gridIndex];
      const wasFlipped = player.flipped[gridIndex];
      player.grid[gridIndex] = activeCard;
      player.flipped[gridIndex] = true;
      room.drawnCard = null;

      if (displaced) {
        const val = cardVal(displaced);
        const canPlace = hasFaceUpMatch(player, val, gridIndex);
        room.bounceCard = displaced;
        room.bounceCanPlace = canPlace;
        room.turnPhase = 'bounce';
        room.bounceChain = wasFlipped ? [val] : [`?→${val}`];
        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
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

      checkEndTrigger(room, player);
      room.turnPhase = 'draw';
      advanceTurn(io, room);
      io.to(room.id).emit('roomState', roomPublicState(room));
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      if (!rooms[roomId]) return;
      const room = rooms[roomId];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (joinedSockets[roomId]) joinedSockets[roomId].delete(socket.id);
      if (!room.players.length) {
        delete rooms[roomId];
        delete joinedSockets[roomId];
      }
    });
  });
}

module.exports = { registerGolfGame };
