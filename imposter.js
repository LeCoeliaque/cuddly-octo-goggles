// ─── Impostor Game Module ─────────────────────────────────────────────────────
// Attach this to a Socket.IO server instance via registerImpostorGame(io)

const WORD_CATEGORIES = {
  Food: [
    'Pizza','Sushi','Tacos','Burger','Ramen','Croissant','Spaghetti','Curry',
    'Dumpling','Pancakes','Cheesecake','Burrito','Lasagna','Falafel','Waffle',
    'Kebab','Pho','Paella','Risotto','Gyoza',
  ],
  Animals: [
    'Elephant','Penguin','Octopus','Giraffe','Platypus','Chameleon','Narwhal',
    'Axolotl','Capybara','Flamingo','Pangolin','Quokka','Fennec','Sloth','Mantis',
    'Tardigrade','Meerkat','Binturong','Numbat','Blobfish',
  ],
  Places: [
    'Library','Casino','Airport','Hospital','Lighthouse','Submarine','Circus',
    'Observatory','Monastery','Colosseum','Sauna','Igloo','Treehouse','Volcano',
    'Catacombs','Marina','Planetarium','Bazaar','Fortress','Glacier',
  ],
  Movies: [
    'Inception','Titanic','Gladiator','Frozen','Alien','Jaws','Dune','Shrek',
    'Matrix','Clueless','Parasite','Beetlejuice','Spirited Away','Joker','Grease',
    'Arrival','Memento','Hereditary','Moonlight','Zootopia',
  ],
  Sports: [
    'Surfing','Archery','Fencing','Curling','Polo','Bobsled','Volleyball',
    'Lacrosse','Badminton','Skeleton','Weightlifting','Biathlon','Kabaddi',
    'Squash','Hurling','Sepak Takraw','Canoe','Triathlon','Bocce','Capoeira',
  ],
  Occupations: [
    'Astronaut','Sommelier','Taxidermist','Falconer','Luthier','Cryptographer',
    'Farrier','Glassblower','Chocolatier','Archivist','Puppeteer','Osteopath',
    'Mycologist','Perfumer','Cartographer','Wainwright','Mortician','Epidemiologist',
    'Stevedore','Cooper',
  ],
};

const impostorRooms = {};

function createImpostorRoom(roomId) {
  return {
    id: roomId,
    players: [],        // { id, name, isHost, role: 'crewmate'|'impostor', clue, vote }
    phase: 'waiting',   // waiting | clues | voting | guess | ended
    category: null,
    word: null,
    clueOrder: [],      // player ids in clue-giving order
    clueIndex: 0,       // whose turn it is to give a clue
    votes: {},          // voterId -> targetId
    impostorGuess: null,
    result: null,       // { winner: 'crew'|'impostor', reason, word }
  };
}

function impostorPublicState(room) {
  return {
    phase: room.phase,
    category: room.category,
    clueOrder: room.clueOrder,
    clueIndex: room.clueIndex,
    votes: room.votes,
    result: room.result,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      clue: p.clue || null,
      vote: p.vote || null,
    })),
  };
}

// What each player privately sees (their own role + word if crewmate)
function impostorPrivateState(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return {};
  return {
    role: player.role,
    word: player.role === 'crewmate' ? room.word : null,
    category: room.category,
  };
}

function pickWordAndAssignRoles(room, category) {
  const words = WORD_CATEGORIES[category];
  room.word = words[Math.floor(Math.random() * words.length)];
  room.category = category;

  // Shuffle players, pick one impostor
  const shuffled = [...room.players].sort(() => Math.random() - 0.5);
  const impostorIdx = Math.floor(Math.random() * shuffled.length);
  room.players.forEach(p => {
    p.role = shuffled.findIndex(s => s.id === p.id) === impostorIdx
      ? 'impostor'
      : 'crewmate';
    p.clue = null;
    p.vote = null;
  });
  room.votes = {};
  room.clueOrder = shuffled.map(p => p.id);
  room.clueIndex = 0;
}

