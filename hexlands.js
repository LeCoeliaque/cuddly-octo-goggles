// ─── Hexlands (Catan-like) Game ───────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const TERRAIN_RESOURCE = { forest:'wood', hills:'brick', pasture:'sheep', fields:'wheat', mountains:'ore', desert:null };
const TERRAIN_COUNTS = { forest:4, hills:3, pasture:4, fields:4, mountains:3, desert:1 };
const NUMBER_TOKENS = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
const BUILD_COSTS = {
  road:      { wood:1, brick:1 },
  settlement:{ wood:1, brick:1, sheep:1, wheat:1 },
  city:      { wheat:2, ore:3 },
  devCard:   { sheep:1, wheat:1, ore:1 },
};
const DEV_CARDS = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('victoryPoint'),
  ...Array(2).fill('roadBuilding'),
  ...Array(2).fill('yearOfPlenty'),
  ...Array(2).fill('monopoly'),
];
const WIN_VP = 10;
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];

// ─── Hex Grid (radius-2 board = 19 tiles) ─────────────────────────────────────
const HEX_COORDS = [];
for (let q = -2; q <= 2; q++) {
  for (let r = -2; r <= 2; r++) {
    const s = -q - r;
    if (Math.abs(s) <= 2) HEX_COORDS.push({ q, r, s });
  }
}

function buildBoard() {
  const terrains = [];
  for (const [t, c] of Object.entries(TERRAIN_COUNTS))
    for (let i = 0; i < c; i++) terrains.push(t);
  shuffle(terrains);

  const numbers = [...NUMBER_TOKENS];
  shuffle(numbers);

  const tiles = HEX_COORDS.map((coord, i) => {
    const terrain = terrains[i];
    const number = terrain === 'desert' ? null : numbers.shift();
    return { ...coord, terrain, number, hasRobber: terrain === 'desert' };
  });

  const vertexMap = new Map();
  const edgeMap = new Map();

  tiles.forEach(tile => {
    getHexVertexKeys(tile).forEach(key => {
      if (!vertexMap.has(key)) vertexMap.set(key, { id: key, building: null, owner: null, port: null });
    });
    getHexEdgeKeys(tile).forEach(key => {
      if (!edgeMap.has(key)) edgeMap.set(key, { id: key, road: null, owner: null });
    });
  });

  assignPorts(tiles, vertexMap);

  return {
    tiles,
    vertices: Object.fromEntries(vertexMap),
    edges: Object.fromEntries(edgeMap),
  };
}

function hexCornerOffset(i) {
  const angle = (60 * i - 30) * Math.PI / 180;
  return { dx: Math.cos(angle), dy: Math.sin(angle) };
}

function getHexVertexKeys(tile) {
  return Array.from({length:6}, (_,i) => {
    const neighbors = getHexNeighborCoords(tile);
    const adj1 = neighbors[i];
    const adj2 = neighbors[(i+5)%6];
    const keys = [coordKey(tile), coordKey(adj1), coordKey(adj2)].sort();
    return keys.join('|');
  });
}

function getHexEdgeKeys(tile) {
  return Array.from({length:6}, (_,i) => {
    const neighbor = getHexNeighborCoords(tile)[i];
    return [coordKey(tile), coordKey(neighbor)].sort().join('||');
  });
}

function getHexNeighborCoords({q,r,s}) {
  const dirs = [{q:1,r:-1},{q:1,r:0},{q:0,r:1},{q:-1,r:1},{q:-1,r:0},{q:0,r:-1}];
  return dirs.map(d => ({q:q+d.q, r:r+d.r, s:s+d.s}));
}

function coordKey({q,r,s}) { return `${q},${r},${s??(-q-r)}`; }

