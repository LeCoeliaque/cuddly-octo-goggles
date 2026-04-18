// ─── Hexlands — Catan-inspired game ──────────────────────────────────────────
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const RESOURCES  = ['wood','brick','sheep','wheat','ore'];
const TERRAIN_RESOURCE = {forest:'wood',hills:'brick',pasture:'sheep',fields:'wheat',mountains:'ore',desert:null};
const TERRAIN_COUNTS   = {forest:4,hills:3,pasture:4,fields:4,mountains:3,desert:1};
const NUMBER_TOKENS    = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];
const BUILD_COSTS = {
  road:       {wood:1,brick:1},
  settlement: {wood:1,brick:1,sheep:1,wheat:1},
  city:       {wheat:2,ore:3},
  devCard:    {sheep:1,wheat:1,ore:1},
};
const DEV_DECK = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('victoryPoint'),
  ...Array(2).fill('roadBuilding'),
  ...Array(2).fill('yearOfPlenty'),
  ...Array(2).fill('monopoly'),
];
const WIN_VP   = 10;
const COLORS   = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c'];

// ─── Hex Grid ─────────────────────────────────────────────────────────────────
// Pointy-top axial coordinates.  The standard 19-tile Catan board.
const HEX_COORDS = [];
for (let q = -2; q <= 2; q++)
  for (let r = Math.max(-2,-q-2); r <= Math.min(2,-q+2); r++)
    HEX_COORDS.push({q,r});

// Neighbour directions (pointy-top)
const HEX_DIRS = [{q:1,r:0},{q:1,r:-1},{q:0,r:-1},{q:-1,r:0},{q:-1,r:1},{q:0,r:1}];
function hexNeighbors(q,r){ return HEX_DIRS.map(d=>({q:q+d.q,r:r+d.r})); }

// Canonical key helpers
function hexKey(q,r){ return `${q},${r}`; }

// Vertex i of hex (q,r) is shared by this hex and the two neighbours at indices i and (i+5)%6
function vertexKey(q,r,i){
  const ns = hexNeighbors(q,r);
  return [hexKey(q,r), hexKey(ns[i].q,ns[i].r), hexKey(ns[(i+5)%6].q,ns[(i+5)%6].r)].sort().join('|');
}
// Edge i of hex (q,r) is shared by this hex and neighbour i
function edgeKey(q,r,i){
  const n = HEX_DIRS[i];
  return [hexKey(q,r), hexKey(q+n.q,r+n.r)].sort().join('||');
}

// ─── Board builder ────────────────────────────────────────────────────────────
function buildBoard(){
  // 1. shuffle terrains
  const terrains = [];
  for(const [t,c] of Object.entries(TERRAIN_COUNTS)) for(let i=0;i<c;i++) terrains.push(t);
  shuffle(terrains);

  // 2. assign number tokens (skip desert)
  const nums = shuffle([...NUMBER_TOKENS]);
  let ni = 0;
  const tiles = HEX_COORDS.map((coord,idx) => {
    const terrain = terrains[idx];
    const number  = terrain==='desert' ? null : nums[ni++];
    return {...coord, id:idx, terrain, number, robber: terrain==='desert'};
  });

  // 3. build vertex and edge maps
  const vertices = {}; // key -> {key, tileIds:[], position:0-5-of-first-tile, building:null, owner:null, port:null}
  const edges    = {}; // key -> {key, tileIds:[], road:false, owner:null}

  tiles.forEach(tile => {
    for(let i=0;i<6;i++){
      const vk = vertexKey(tile.q,tile.r,i);
      if(!vertices[vk]) vertices[vk] = {key:vk, tileKeys:[], i, building:null, owner:null, port:null};
      if(!vertices[vk].tileKeys.includes(hexKey(tile.q,tile.r)))
        vertices[vk].tileKeys.push(hexKey(tile.q,tile.r));

      const ek = edgeKey(tile.q,tile.r,i);
      if(!edges[ek]) edges[ek] = {key:ek, road:false, owner:null};
    }
  });

  // 4. assign ports to some border vertices
  const PORT_TYPES = ['3:1','3:1','3:1','3:1','wood','brick','sheep','wheat','ore'];
  shuffle(PORT_TYPES);
  // border vertices = those adjacent to only 1 or 2 tiles
  const borderVerts = Object.values(vertices).filter(v=>v.tileKeys.length<=2);
  shuffle(borderVerts);
  let pi=0;
  for(let i=0;i<borderVerts.length-1 && pi<PORT_TYPES.length;i+=2,pi++){
    borderVerts[i].port   = PORT_TYPES[pi];
    borderVerts[i+1].port = PORT_TYPES[pi];
  }

  // 5. build a tileMap for quick lookup
  const tileMap = {};
  tiles.forEach(t => tileMap[hexKey(t.q,t.r)] = t);

  return {tiles, tileMap, vertices, edges};
}

