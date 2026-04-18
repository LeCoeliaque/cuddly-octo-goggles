// ─── Golf Card Game ───────────────────────────────────────────────────────────

// ─── Deck Builder ─────────────────────────────────────────────────────────────
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
  const sorted = [a, b, c].sort((x, y) => x - y);
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

function scoreKnown(grid, flipped) {
  let total = 0;
  grid.forEach((c, i) => { if (flipped[i]) total += cardVal(c); });
  return total;
}

// ─── Bounce Logic ─────────────────────────────────────────────────────────────
// Returns indices of face-up cards (excluding excludeIndex) that match the given value
function findBounceTargets(player, value, excludeIndex) {
  const matches = [];
  player.grid.forEach((c, i) => {
    if (i !== excludeIndex && player.flipped[i] && c && cardVal(c) === value) {
      matches.push(i);
    }
  });
  return matches;
}

// ─── Room State ───────────────────────────────────────────────────────────────
const rooms = {};
// Track which socket IDs have already joined (per room) to prevent double-join
const joinedSockets = {}; // roomId -> Set of socket.ids

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
    bounceTargets: [], // valid grid indices the bounce card can be placed on
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
    bounceTargets: room.bounceTargets,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      grid: p.grid.map((card, i) => p.flipped[i] ? card : { type: 'hidden' }),
      flipped: p.flipped,
      flippedCount: p.flipped.filter(Boolean).length,
      knownScore: scoreKnown(p.grid, p.flipped),
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

function advanceTurn(io, room) {
  const next = (room.currentTurn + 1) % room.players.length;
  if (room.phase === 'finalRound' && room.players[next].id === room.finalTriggerPlayer) {
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

// ─── Register with namespace ───────────────────────────────────────────────────
function registerGolfGame(io) {
  io.on('connection', (socket) => {

    socket.on('joinRoom', ({ roomId, playerName }) => {
      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      if (!joinedSockets[roomId]) joinedSockets[roomId] = new Set();

      const room = rooms[roomId];

      // Prevent double-join from same socket
      if (joinedSockets[roomId].has(socket.id)) {
        // Already in this room, just resync state
        io.to(roomId).emit('roomState', roomPublicState(room));
        return;
      }

      if (room.phase !== 'waiting') { socket.emit('error', 'Game already in progress'); return; }

      joinedSockets[roomId].add(socket.id);
      room.players.push({
        id: socket.id,
        name: playerName || `Player ${room.players.length + 1}`,
        grid: Array(9).fill(null),
        flipped: Array(9).fill(false),
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
      room.bounceTargets = [];
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

      // During bounce phase, route to bounce handler
      if (room.turnPhase === 'bounce') {
        if (discard) {
          const pile = discardPile === 2 ? 'discard2' : 'discard1';
          room[pile].push(room.bounceCard);
          room.bounceCard = null;
          room.bounceChain = [];
          room.bounceTargets = [];
          room.turnPhase = 'draw';
          checkEndTrigger(room, player);
          advanceTurn(io, room);
          io.to(room.id).emit('roomState', roomPublicState(room));
          return;
        }
        // Validate: the target slot must be in bounceTargets
        if (!room.bounceTargets.includes(gridIndex)) {
          socket.emit('error', 'You can only place there if a matching card is face-up in that slot.');
          return;
        }
        // Place bounce card onto the matching slot, displacing it
        const displaced = player.grid[gridIndex];
        player.grid[gridIndex] = room.bounceCard;
        player.flipped[gridIndex] = true; // bounce card is now face-up
        // displaced is already face-up (it was a match), discard it
        room.bounceCard = null;
        room.bounceChain = [];
        room.bounceTargets = [];
        pushDiscard(room, displaced);
        checkEndTrigger(room, player);
        room.turnPhase = 'draw';
        advanceTurn(io, room);
        io.to(room.id).emit('roomState', roomPublicState(room));
        return;
      }

      const activeCard = room.drawnCard?.card;
      if (!activeCard) return;

      if (discard) {
        const pile = discardPile === 2 ? 'discard2' : 'discard1';
        room[pile].push(activeCard);
        room.drawnCard = null;
        room.bounceCard = null;
        room.bounceChain = [];
        room.bounceTargets = [];
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
        if (!wasFlipped) {
          // Displaced a face-down card: always enter bounce so the player sees what it was.
          // If there are matching face-up cards they can place it there; otherwise discard-only.
          const val = cardVal(displaced);
          const targets = findBounceTargets(player, val, gridIndex);
          room.bounceCard = displaced;
          room.bounceTargets = targets; // empty = discard only
          room.turnPhase = 'bounce';
          room.bounceChain.push(`?→${val}`);
          io.to(room.id).emit('roomState', roomPublicState(room));
          return;
        } else {
          // Displaced a face-up card
          const val = cardVal(displaced);
          const targets = findBounceTargets(player, val, gridIndex);
          if (targets.length) {
            room.bounceCard = displaced;
            room.bounceTargets = targets;
            room.turnPhase = 'bounce';
            room.bounceChain.push(val);
            io.to(room.id).emit('roomState', roomPublicState(room));
            return;
          }
          pushDiscard(room, displaced);
        }
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
      room.bounceTargets = [];
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
