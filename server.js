const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();

// 인원수별 게임 설정 (공식 규칙 + 5/6인 확장)
const GAME_CONFIG = {
  2: { maxLevels: 12, lives: 2, shurikens: 1, lifeBonus: [3, 6, 9], shurikenBonus: [2, 5, 8] },
  3: { maxLevels: 10, lives: 3, shurikens: 1, lifeBonus: [3, 6, 9], shurikenBonus: [2, 5, 8] },
  4: { maxLevels: 8,  lives: 4, shurikens: 1, lifeBonus: [3, 6],    shurikenBonus: [2, 5, 8] },
  5: { maxLevels: 7,  lives: 4, shurikens: 1, lifeBonus: [3, 6],    shurikenBonus: [2, 4, 6] },
  6: { maxLevels: 6,  lives: 5, shurikens: 1, lifeBonus: [3, 5],    shurikenBonus: [2, 4] },
};
const MAX_LIVES = 6;
const MAX_SHURIKENS = 4;
const ALLOWED_EMOJIS = ['👍', '😂', '😮', '😱', '🔥', '🎉', '🤔', '😎', '🤏', '🤚', '🖕', '🍌', '😐'];

function config(n) {
  return GAME_CONFIG[n] || GAME_CONFIG[6];
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(id));
  return id;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function findRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.id === socketId)) return room;
  }
  return null;
}

function dealCards(room) {
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  let idx = 0;
  for (const p of room.players) {
    p.cards = deck.slice(idx, idx + room.level).sort((a, b) => a - b);
    p.played = false;
    idx += room.level;
  }
  room.pile = [];
  room.topCard = 0;
  room.lastPlayedBy = null;
  room.shurikenVotes = new Set();
  room.readyVotes = new Set();
  room.phase = 'playing';
  room.culprit = null;
}

function publicState(room, forId) {
  const me = room.players.find((p) => p.id === forId);
  return {
    roomId: room.id,
    phase: room.phase,
    level: room.level,
    maxLevels: room.maxLevels,
    lives: room.lives,
    shurikens: room.shurikens,
    maxLives: room.livesPeak || room.lives,
    maxShurikens: room.shurikensPeak || room.shurikens,
    topCard: room.topCard,
    pileCount: room.pile.length,
    lastPlayedBy: room.lastPlayedBy,
    culprit: room.culprit || null,
    myId: forId,
    myCards: me ? me.cards : [],
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      cardCount: p.cards.length,
      shurikenVote: room.shurikenVotes.has(p.id),
      readyVote: room.readyVotes.has(p.id),
      connected: p.connected,
    })),
    shurikenVoteCount: room.shurikenVotes.size,
    readyVoteCount: room.readyVotes.size,
    playerCount: room.players.filter((p) => p.connected).length,
  };
}

function broadcast(room) {
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('state', publicState(room, p.id));
  }
}

function activePlayers(room) {
  return room.players.filter((p) => p.connected);
}

function applyLevelBonus(room) {
  const cfg = config(activePlayers(room).length);
  const bonusLife = cfg.lifeBonus.includes(room.level);
  const bonusShuriken = cfg.shurikenBonus.includes(room.level);
  if (bonusLife) room.lives = Math.min(room.lives + 1, MAX_LIVES);
  if (bonusShuriken) room.shurikens = Math.min(room.shurikens + 1, MAX_SHURIKENS);
  room.livesPeak = Math.max(room.livesPeak || 0, room.lives);
  room.shurikensPeak = Math.max(room.shurikensPeak || 0, room.shurikens);
  return { bonusLife, bonusShuriken };
}