function assignPorts(tiles, vertexMap) {
  const portTypes = ['3:1','3:1','3:1','3:1','wood','brick','sheep','wheat','ore'];
  shuffle(portTypes);
  const vCount = new Map();
  tiles.forEach(t => getHexVertexKeys(t).forEach(k => vCount.set(k, (vCount.get(k)||0)+1)));
  const borderVerts = [...vCount.entries()].filter(([,c])=>c<=2).map(([k])=>k);
  shuffle(borderVerts);
  let pi = 0;
  for (let i = 0; i < borderVerts.length - 1 && pi < portTypes.length; i += 2, pi++) {
    const v1 = vertexMap.get(borderVerts[i]);
    const v2 = vertexMap.get(borderVerts[i+1]);
    if (v1) v1.port = portTypes[pi];
    if (v2) v2.port = portTypes[pi];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function rollDice() {
  return [Math.ceil(Math.random()*6), Math.ceil(Math.random()*6)];
}

function canAfford(resources, cost) {
  return Object.entries(cost).every(([r,n]) => (resources[r]||0) >= n);
}

function deduct(resources, cost) {
  const r = {...resources};
  for (const [res,n] of Object.entries(cost)) r[res] = (r[res]||0) - n;
  return r;
}

function emptyResources() {
  return { wood:0, brick:0, sheep:0, wheat:0, ore:0 };
}

// ─── Road graph helpers ───────────────────────────────────────────────────────
function buildAdjacency(board) {
  const adj = {};
  Object.values(board.edges).forEach(edge => {
    const [v1, v2] = getEdgeVertices(edge.id, board);
    if (!v1 || !v2) return;
    if (!adj[v1]) adj[v1] = [];
    if (!adj[v2]) adj[v2] = [];
    adj[v1].push({ to: v2, edgeId: edge.id });
    adj[v2].push({ to: v1, edgeId: edge.id });
  });
  return adj;
}

function getEdgeVertices(edgeId, board) {
  const [hk1, hk2] = edgeId.split('||');
  const vertices = Object.keys(board.vertices);
  const shared = vertices.filter(vk => {
    const parts = vk.split('|');
    return parts.includes(hk1) && parts.includes(hk2);
  });
  return shared.slice(0,2);
}

function longestRoadLength(playerId, board) {
  const adj = buildAdjacency(board);
  let best = 0;
  const playerEdges = new Set(
    Object.values(board.edges).filter(e=>e.owner===playerId).map(e=>e.id)
  );
  function dfs(vKey, visited, length) {
    best = Math.max(best, length);
    const neighbors = adj[vKey] || [];
    for (const { to, edgeId } of neighbors) {
      if (!playerEdges.has(edgeId)) continue;
      if (visited.has(edgeId)) continue;
      const toV = board.vertices[to];
      if (toV && toV.owner && toV.owner !== playerId) continue;
      visited.add(edgeId);
      dfs(to, visited, length+1);
      visited.delete(edgeId);
    }
  }
  for (const vKey of Object.keys(adj)) {
    dfs(vKey, new Set(), 0);
  }
  return best;
}

function getVerticesAdjacentToHex(hexCoord, board) {
  const keys = getHexVertexKeys(hexCoord);
  return keys.filter(k => board.vertices[k]);
}

function getVerticesAdjacentToVertex(vKey, board) {
  const adj = buildAdjacency(board);
  return (adj[vKey]||[]).map(e=>e.to);
}

function isValidSettlementPlacement(vKey, playerId, board, isSetup) {
  const v = board.vertices[vKey];
  if (!v || v.building) return false;
  const adj = getVerticesAdjacentToVertex(vKey, board);
  if (adj.some(ak => board.vertices[ak]?.building)) return false;
  if (isSetup) return true;
  const adjBoard = buildAdjacency(board);
  const roads = (adjBoard[vKey]||[]).some(({edgeId}) => board.edges[edgeId]?.owner === playerId);
  return roads;
}

function isValidRoadPlacement(edgeId, playerId, board, isSetup, lastSettlement) {
  const edge = board.edges[edgeId];
  if (!edge || edge.road) return false;
  const [v1, v2] = getEdgeVertices(edgeId, board);
  if (!v1 || !v2) return false;
  if (isSetup && lastSettlement) {
    return v1 === lastSettlement || v2 === lastSettlement;
  }
  const adj = buildAdjacency(board);
  const verts = [v1, v2];
  for (const vk of verts) {
    const vert = board.vertices[vk];
    if (vert?.owner === playerId) return true;
    if ((adj[vk]||[]).some(({edgeId:eid}) => board.edges[eid]?.owner === playerId)) {
      if (!vert?.building || vert.owner === playerId) return true;
    }
  }
  return false;
}

function getBankRatio(playerId, resource, room) {
  let ratio = 4;
  Object.values(room.board.vertices).forEach(v => {
    if (v.owner !== playerId || !v.port) return;
    if (v.port === '3:1') ratio = Math.min(ratio, 3);
    if (v.port === resource) ratio = Math.min(ratio, 2);
  });
  return ratio;
}

// ─── Room State ───────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(id) {
  return {
    id, phase:'lobby',
    players:[],
    board: null,
    deck: [],
    turn: 0,
    setupRound: 1,
    setupIndex: 0,
    setupForward: true,
    setupLastSettlement: null,
    diceResult: null,
    diceRolled: false,
    robberActive: false,
    devCardPlayed: false,
    freeRoads: 0,
    longestRoad: null,
    largestArmy: null,
    tradeOffer: null,
    actionLog: [],
  };
}

function calcVP(player, room) {
  let vp = 0;
  Object.values(room.board.vertices).forEach(v => {
    if (v.owner === player.id) vp += v.building === 'city' ? 2 : 1;
  });
  if (room.longestRoad === player.id) vp += 2;
  if (room.largestArmy === player.id) vp += 2;
  return vp;
}

function publicState(room) {
  const players = room.players.map(p => ({
    id: p.id, name: p.name, color: p.color,
    resourceCount: Object.values(p.resources).reduce((a,b)=>a+b,0),
    devCardCount: p.devCards.length,
    knights: p.knights,
    vp: calcVP(p, room),
    vpPrivate: (p.devCards.filter(c=>c==='victoryPoint').length),
  }));
  return {
    phase: room.phase, players, board: room.board, turn: room.turn,
    setupRound: room.setupRound, setupIndex: room.setupIndex, setupForward: room.setupForward,
    diceResult: room.diceResult, diceRolled: room.diceRolled, robberActive: room.robberActive,
    devCardPlayed: room.devCardPlayed, freeRoads: room.freeRoads,
    longestRoad: room.longestRoad, largestArmy: room.largestArmy,
    tradeOffer: room.tradeOffer, actionLog: room.actionLog.slice(-8),
  };
}

function privateState(room, playerId) {
  const p = room.players.find(p=>p.id===playerId);
  return { resources: p?.resources||{}, devCards: p?.devCards||[] };
}

function broadcast(io, room) {
  const pub = publicState(room);
  room.players.forEach(p => {
    io.to(p.id).emit('gameState', { ...pub, myPrivate: privateState(room, p.id) });
  });
}

function log(room, msg) { room.actionLog.push(msg); }

function checkWin(io, room) {
  for (const p of room.players) {
    const vp = calcVP(p, room) + p.devCards.filter(c=>c==='victoryPoint').length;
    if (vp >= WIN_VP) {
      room.phase = 'ended';
      log(room, `🏆 ${p.name} wins with ${vp} VP!`);
      broadcast(io, room);
      return true;
    }
  }
  return false;
}

function updateSpecialCards(io, room) {
  let bestLen = 4, bestPlayer = null;
  room.players.forEach(p => {
    const len = longestRoadLength(p.id, room.board);
    if (len > bestLen) { bestLen = len; bestPlayer = p.id; }
  });
  if (bestPlayer && bestPlayer !== room.longestRoad) {
    room.longestRoad = bestPlayer;
    const p = room.players.find(p=>p.id===bestPlayer);
    log(room, `🛣️ ${p.name} takes Longest Road!`);
  }
  let bestKnights = 2, bestArmy = null;
  room.players.forEach(p => {
    if (p.knights > bestKnights) { bestKnights = p.knights; bestArmy = p.id; }
  });
  if (bestArmy && bestArmy !== room.largestArmy) {
    room.largestArmy = bestArmy;
    const p = room.players.find(p=>p.id===bestArmy);
    log(room, `⚔️ ${p.name} takes Largest Army!`);
  }
}

function distributeResources(room, roll) {
  room.players.forEach(p => {
    room.board.tiles.forEach(tile => {
      if (tile.number !== roll || tile.hasRobber) return;
      const resource = TERRAIN_RESOURCE[tile.terrain];
      if (!resource) return;
      getVerticesAdjacentToHex(tile, room.board).forEach(vk => {
        const v = room.board.vertices[vk];
        if (!v || !v.owner) return;
        const player = room.players.find(p=>p.id===v.owner);
        if (!player) return;
        const amount = v.building === 'city' ? 2 : 1;
        player.resources[resource] = (player.resources[resource]||0) + amount;
      });
    });
  });
}

function advanceTurn(room) {
  room.diceRolled = false;
  room.diceResult = null;
  room.devCardPlayed = false;
  room.tradeOffer = null;
  room.turn = (room.turn + 1) % room.players.length;
}

function advanceSetup(room) {
  if (room.setupForward) {
    if (room.setupIndex < room.players.length - 1) {
      room.setupIndex++;
    } else {
      room.setupForward = false;
      room.setupRound = 2;
    }
  } else {
    if (room.setupIndex > 0) {
      room.setupIndex--;
    } else {
      room.phase = 'playing';
      room.turn = 0;
      log(room, 'Setup complete! Game begins.');
    }
  }
}

// ─── Register with namespace ───────────────────────────────────────────────────
function registerHexlandsGame(io);
  io.on('connection', socket => {
    socket.on('joinRoom', ({ roomId, playerName }) => {
      if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
      const room = rooms[roomId];
      if (room.phase !== 'lobby') { socket.emit('err','Game in progress'); return; }
      if (room.players.length >= 6) { socket.emit('err','Room full'); return; }
      const color = COLORS[room.players.length];
      room.players.push({ id:socket.id, name:playerName||`Player ${room.players.length+1}`,
        color, resources:emptyResources(), devCards:[], knights:0 });
      socket.join(roomId);
      socket.data.roomId = roomId;
      log(room, `${playerName} joined.`);
      broadcast(io, room);
    });

    socket.on('startGame', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'lobby') return;
      if (room.players.length < 2) { socket.emit('err','Need at least 2 players'); return; }
      room.board = buildBoard();
      room.deck = shuffle([...DEV_CARDS]);
      room.phase = 'setup';
      room.setupIndex = 0;
      room.setupForward = true;
      room.setupRound = 1;
      log(room, 'Game started! Setup phase.');
      broadcast(io, room);
    });

    socket.on('placeSettlement', ({ vertexId }) => {
      const room = rooms[socket.data.roomId];
      if (!room) return;
      const isSetup = room.phase === 'setup';
      const currentPlayer = isSetup ? room.players[room.setupIndex] : room.players[room.turn];
      if (currentPlayer.id !== socket.id) return;
      if (!isSetup && !room.diceRolled) { socket.emit('err','Roll dice first'); return; }
      if (!isValidSettlementPlacement(vertexId, socket.id, room.board, isSetup)) {
        socket.emit('err','Invalid placement'); return;
      }
      room.board.vertices[vertexId].building = 'settlement';
      room.board.vertices[vertexId].owner = socket.id;
      if (isSetup) {
        room.setupLastSettlement = vertexId;
        if (room.setupRound === 2) {
          const player = room.players[room.setupIndex];
          room.board.tiles.forEach(tile => {
            const res = TERRAIN_RESOURCE[tile.terrain];
            if (!res) return;
            if (getVerticesAdjacentToHex(tile, room.board).includes(vertexId))
              player.resources[res] = (player.resources[res]||0) + 1;
          });
        }
        log(room, `${currentPlayer.name} placed a settlement.`);
      } else {
        log(room, `${currentPlayer.name} built a settlement.`);
        currentPlayer.resources = deduct(currentPlayer.resources, BUILD_COSTS.settlement);
      }
      broadcast(io, room);
    });

    socket.on('placeRoad', ({ edgeId }) => {
      const room = rooms[socket.data.roomId];
      if (!room) return;
      const isSetup = room.phase === 'setup';
      const isFreeRoad = room.freeRoads > 0;
      const currentPlayer = isSetup ? room.players[room.setupIndex] : room.players[room.turn];
      if (currentPlayer.id !== socket.id) return;
      if (!isValidRoadPlacement(edgeId, socket.id, room.board, isSetup, room.setupLastSettlement)) {
        socket.emit('err','Invalid road placement'); return;
      }
      room.board.edges[edgeId].road = true;
      room.board.edges[edgeId].owner = socket.id;
      if (isSetup) {
        log(room, `${currentPlayer.name} placed a road.`);
        room.setupLastSettlement = null;
        advanceSetup(room);
      } else if (isFreeRoad) {
        room.freeRoads--;
        log(room, `${currentPlayer.name} built a road (free).`);
        if (room.freeRoads === 0) log(room, 'Road Building done.');
      } else {
        currentPlayer.resources = deduct(currentPlayer.resources, BUILD_COSTS.road);
        log(room, `${currentPlayer.name} built a road.`);
      }
      updateSpecialCards(io, room);
      broadcast(io, room);
    });

    socket.on('buildCity', ({ vertexId }) => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id || !room.diceRolled) return;
      const v = room.board.vertices[vertexId];
      if (!v || v.building !== 'settlement' || v.owner !== socket.id) { socket.emit('err','No settlement here'); return; }
      if (!canAfford(player.resources, BUILD_COSTS.city)) { socket.emit('err','Not enough resources'); return; }
      v.building = 'city';
      player.resources = deduct(player.resources, BUILD_COSTS.city);
      log(room, `${player.name} upgraded to a city.`);
      if (!checkWin(io, room)) broadcast(io, room);
    });

    socket.on('rollDice', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id || room.diceRolled) return;
      const dice = rollDice();
      room.diceResult = dice;
      room.diceRolled = true;
      const roll = dice[0] + dice[1];
      log(room, `${player.name} rolled ${dice[0]}+${dice[1]}=${roll}.`);
      if (roll === 7) {
        room.players.forEach(p => {
          const total = Object.values(p.resources).reduce((a,b)=>a+b,0);
          if (total > 7) {
            const discard = Math.floor(total/2);
            let toDiscard = discard;
            for (const res of RESOURCES) {
              while (p.resources[res] > 0 && toDiscard > 0) { p.resources[res]--; toDiscard--; }
            }
            log(room, `${p.name} discarded ${discard} cards.`);
          }
        });
        room.robberActive = true;
        log(room, 'Robber activated! Place it on a tile.');
      } else {
        distributeResources(room, roll);
      }
      broadcast(io, room);
    });

    socket.on('moveRobber', ({ tileIndex }) => {
      const room = rooms[socket.data.roomId];
      if (!room || !room.robberActive) return;
      const player = room.players[room.turn];
      if (player.id !== socket.id) return;
      room.board.tiles.forEach(t => t.hasRobber = false);
      room.board.tiles[tileIndex].hasRobber = true;
      room.robberActive = false;
      log(room, `${player.name} moved the robber.`);
      broadcast(io, room);
    });

    socket.on('endTurn', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id || !room.diceRolled) return;
      if (room.robberActive) { socket.emit('err','Place the robber first'); return; }
      if (room.freeRoads > 0) { socket.emit('err','Place your free roads first'); return; }
      log(room, `${player.name} ended their turn.`);
      advanceTurn(room);
      broadcast(io, room);
    });

    socket.on('buyDevCard', () => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id || !room.diceRolled) return;
      if (!canAfford(player.resources, BUILD_COSTS.devCard)) { socket.emit('err','Not enough resources'); return; }
      if (!room.deck.length) { socket.emit('err','No dev cards left'); return; }
      player.resources = deduct(player.resources, BUILD_COSTS.devCard);
      const card = room.deck.pop();
      player.devCards.push(card);
      log(room, `${player.name} bought a dev card.`);
      if (!checkWin(io, room)) broadcast(io, room);
    });

    socket.on('playDevCard', ({ cardType, data }) => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id) return;
      if (room.devCardPlayed) { socket.emit('err','Already played a card this turn'); return; }
      const idx = player.devCards.indexOf(cardType);
      if (idx === -1) { socket.emit('err','You do not have that card'); return; }
      player.devCards.splice(idx, 1);
      room.devCardPlayed = true;
      if (cardType === 'knight') {
        player.knights++;
        room.robberActive = true;
        updateSpecialCards(io, room);
        log(room, `${player.name} played Knight!`);
      } else if (cardType === 'roadBuilding') {
        room.freeRoads = 2;
        log(room, `${player.name} played Road Building!`);
      } else if (cardType === 'yearOfPlenty') {
        if (data?.res1) player.resources[data.res1] = (player.resources[data.res1]||0)+1;
        if (data?.res2) player.resources[data.res2] = (player.resources[data.res2]||0)+1;
        log(room, `${player.name} played Year of Plenty!`);
      } else if (cardType === 'monopoly') {
        if (data?.resource) {
          let total = 0;
          room.players.forEach(p => {
            if (p.id !== socket.id) { total += p.resources[data.resource]||0; p.resources[data.resource]=0; }
          });
          player.resources[data.resource] = (player.resources[data.resource]||0)+total;
          log(room, `${player.name} played Monopoly on ${data.resource}! Got ${total}.`);
        }
      } else if (cardType === 'victoryPoint') {
        player.devCards.push('victoryPoint');
        room.devCardPlayed = false;
        log(room, `${player.name} revealed a VP card!`);
      }
      if (!checkWin(io, room)) broadcast(io, room);
    });

    socket.on('proposeTrade', ({ give, want, toPlayer }) => {
      const room = rooms[socket.data.roomId];
      if (!room || room.phase !== 'playing') return;
      const player = room.players[room.turn];
      if (player.id !== socket.id || !room.diceRolled) return;
      if (!canAfford(player.resources, give)) { socket.emit('err','Not enough resources'); return; }
      if (!toPlayer) {
        for (const [res,n] of Object.entries(give)) {
          if (!n) continue;
          const ratio = getBankRatio(socket.id, res, room);
          if (n % ratio !== 0) { socket.emit('err',`Need ${ratio}:1 for ${res}`); return; }
          const wantTotal = Object.values(want).reduce((a,b)=>a+b,0);
          if (n / ratio !== wantTotal) { socket.emit('err','Invalid trade ratio'); return; }
        }
        player.resources = deduct(player.resources, give);
        for (const [res,n] of Object.entries(want)) player.resources[res]=(player.resources[res]||0)+n;
        log(room, `${player.name} traded with the bank.`);
        broadcast(io, room);
      } else {
        room.tradeOffer = { from: socket.id, give, want, toPlayer };
        log(room, `${player.name} offers a trade.`);
        broadcast(io, room);
      }
    });

    socket.on('acceptTrade', () => {
      const room = rooms[socket.data.roomId];
      if (!room || !room.tradeOffer) return;
      const offer = room.tradeOffer;
      if (offer.toPlayer && offer.toPlayer !== socket.id) return;
      const from = room.players.find(p=>p.id===offer.from);
      const to = room.players.find(p=>p.id===socket.id);
      if (!canAfford(from.resources, offer.give)) { socket.emit('err','Offerer no longer has resources'); return; }
      if (!canAfford(to.resources, offer.want)) { socket.emit('err','Not enough resources to accept'); return; }
      from.resources = deduct(from.resources, offer.give);
      to.resources = deduct(to.resources, offer.want);
      for (const [res,n] of Object.entries(offer.give)) to.resources[res]=(to.resources[res]||0)+n;
      for (const [res,n] of Object.entries(offer.want)) from.resources[res]=(from.resources[res]||0)+n;
      room.tradeOffer = null;
      log(room, `Trade accepted between ${from.name} and ${to.name}.`);
      broadcast(io, room);
    });

    socket.on('cancelTrade', () => {
      const room = rooms[socket.data.roomId];
      if (!room) return;
      room.tradeOffer = null;
      broadcast(io, room);
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      if (!roomId || !rooms[roomId]) return;
      const room = rooms[roomId];
      const idx = room.players.findIndex(p=>p.id===socket.id);
      if (idx !== -1) {
        log(room, `${room.players[idx].name} disconnected.`);
        room.players.splice(idx,1);
        if (!room.players.length) { delete rooms[roomId]; return; }
        if (room.turn >= room.players.length) room.turn=0;
        broadcast(io, room);
      }
    });
  });
}

module.exports = { registerHexlandsGame };