// ─── Graph helpers ────────────────────────────────────────────────────────────
// Returns array of vertex keys adjacent (connected by an edge) to vKey
function adjacentVertices(vKey, board){
  const result = [];
  Object.values(board.edges).forEach(e => {
    const [a,b] = edgeEndpoints(e.key, board);
    if(a===vKey && b) result.push(b);
    else if(b===vKey && a) result.push(a);
  });
  return result;
}

// Returns the two vertex keys at the ends of an edge
function edgeEndpoints(eKey, board){
  // edge key is "hk1||hk2" — find vertices whose tileKeys contain BOTH hex keys
  const [hk1,hk2] = eKey.split('||');
  const matches = Object.keys(board.vertices).filter(vk=>{
    const tks = board.vertices[vk].tileKeys;
    return tks.includes(hk1) && tks.includes(hk2);
  });
  return [matches[0]||null, matches[1]||null];
}

// Returns edge keys touching a vertex
function edgesAtVertex(vKey, board){
  return Object.keys(board.edges).filter(ek=>{
    const [a,b] = edgeEndpoints(ek,board);
    return a===vKey||b===vKey;
  });
}

// Returns vertex keys of all vertices on tiles adjacent to a hex
function verticesOfHex(q,r,board){
  const keys = [];
  for(let i=0;i<6;i++){
    const vk = vertexKey(q,r,i);
    if(board.vertices[vk]) keys.push(vk);
  }
  return keys;
}

// Longest road DFS
function longestRoadFor(playerId, board){
  const playerEdgeSet = new Set(
    Object.values(board.edges).filter(e=>e.owner===playerId).map(e=>e.key)
  );
  if(playerEdgeSet.size===0) return 0;

  // build adjacency restricted to player's roads
  const adj = {};
  playerEdgeSet.forEach(ek=>{
    const [a,b] = edgeEndpoints(ek,board);
    if(!a||!b) return;
    if(!adj[a]) adj[a]=[];
    if(!adj[b]) adj[b]=[];
    adj[a].push({to:b,edge:ek});
    adj[b].push({to:a,edge:ek});
  });

  let best = 0;
  function dfs(v,usedEdges,len){
    best = Math.max(best,len);
    for(const {to,edge} of (adj[v]||[])){
      if(usedEdges.has(edge)) continue;
      const toV = board.vertices[to];
      // opponent settlement blocks
      if(toV && toV.owner && toV.owner!==playerId) continue;
      usedEdges.add(edge);
      dfs(to,usedEdges,len+1);
      usedEdges.delete(edge);
    }
  }
  Object.keys(adj).forEach(v => dfs(v,new Set(),0));
  return best;
}

// ─── Placement validation ─────────────────────────────────────────────────────
function canPlaceSettlement(vKey,playerId,board,isSetup){
  const v = board.vertices[vKey];
  if(!v||v.building) return false;
  // distance rule
  if(adjacentVertices(vKey,board).some(ak=>board.vertices[ak]?.building)) return false;
  if(isSetup) return true;
  // must connect to own road
  return edgesAtVertex(vKey,board).some(ek=>board.edges[ek]?.owner===playerId);
}