function checkLevelEnd(room) {
  const remaining = room.players.reduce((s, p) => s + p.cards.length, 0);
  if (remaining > 0) return;

  if (room.level >= room.maxLevels) {
    room.phase = 'victory';
    io.to(room.id).emit('notify', {
      type: 'victory',
      message: '🎉 모든 레벨을 클리어했습니다! 완벽한 팀워크!',
    });
  } else {
    const bonus = applyLevelBonus(room);
    room.phase = 'level-complete';
    room.readyVotes = new Set();
    io.to(room.id).emit('notify', {
      type: 'level-complete',
      message: `레벨 ${room.level} 클리어!`,
      level: room.level,
      nextLevel: room.level + 1,
      ...bonus,
    });
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => {
    const nick = (name || '').trim().slice(0, 12);
    if (!nick) return socket.emit('error-msg', '닉네임을 입력해주세요.');
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      players: [{ id: socket.id, name: nick, cards: [], isHost: true, connected: true, played: false }],
      phase: 'lobby',
      level: 1,
      maxLevels: 0,
      lives: 0,
      shurikens: 0,
      pile: [],
      topCard: 0,
      lastPlayedBy: null,
      shurikenVotes: new Set(),
      readyVotes: new Set(),
      culprit: null,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('joined', { roomId });
    broadcast(room);
  });

  socket.on('join-room', ({ roomId, name }) => {
    const nick = (name || '').trim().slice(0, 12);
    const code = (roomId || '').trim().toUpperCase();
    if (!nick) return socket.emit('error-msg', '닉네임을 입력해주세요.');
    const room = rooms.get(code);
    if (!room) return socket.emit('error-msg', '방을 찾을 수 없습니다.');
    if (room.phase !== 'lobby') return socket.emit('error-msg', '이미 게임이 진행 중입니다.');
    if (room.players.length >= 6) return socket.emit('error-msg', '방이 가득 찼습니다. (최대 6인)');
    if (room.players.some((p) => p.name === nick)) return socket.emit('error-msg', '같은 닉네임이 이미 있습니다.');

    room.players.push({ id: socket.id, name: nick, cards: [], isHost: false, connected: true, played: false });
    socket.join(code);
    socket.emit('joined', { roomId: code });
    io.to(code).emit('notify', { type: 'player-joined', message: `${nick} 님이 입장했습니다.` });
    broadcast(room);
  });

  socket.on('start-game', () => {
    const room = findRoom(socket.id);
    if (!room) return;
    const me = room.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return socket.emit('error-msg', '방장만 시작할 수 있습니다.');
    if (room.players.length < 2) return socket.emit('error-msg', '최소 2명이 필요합니다.');
    if (room.phase !== 'lobby') return;

    const cfg = config(room.players.length);
    room.maxLevels = cfg.maxLevels;
    room.lives = cfg.lives;
    room.shurikens = cfg.shurikens;
    room.livesPeak = cfg.lives;
    room.shurikensPeak = cfg.shurikens;
    room.level = 1;
    dealCards(room);
    io.to(room.id).emit('notify', { type: 'game-start', message: '게임 시작! 집중하세요.' });
    broadcast(room);
  });

  socket.on('play-card', ({ card }) => {
    const room = findRoom(socket.id);
    if (!room || room.phase !== 'playing') return;
    const me = room.players.find((p) => p.id === socket.id);
    if (!me || !me.cards.includes(card)) return;

    // 손에서 제거 후 더미에 올림
    me.cards = me.cards.filter((c) => c !== card);
    room.pile.push(card);
    room.topCard = card;
    room.lastPlayedBy = me.name;

    // 실수 판정: 방금 낸 카드보다 작은 카드가 누군가에게 남아있는가?
    const lower = [];
    for (const p of room.players) {
      for (const c of p.cards) {
        if (c < card) lower.push({ player: p.name, card: c });
      }
    }

    if (lower.length > 0) {
      room.lives -= 1;
      // 낸 카드보다 작은 카드는 전원 버림
      for (const p of room.players) p.cards = p.cards.filter((c) => c >= card);
      lower.sort((a, b) => a.card - b.card);

      io.to(room.id).emit('notify', {
        type: 'mistake',
        message: `💔 ${me.name} 님이 ${card}를 냈지만 더 낮은 카드가 있었습니다!`,
        playedCard: card,
        playedBy: me.name,
        lowerCards: lower,
        livesLeft: room.lives,
      });

      if (room.lives <= 0) {
        room.phase = 'gameover';
        room.culprit = me.name;
        io.to(room.id).emit('notify', {
          type: 'gameover',
          message: `게임 오버 — 레벨 ${room.level}에서 멈췄습니다.`,
          level: room.level,
        });
        broadcast(room);
        return;
      }
    } else {
      io.to(room.id).emit('notify', {
        type: 'card-played',
        message: `${me.name}: ${card}`,
        playedCard: card,
        playedBy: me.name,
        playerId: me.id,
      });
    }

    checkLevelEnd(room);
    broadcast(room);
  });

  socket.on('vote-shuriken', () => {
    const room = findRoom(socket.id);
    if (!room || room.phase !== 'playing') return;
    if (room.shurikens <= 0) return socket.emit('error-msg', '남은 표창이 없습니다.');
    const voter = room.players.find((p) => p.id === socket.id);
    if (!voter || voter.cards.length === 0) return; // 버릴 카드가 없으면 투표 불가

    if (room.shurikenVotes.has(socket.id)) room.shurikenVotes.delete(socket.id);
    else room.shurikenVotes.add(socket.id);

    const need = activePlayers(room).filter((p) => p.cards.length > 0).length;
    if (room.shurikenVotes.size >= need && need > 0) {
      room.shurikens -= 1;
      
      let lowestPlayer = null;
      let lowestCard = Infinity;

      for (const p of room.players) {
        if (p.cards.length > 0) {
          const pLowest = Math.min(...p.cards);
          if (pLowest < lowestCard) {
            lowestCard = pLowest;
            lowestPlayer = p;
          }
        }
      }

      const discarded = [];
      if (lowestPlayer) {
        lowestPlayer.cards = lowestPlayer.cards.filter((c) => c !== lowestCard);
        discarded.push({ player: lowestPlayer.name, card: lowestCard });
        room.pile.push(lowestCard);
        room.topCard = lowestCard;
        room.lastPlayedBy = '표창';
      }

      room.shurikenVotes = new Set();

      io.to(room.id).emit('notify', {
        type: 'shuriken',
        message: `🌟 표창 사용! 가장 낮은 카드 ${lowestCard}을(를) 찾아 버렸습니다.`,
        discarded,
        shurikensLeft: room.shurikens,
      });

      checkLevelEnd(room);
    }
    broadcast(room);
  });

  socket.on('ready-next', () => {
    const room = findRoom(socket.id);
    if (!room || room.phase !== 'level-complete') return;
    room.readyVotes.add(socket.id);
    if (room.readyVotes.size >= activePlayers(room).length) {
      room.level += 1;
      dealCards(room);
      io.to(room.id).emit('notify', { type: 'next-level', message: `레벨 ${room.level} 시작!` });
    }
    broadcast(room);
  });

  socket.on('restart-game', () => {
    const room = findRoom(socket.id);
    if (!room) return;
    const me = room.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return socket.emit('error-msg', '방장만 다시 시작할 수 있습니다.');
    if (!['gameover', 'victory'].includes(room.phase)) return;

    // 끊긴 플레이어 정리
    room.players = room.players.filter((p) => p.connected);
    if (room.players.length < 2) {
      room.phase = 'lobby';
      broadcast(room);
      return;
    }
    const cfg = config(room.players.length);
    room.maxLevels = cfg.maxLevels;
    room.lives = cfg.lives;
    room.shurikens = cfg.shurikens;
    room.livesPeak = cfg.lives;
    room.shurikensPeak = cfg.shurikens;
    room.level = 1;
    dealCards(room);
    broadcast(room);
  });

  socket.on('back-to-lobby', () => {
    const room = findRoom(socket.id);
    if (!room) return;
    const me = room.players.find((p) => p.id === socket.id);
    if (!me?.isHost) return;
    room.players = room.players.filter((p) => p.connected);
    room.phase = 'lobby';
    room.shurikenVotes = new Set();
    room.readyVotes = new Set();
    room.culprit = null;
    for (const p of room.players) p.cards = [];
    broadcast(room);
  });

  socket.on('send-emoji', ({ emoji }) => {
    const room = findRoom(socket.id);
    if (!room) return;
    if (!ALLOWED_EMOJIS.includes(emoji)) return;
    const me = room.players.find((p) => p.id === socket.id);
    if (!me) return;
    io.to(room.id).emit('emoji', { playerId: me.id, name: me.name, emoji });
  });

  socket.on('leave-room', () => handleLeave(socket.id));
  socket.on('disconnect', () => handleLeave(socket.id));

  function handleLeave(id) {
    const room = findRoom(id);
    if (!room) return;
    const leaving = room.players.find((p) => p.id === id);
    if (!leaving) return;

    if (room.phase === 'lobby') {
      // 대기실에서는 완전히 제거
      room.players = room.players.filter((p) => p.id !== id);
    } else {
      // 게임 중에는 연결 끊김 처리 + 손패 비움
      leaving.connected = false;
      leaving.cards = [];
    }
    room.shurikenVotes.delete(id);
    room.readyVotes.delete(id);

    const stillHere = room.players.filter((p) => p.connected);
    if (stillHere.length === 0) {
      rooms.delete(room.id);
      return;
    }
    // 방장 위임
    if (!stillHere.some((p) => p.isHost)) stillHere[0].isHost = true;

    io.to(room.id).emit('notify', { type: 'player-left', message: `${leaving.name} 님이 나갔습니다.` });

    // 게임 진행 중 인원 부족 시 종료
    if (['playing', 'level-complete'].includes(room.phase) && stillHere.length < 2) {
      room.phase = 'gameover';
      io.to(room.id).emit('notify', { type: 'gameover', message: '플레이어가 부족하여 게임을 종료합니다.' });
    } else if (['playing'].includes(room.phase)) {
      // 떠난 사람 카드가 비워졌으니 레벨 종료 가능성 체크
      checkLevelEnd(room);
    }
    broadcast(room);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 The Mind 서버 실행 중 → http://localhost:${PORT}`);
});