function tallyVotes(room) {
  const counts = {};
  room.players.forEach(p => { counts[p.id] = 0; });
  Object.values(room.votes).forEach(targetId => {
    if (counts[targetId] !== undefined) counts[targetId]++;
  });
  // Find max
  let maxVotes = 0;
  let votedOut = null;
  let tie = false;
  for (const [id, count] of Object.entries(counts)) {
    if (count > maxVotes) { maxVotes = count; votedOut = id; tie = false; }
    else if (count === maxVotes && maxVotes > 0) { tie = true; }
  }
  return { votedOut: tie ? null : votedOut, counts };
}

function registerImpostorGame(io) {
  const nsp = io.of('/impostor');

  nsp.on('connection', (socket) => {
    console.log('[Impostor] Connected:', socket.id);

    socket.on('joinRoom', ({ roomId, playerName }) => {
      if (!impostorRooms[roomId]) impostorRooms[roomId] = createImpostorRoom(roomId);
      const room = impostorRooms[roomId];
      if (room.phase !== 'waiting') { socket.emit('error', 'Game already in progress'); return; }
      if (room.players.find(p => p.id === socket.id)) return;

      const isHost = room.players.length === 0;
      room.players.push({
        id: socket.id,
        name: playerName || `Player ${room.players.length + 1}`,
        isHost,
        role: null,
        clue: null,
        vote: null,
      });

      socket.join(roomId);
      socket.data.impostorRoomId = roomId;
      nsp.to(roomId).emit('roomState', impostorPublicState(room));
      nsp.to(roomId).emit('message', `${playerName} joined.`);
    });

    socket.on('startGame', ({ category }) => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'waiting') return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player?.isHost) { socket.emit('error', 'Only the host can start'); return; }
      if (room.players.length < 3) { socket.emit('error', 'Need at least 3 players'); return; }
      if (!WORD_CATEGORIES[category]) { socket.emit('error', 'Invalid category'); return; }

      pickWordAndAssignRoles(room, category);
      room.phase = 'clues';

      // Send each player their private role info
      room.players.forEach(p => {
        nsp.to(p.id).emit('privateState', impostorPrivateState(room, p.id));
      });
      nsp.to(room.id).emit('roomState', impostorPublicState(room));
      nsp.to(room.id).emit('message', `Game started! Category: ${category}. Give your one-word clues in order.`);
    });

    socket.on('submitClue', ({ clue }) => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'clues') return;
      const currentPlayerId = room.clueOrder[room.clueIndex];
      if (socket.id !== currentPlayerId) { socket.emit('error', "It's not your turn"); return; }

      const trimmed = (clue || '').trim().split(/\s+/)[0]; // enforce one word
      if (!trimmed) { socket.emit('error', 'Clue cannot be empty'); return; }

      const player = room.players.find(p => p.id === socket.id);
      player.clue = trimmed;
      room.clueIndex++;

      if (room.clueIndex >= room.clueOrder.length) {
        // All clues in — move to voting
        room.phase = 'voting';
        nsp.to(room.id).emit('roomState', impostorPublicState(room));
        nsp.to(room.id).emit('message', 'All clues given! Vote for who you think the Impostor is.');
      } else {
        nsp.to(room.id).emit('roomState', impostorPublicState(room));
        const nextName = room.players.find(p => p.id === room.clueOrder[room.clueIndex])?.name;
        nsp.to(room.id).emit('message', `${player.name} gave clue: "${trimmed}". ${nextName}'s turn.`);
      }
    });

    socket.on('submitVote', ({ targetId }) => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'voting') return;
      if (!room.players.find(p => p.id === targetId)) { socket.emit('error', 'Invalid target'); return; }
      if (socket.id === targetId) { socket.emit('error', "You can't vote for yourself"); return; }

      room.votes[socket.id] = targetId;
      const voter = room.players.find(p => p.id === socket.id);
      voter.vote = targetId;

      const totalVoters = room.players.length;
      const votesCast = Object.keys(room.votes).length;

      nsp.to(room.id).emit('roomState', impostorPublicState(room));

      if (votesCast >= totalVoters) {
        resolveVotes(room, nsp);
      } else {
        nsp.to(room.id).emit('message', `${voter.name} voted. (${votesCast}/${totalVoters})`);
      }
    });

    // Impostor's word guess (after being voted out)
    socket.on('impostorGuess', ({ guess }) => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'guess') return;
      const impostor = room.players.find(p => p.role === 'impostor');
      if (!impostor || impostor.id !== socket.id) return;

      const trimmedGuess = (guess || '').trim().toLowerCase();
      const correct = trimmedGuess === room.word.toLowerCase();

      room.result = {
        winner: correct ? 'impostor' : 'crew',
        reason: correct
          ? `The Impostor guessed the word "${room.word}" correctly!`
          : `The Impostor guessed "${guess}" — wrong! The word was "${room.word}".`,
        word: room.word,
        impostor: impostor.name,
      };
      room.phase = 'ended';
      nsp.to(room.id).emit('roomState', impostorPublicState(room));
      nsp.to(room.id).emit('gameOver', room.result);
    });

    // Skip guess (impostor gives up)
    socket.on('impostorSkipGuess', () => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'guess') return;
      const impostor = room.players.find(p => p.role === 'impostor');
      if (!impostor || impostor.id !== socket.id) return;

      room.result = {
        winner: 'crew',
        reason: `The Impostor declined to guess. The word was "${room.word}".`,
        word: room.word,
        impostor: impostor.name,
      };
      room.phase = 'ended';
      nsp.to(room.id).emit('roomState', impostorPublicState(room));
      nsp.to(room.id).emit('gameOver', room.result);
    });

    socket.on('restartGame', () => {
      const room = impostorRooms[socket.data.impostorRoomId];
      if (!room || room.phase !== 'ended') return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player?.isHost) { socket.emit('error', 'Only the host can restart'); return; }
      room.phase = 'waiting';
      room.word = null;
      room.category = null;
      room.clueOrder = [];
      room.clueIndex = 0;
      room.votes = {};
      room.result = null;
      room.players.forEach(p => { p.role = null; p.clue = null; p.vote = null; });
      nsp.to(room.id).emit('roomState', impostorPublicState(room));
      nsp.to(room.id).emit('message', 'Game reset! Host can start a new round.');
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.impostorRoomId;
      if (!roomId || !impostorRooms[roomId]) return;
      const room = impostorRooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const name = room.players[idx].name;
        room.players.splice(idx, 1);
        // Pass host if needed
        if (room.players.length > 0 && !room.players.find(p => p.isHost)) {
          room.players[0].isHost = true;
        }
        nsp.to(roomId).emit('message', `${name} left.`);
        if (room.players.length === 0) { delete impostorRooms[roomId]; return; }
        nsp.to(roomId).emit('roomState', impostorPublicState(room));
      }
    });
  });
}