function canPlaceRoad(eKey,playerId,board,isSetup,lastVKey){
  const e = board.edges[eKey];
  if(!e||e.road) return false;
  const [v1,v2] = edgeEndpoints(eKey,board);
  if(!v1||!v2) return false;

  if(isSetup && lastVKey){
    return v1===lastVKey||v2===lastVKey;
  }

  for(const vk of [v1,v2]){
    const v = board.vertices[vk];
    // own settlement/city here
    if(v?.owner===playerId) return true;
    // own road connects here (not blocked by opponent)
    const hasOwnRoad = edgesAtVertex(vk,board).some(ek2=>ek2!==eKey&&board.edges[ek2]?.owner===playerId);
    if(hasOwnRoad && (!v?.building || v.owner===playerId)) return true;
  }
  return false;
}

// ─── Generic helpers ──────────────────────────────────────────────────────────
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){const j=0|Math.random()*(i+1);[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}
function rollDice(){ return [1+(Math.random()*6|0), 1+(Math.random()*6|0)]; }
function canAfford(res,cost){ return Object.entries(cost).every(([r,n])=>(res[r]||0)>=n); }
function deduct(res,cost){
  const r={...res};
  for(const [k,n] of Object.entries(cost)) r[k]=(r[k]||0)-n;
  return r;
}
function emptyRes(){ return {wood:0,brick:0,sheep:0,wheat:0,ore:0}; }

// ─── VP calculation ───────────────────────────────────────────────────────────
function calcVP(player,room){
  let vp=0;
  Object.values(room.board.vertices).forEach(v=>{
    if(v.owner!==player.id) return;
    vp += v.building==='city'?2:1;
  });
  if(room.longestRoad===player.id) vp+=2;
  if(room.largestArmy===player.id) vp+=2;
  return vp;
}

// ─── Bank port ratio ──────────────────────────────────────────────────────────
function bankRatio(playerId,resource,room){
  let ratio=4;
  Object.values(room.board.vertices).forEach(v=>{
    if(v.owner!==playerId||!v.port) return;
    if(v.port==='3:1') ratio=Math.min(ratio,3);
    if(v.port===resource) ratio=Math.min(ratio,2);
  });
  return ratio;
}

// ─── Resource distribution ────────────────────────────────────────────────────
function distributeResources(room,roll){
  room.board.tiles.forEach(tile=>{
    if(tile.number!==roll||tile.robber) return;
    const res = TERRAIN_RESOURCE[tile.terrain];
    if(!res) return;
    verticesOfHex(tile.q,tile.r,room.board).forEach(vk=>{
      const v = room.board.vertices[vk];
      if(!v?.owner) return;
      const p = room.players.find(p=>p.id===v.owner);
      if(!p) return;
      p.resources[res] = (p.resources[res]||0) + (v.building==='city'?2:1);
    });
  });
}

// ─── Special card check ───────────────────────────────────────────────────────
function updateSpecialCards(room){
  // Longest Road (min 5)
  let bestLen=4, bestPid=null;
  room.players.forEach(p=>{
    const len = longestRoadFor(p.id,room.board);
    if(len>bestLen){bestLen=len;bestPid=p.id;}
  });
  if(bestPid && bestPid!==room.longestRoad){
    room.longestRoad=bestPid;
    log(room,`🛣️ ${room.players.find(p=>p.id===bestPid).name} takes Longest Road!`);
  }
  // Largest Army (min 3)
  let bestK=2, bestAid=null;
  room.players.forEach(p=>{
    if(p.knights>bestK){bestK=p.knights;bestAid=p.id;}
  });
  if(bestAid && bestAid!==room.largestArmy){
    room.largestArmy=bestAid;
    log(room,`⚔️ ${room.players.find(p=>p.id===bestAid).name} takes Largest Army!`);
  }
}

// ─── Turn/setup helpers ───────────────────────────────────────────────────────
function advanceTurn(room){
  room.diceRolled=false;
  room.diceResult=null;
  room.devCardPlayed=false;
  room.tradeOffer=null;
  room.freeRoads=0;
  room.turn=(room.turn+1)%room.players.length;
}

function advanceSetup(room){
  if(room.setupForward){
    if(room.setupIndex<room.players.length-1){ room.setupIndex++; }
    else{ room.setupForward=false; room.setupRound=2; }
  } else {
    if(room.setupIndex>0){ room.setupIndex--; }
    else{
      room.phase='playing';
      room.turn=0;
      log(room,'Setup complete — game begins!');
    }
  }
  room.setupLastVertex=null;
}

// ─── Room factory ─────────────────────────────────────────────────────────────
function createRoom(id){
  return {
    id, phase:'lobby',
    players:[],
    board:null, deck:[],
    turn:0,
    setupRound:1, setupIndex:0, setupForward:true, setupLastVertex:null,
    diceResult:null, diceRolled:false,
    robberActive:false,
    devCardPlayed:false,
    freeRoads:0,
    longestRoad:null, largestArmy:null,
    tradeOffer:null,
    log:[],
  };
}
function log(room,msg){ room.log.push(msg); if(room.log.length>30) room.log.shift(); }

// ─── Public state (sent to all) ───────────────────────────────────────────────
function publicState(room){
  return {
    phase: room.phase,
    turn: room.turn,
    setupRound: room.setupRound,
    setupIndex: room.setupIndex,
    setupForward: room.setupForward,
    diceResult: room.diceResult,
    diceRolled: room.diceRolled,
    robberActive: room.robberActive,
    devCardPlayed: room.devCardPlayed,
    freeRoads: room.freeRoads,
    longestRoad: room.longestRoad,
    largestArmy: room.largestArmy,
    tradeOffer: room.tradeOffer,
    log: room.log.slice(-10),
    board: room.board,
    players: room.players.map(p=>({
      id:p.id, name:p.name, color:p.color,
      resourceCount: Object.values(p.resources).reduce((a,b)=>a+b,0),
      devCardCount: p.devCards.length,
      knights: p.knights,
      vp: calcVP(p,room),
    })),
  };
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcast(nsp,room){
  const pub = publicState(room);
  room.players.forEach(p=>{
    const sock = nsp.sockets.get(p.id);
    if(!sock) return;
    sock.emit('state',{...pub, mine:{resources:p.resources, devCards:p.devCards}});
  });
}

// ─── Win check ────────────────────────────────────────────────────────────────
function checkWin(nsp,room){
  for(const p of room.players){
    const vp = calcVP(p,room) + p.devCards.filter(c=>c==='victoryPoint').length;
    if(vp>=WIN_VP){
      room.phase='ended';
      log(room,`🏆 ${p.name} wins with ${vp} VP!`);
      broadcast(nsp,room);
      return true;
    }
  }
  return false;
}

// ─── Rooms store ─────────────────────────────────────────────────────────────
const rooms = {};

// ─── Register namespace ───────────────────────────────────────────────────────
function registerHexlandsGame(nsp){
  nsp.on('connection', socket=>{
    console.log('[hexlands] connect', socket.id);

    function getRoom(){ return rooms[socket.data.roomId]; }

    // ── join ──────────────────────────────────────────────────────────────────
    socket.on('join',({roomId,name})=>{
      if(!roomId||!name){ socket.emit('err','Missing room or name'); return; }
      const rid = String(roomId).toUpperCase().trim().slice(0,20);
      if(!rooms[rid]) rooms[rid]=createRoom(rid);
      const room = rooms[rid];

      if(room.phase!=='lobby'){ socket.emit('err','Game already started'); return; }
      if(room.players.length>=6){ socket.emit('err','Room is full'); return; }
      if(room.players.find(p=>p.id===socket.id)) return;

      const color = COLORS[room.players.length];
      room.players.push({
        id:socket.id, name:String(name).trim().slice(0,20)||'Player',
        color, resources:emptyRes(), devCards:[], knights:0,
      });
      socket.join(rid);
      socket.data.roomId = rid;
      log(room,`${name} joined.`);
      broadcast(nsp,room);
    });

    // ── start ─────────────────────────────────────────────────────────────────
    socket.on('start',()=>{
      const room = getRoom();
      if(!room||room.phase!=='lobby'){ socket.emit('err','Cannot start now'); return; }
      if(room.players.length<2){ socket.emit('err','Need at least 2 players'); return; }
      if(room.players[0].id!==socket.id){ socket.emit('err','Only the host can start'); return; }

      room.board = buildBoard();
      room.deck  = shuffle([...DEV_DECK]);
      room.phase = 'setup';
      room.setupIndex=0; room.setupForward=true; room.setupRound=1;
      log(room,'Game started — setup phase begins!');
      broadcast(nsp,room);
    });

    // ── placeSettlement ───────────────────────────────────────────────────────
    socket.on('placeSettlement',({vKey})=>{
      const room=getRoom(); if(!room||!room.board) return;
      const isSetup = room.phase==='setup';
      const actor   = isSetup ? room.players[room.setupIndex] : room.players[room.turn];
      if(!actor||actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!isSetup&&!room.diceRolled){ socket.emit('err','Roll dice first'); return; }
      if(!isSetup&&!canAfford(actor.resources,BUILD_COSTS.settlement)){ socket.emit('err','Not enough resources'); return; }

      if(!canPlaceSettlement(vKey,socket.id,room.board,isSetup)){ socket.emit('err','Invalid placement'); return; }

      room.board.vertices[vKey].building='settlement';
      room.board.vertices[vKey].owner=socket.id;

      if(isSetup){
        room.setupLastVertex=vKey;
        // round 2: gift resources from adjacent tiles
        if(room.setupRound===2){
          const tile2res = {};
          verticesOfHex_byVKey(vKey,room.board).forEach(tk=>{
            const tile = room.board.tileMap[tk];
            if(!tile) return;
            const res = TERRAIN_RESOURCE[tile.terrain];
            if(res) tile2res[res]=(tile2res[res]||0)+1;
          });
          for(const [res,n] of Object.entries(tile2res)) actor.resources[res]=(actor.resources[res]||0)+n;
        }
        log(room,`${actor.name} placed a settlement.`);
      } else {
        actor.resources=deduct(actor.resources,BUILD_COSTS.settlement);
        log(room,`${actor.name} built a settlement.`);
        if(!checkWin(nsp,room)) broadcast(nsp,room);
        return;
      }
      broadcast(nsp,room);
    });

    // ── placeRoad ─────────────────────────────────────────────────────────────
    socket.on('placeRoad',({eKey})=>{
      const room=getRoom(); if(!room||!room.board) return;
      const isSetup = room.phase==='setup';
      const isFree  = room.freeRoads>0;
      const actor   = isSetup ? room.players[room.setupIndex] : room.players[room.turn];
      if(!actor||actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!isSetup&&!room.diceRolled){ socket.emit('err','Roll dice first'); return; }
      if(!isSetup&&!isFree&&!canAfford(actor.resources,BUILD_COSTS.road)){ socket.emit('err','Not enough resources'); return; }

      if(!canPlaceRoad(eKey,socket.id,room.board,isSetup,room.setupLastVertex)){ socket.emit('err','Invalid road'); return; }

      room.board.edges[eKey].road=true;
      room.board.edges[eKey].owner=socket.id;

      if(isSetup){
        log(room,`${actor.name} placed a road.`);
        advanceSetup(room);
      } else if(isFree){
        room.freeRoads--;
        log(room,`${actor.name} built a road (free). ${room.freeRoads} left.`);
      } else {
        actor.resources=deduct(actor.resources,BUILD_COSTS.road);
        log(room,`${actor.name} built a road.`);
      }
      updateSpecialCards(room);
      if(!checkWin(nsp,room)) broadcast(nsp,room);
    });

    // ── buildCity ─────────────────────────────────────────────────────────────
    socket.on('buildCity',({vKey})=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!room.diceRolled){ socket.emit('err','Roll dice first'); return; }
      const v=room.board.vertices[vKey];
      if(!v||v.building!=='settlement'||v.owner!==socket.id){ socket.emit('err','No your settlement here'); return; }
      if(!canAfford(actor.resources,BUILD_COSTS.city)){ socket.emit('err','Not enough resources'); return; }
      v.building='city';
      actor.resources=deduct(actor.resources,BUILD_COSTS.city);
      log(room,`${actor.name} upgraded to a city!`);
      if(!checkWin(nsp,room)) broadcast(nsp,room);
    });

    // ── rollDice ──────────────────────────────────────────────────────────────
    socket.on('rollDice',()=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(room.diceRolled){ socket.emit('err','Already rolled'); return; }

      const dice=rollDice();
      room.diceResult=dice;
      room.diceRolled=true;
      const roll=dice[0]+dice[1];
      log(room,`${actor.name} rolled ${dice[0]}+${dice[1]} = ${roll}`);

      if(roll===7){
        // discard half for players with >7
        room.players.forEach(p=>{
          const total=Object.values(p.resources).reduce((a,b)=>a+b,0);
          if(total>7){
            const n=Math.floor(total/2);
            let left=n;
            for(const r of RESOURCES){ while(p.resources[r]>0&&left>0){p.resources[r]--;left--;} }
            log(room,`${p.name} discarded ${n} cards.`);
          }
        });
        room.robberActive=true;
        log(room,'Robber! Current player must move it.');
      } else {
        distributeResources(room,roll);
      }
      broadcast(nsp,room);
    });

    // ── moveRobber ────────────────────────────────────────────────────────────
    socket.on('moveRobber',({tileId})=>{
      const room=getRoom(); if(!room||!room.robberActive) return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      const tile = room.board.tiles[tileId];
      if(!tile){ socket.emit('err','Invalid tile'); return; }
      room.board.tiles.forEach(t=>t.robber=false);
      tile.robber=true;
      room.robberActive=false;
      log(room,`${actor.name} moved the robber to ${tile.terrain}.`);
      broadcast(nsp,room);
    });

    // ── endTurn ───────────────────────────────────────────────────────────────
    socket.on('endTurn',()=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!room.diceRolled){ socket.emit('err','Must roll first'); return; }
      if(room.robberActive){ socket.emit('err','Must place robber first'); return; }
      if(room.freeRoads>0){ socket.emit('err','Must place free roads first'); return; }
      log(room,`${actor.name} ended their turn.`);
      advanceTurn(room);
      broadcast(nsp,room);
    });

    // ── buyDevCard ────────────────────────────────────────────────────────────
    socket.on('buyDevCard',()=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!room.diceRolled){ socket.emit('err','Roll first'); return; }
      if(!canAfford(actor.resources,BUILD_COSTS.devCard)){ socket.emit('err','Not enough resources'); return; }
      if(!room.deck.length){ socket.emit('err','Dev card deck empty'); return; }
      actor.resources=deduct(actor.resources,BUILD_COSTS.devCard);
      actor.devCards.push(room.deck.pop());
      log(room,`${actor.name} bought a dev card.`);
      if(!checkWin(nsp,room)) broadcast(nsp,room);
    });

    // ── playDevCard ───────────────────────────────────────────────────────────
    socket.on('playDevCard',({card,data})=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(room.devCardPlayed){ socket.emit('err','Already played a card'); return; }
      const idx=actor.devCards.indexOf(card);
      if(idx===-1){ socket.emit('err','You do not have that card'); return; }
      actor.devCards.splice(idx,1);
      room.devCardPlayed=true;

      if(card==='knight'){
        actor.knights++;
        room.robberActive=true;
        updateSpecialCards(room);
        log(room,`${actor.name} played Knight!`);
      } else if(card==='roadBuilding'){
        room.freeRoads=2;
        log(room,`${actor.name} played Road Building — 2 free roads!`);
      } else if(card==='yearOfPlenty'){
        const r1=data?.r1, r2=data?.r2;
        if(r1&&RESOURCES.includes(r1)) actor.resources[r1]=(actor.resources[r1]||0)+1;
        if(r2&&RESOURCES.includes(r2)) actor.resources[r2]=(actor.resources[r2]||0)+1;
        log(room,`${actor.name} played Year of Plenty!`);
      } else if(card==='monopoly'){
        const res=data?.resource;
        if(res&&RESOURCES.includes(res)){
          let stolen=0;
          room.players.forEach(p=>{ if(p.id!==socket.id){stolen+=p.resources[res]||0;p.resources[res]=0;} });
          actor.resources[res]=(actor.resources[res]||0)+stolen;
          log(room,`${actor.name} played Monopoly on ${res}! Stole ${stolen}.`);
        }
      } else if(card==='victoryPoint'){
        actor.devCards.push('victoryPoint'); // keep it hidden until win check
        room.devCardPlayed=false;
        log(room,`${actor.name} revealed a Victory Point!`);
      }
      if(!checkWin(nsp,room)) broadcast(nsp,room);
    });

    // ── proposeTrade ──────────────────────────────────────────────────────────
    socket.on('proposeTrade',({give,want,toBank})=>{
      const room=getRoom(); if(!room||room.phase!=='playing') return;
      const actor=room.players[room.turn];
      if(actor.id!==socket.id){ socket.emit('err','Not your turn'); return; }
      if(!room.diceRolled){ socket.emit('err','Roll first'); return; }
      if(!canAfford(actor.resources,give)){ socket.emit('err','Not enough resources'); return; }

      if(toBank){
        // validate ratios
        const giveRes = Object.entries(give).filter(([,n])=>n>0);
        if(giveRes.length!==1){ socket.emit('err','Bank trade: offer exactly one resource type'); return; }
        const [res,n]=giveRes[0];
        const ratio=bankRatio(socket.id,res,room);
        const wantTotal=Object.values(want).reduce((a,b)=>a+b,0);
        if(n%ratio!==0||n/ratio!==wantTotal){ socket.emit('err',`Need ${ratio}:1 for ${res}`); return; }
        actor.resources=deduct(actor.resources,give);
        for(const [r,v] of Object.entries(want)) actor.resources[r]=(actor.resources[r]||0)+v;
        log(room,`${actor.name} traded with the bank.`);
        broadcast(nsp,room);
      } else {
        room.tradeOffer={from:socket.id,give,want};
        log(room,`${actor.name} proposes a trade.`);
        broadcast(nsp,room);
      }
    });

    socket.on('acceptTrade',()=>{
      const room=getRoom(); if(!room||!room.tradeOffer) return;
      if(room.tradeOffer.from===socket.id){ socket.emit('err','Cannot accept your own trade'); return; }
      const from=room.players.find(p=>p.id===room.tradeOffer.from);
      const to=room.players.find(p=>p.id===socket.id);
      if(!from||!to) return;
      if(!canAfford(from.resources,room.tradeOffer.give)){ socket.emit('err','Offerer no longer has those resources'); return; }
      if(!canAfford(to.resources,room.tradeOffer.want)){ socket.emit('err','You cannot afford this trade'); return; }
      from.resources=deduct(from.resources,room.tradeOffer.give);
      to.resources=deduct(to.resources,room.tradeOffer.want);
      for(const [r,n] of Object.entries(room.tradeOffer.give)) to.resources[r]=(to.resources[r]||0)+n;
      for(const [r,n] of Object.entries(room.tradeOffer.want)) from.resources[r]=(from.resources[r]||0)+n;
      room.tradeOffer=null;
      log(room,`Trade completed between ${from.name} and ${to.name}.`);
      broadcast(nsp,room);
    });

    socket.on('cancelTrade',()=>{
      const room=getRoom(); if(!room) return;
      room.tradeOffer=null;
      broadcast(nsp,room);
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect',()=>{
      const room=getRoom(); if(!room) return;
      const idx=room.players.findIndex(p=>p.id===socket.id);
      if(idx===-1) return;
      log(room,`${room.players[idx].name} disconnected.`);
      room.players.splice(idx,1);
      if(!room.players.length){ delete rooms[room.id]; return; }
      if(room.turn>=room.players.length) room.turn=0;
      if(room.setupIndex>=room.players.length) room.setupIndex=0;
      broadcast(nsp,room);
    });
  });
}

// Helper: given a vertex key, return the hex keys (tileMap keys) it touches
function verticesOfHex_byVKey(vKey,board){
  return board.vertices[vKey]?.tileKeys || [];
}

module.exports = { registerHexlandsGame };