function resolveVotes(room, nsp) {
  const { votedOut, counts } = tallyVotes(room);

  if (!votedOut) {
    // Tie — crew loses (or you could re-vote; simple version: impostor wins)
    const impostor = room.players.find(p => p.role === 'impostor');
    room.result = {
      winner: 'impostor',
      reason: `It's a tie! The Impostor "${impostor.name}" escapes. The word was "${room.word}".`,
      word: room.word,
      impostor: impostor.name,
      counts,
    };
    room.phase = 'ended';
    nsp.to(room.id).emit('roomState', impostorPublicState(room));
    nsp.to(room.id).emit('gameOver', room.result);
    return;
  }

  const votedPlayer = room.players.find(p => p.id === votedOut);
  const impostor = room.players.find(p => p.role === 'impostor');

  if (votedPlayer.role === 'impostor') {
    // Crew found the impostor — impostor gets a guess
    room.phase = 'guess';
    nsp.to(room.id).emit('roomState', impostorPublicState(room));
    nsp.to(room.id).emit('message', `${votedPlayer.name} was voted out — they're the Impostor! They get one chance to guess the word.`);
    nsp.to(votedPlayer.id).emit('impostorGuessPrompt', { category: room.category });
  } else {
    // Wrong person voted out — impostor wins
    room.result = {
      winner: 'impostor',
      reason: `${votedPlayer.name} was innocent! The Impostor was "${impostor.name}". The word was "${room.word}".`,
      word: room.word,
      impostor: impostor.name,
      counts,
    };
    room.phase = 'ended';
    nsp.to(room.id).emit('roomState', impostorPublicState(room));
    nsp.to(room.id).emit('gameOver', room.result);
  }
}

module.exports = { registerImpostorGame, WORD_CATEGORIES };
