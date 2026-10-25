const { Game, GameError } = require('./game/game');

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRoomId(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 5; i++) {
      id += ROOM_ID_ALPHABET[Math.floor(Math.random() * ROOM_ID_ALPHABET.length)];
    }
    if (!existing.has(id)) return id;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-4);
}

function safeName(name, fallback) {
  const s = String(name || '').trim().slice(0, 20);
  return s || fallback;
}

class RoomManager {
  constructor(io, store) {
    this.io = io;
    this.store = store;
    this.rooms = new Map();
    this.online = new Set();
    this.botCounter = 0;
  }

  // ---------- 大厅 ----------

  lobbyPayload() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      const phase = this.roomPhase(room);
      const humans = room.seats.filter((s) => s && !s.isBot);
      rooms.push({
        id: room.id,
        name: room.name,
        hostName: room.seats[room.hostSeat] ? room.seats[room.hostSeat].name : '',
        count: room.seats.filter(Boolean).length,
        humans: humans.length,
        status: phase,
        round: room.round || 0
      });
    }
    rooms.sort((a, b) => (a.status === 'waiting' ? -1 : 1) - (b.status === 'waiting' ? -1 : 1));
    return { rooms, online: this.online.size };
  }

  broadcastLobby() {
    this.io.emit('lobby:state', this.lobbyPayload());
  }

  roomPhase(room) {
    if (room.game && (room.game.phase === 'playing' || room.game.phase === 'handover')) return 'playing';
    if (room.game && room.game.phase === 'settled') return 'settled';
    return 'waiting';
  }

  roomPayload(room) {
    return {
      id: room.id,
      name: room.name,
      hostSeat: room.hostSeat,
      hostId: room.seats[room.hostSeat] ? room.seats[room.hostSeat].userId : null,
      phase: this.roomPhase(room),
      round: room.round || 0,
      scores: room.scores,
      seats: room.seats.map((s, i) =>
        s
          ? {
              seat: i,
              userId: s.userId,
              username: s.username,
              name: s.name,
              isBot: s.isBot,
              connected: s.connected,
              isHost: i === room.hostSeat
            }
          : null
      )
    };
  }

  broadcastRoom(room) {
    this.io.to(room.id).emit('room:state', this.roomPayload(room));
  }

  broadcastGame(room) {
    if (!room.game) return;
    room.seats.forEach((seat, index) => {
      if (!seat || !seat.socketId) return;
      const socket = this.io.sockets.sockets.get(seat.socketId);
      if (!socket) return;
      socket.emit('game:state', room.game.stateFor(index));
    });
    this.io.to(room.id).emit('room:state', this.roomPayload(room));
  }

  // ---------- 房间操作 ----------

  createRoom(socket, user, payload) {
    this.detachFromRoom(socket, true);
    const id = makeRoomId(this.rooms);
    const room = {
      id,
      name: safeName(payload && payload.name, `${user.name} 的房间`),
      hostSeat: 0,
      createdAt: Date.now(),
      seats: [null, null, null, null],
      scores: [0, 0, 0, 0],
      round: 0,
      dealerSeat: null,
      game: null
    };
    room.seats[0] = {
      userId: user.id,
      username: user.username,
      name: user.name,
      isBot: false,
      socketId: socket.id,
      connected: true
    };
    this.rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    this.broadcastRoom(room);
    this.broadcastLobby();
    return { ok: true, roomId: id };
  }

  joinRoom(socket, user, payload) {
    const roomId = String((payload && payload.roomId) || '').trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };

    const existingSeat = room.seats.findIndex((s) => s && !s.isBot && s.userId === user.id);
    if (existingSeat >= 0) {
      return this.attachSeat(socket, user, room, existingSeat);
    }

    const phase = this.roomPhase(room);
    if (phase === 'playing') return { ok: false, error: '该房间游戏已开始，无法中途加入' };

    const freeSeat = room.seats.findIndex((s) => !s);
    if (freeSeat < 0) return { ok: false, error: '房间已满' };

    this.detachFromRoom(socket, true);
    room.seats[freeSeat] = {
      userId: user.id,
      username: user.username,
      name: user.name,
      isBot: false,
      socketId: socket.id,
      connected: true
    };
    if (!room.seats[room.hostSeat]) room.hostSeat = freeSeat;

    socket.join(room.id);
    socket.data.roomId = room.id;
    this.broadcastRoom(room);
    if (room.game) this.broadcastGame(room);
    this.broadcastLobby();
    return { ok: true, roomId: room.id, seat: freeSeat };
  }

  attachSeat(socket, user, room, seatIndex) {
    const seat = room.seats[seatIndex];
    if (seat.socketId && seat.socketId !== socket.id) {
      const oldSocket = this.io.sockets.sockets.get(seat.socketId);
      if (oldSocket) {
        oldSocket.emit('session:replaced', { message: '该账号已在其他窗口进入房间' });
        oldSocket.leave(room.id);
        oldSocket.data.roomId = null;
      }
    }
    seat.socketId = socket.id;
    seat.connected = true;
    seat.name = user.name;
    if (room.game) room.game.setConnected(seatIndex, true);
    socket.join(room.id);
    socket.data.roomId = room.id;
    this.broadcastRoom(room);
    this.broadcastGame(room);
    this.broadcastLobby();
    return { ok: true, roomId: room.id, seat: seatIndex, rejoined: true };
  }

  detachFromRoom(socket, silent = false) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.data.roomId = null;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const seatIndex = room.seats.findIndex((s) => s && s.socketId === socket.id);
    socket.leave(roomId);
    if (seatIndex < 0) return;
    this.removeSeat(room, seatIndex, silent);
  }

  removeSeat(room, seatIndex, silent = false) {
    const seat = room.seats[seatIndex];
    if (!seat) return;
    if (room.game && (room.game.phase === 'playing' || room.game.phase === 'handover')) {
      seat.connected = false;
      seat.socketId = null;
      room.game.setConnected(seatIndex, false);
      this.broadcastRoom(room);
      return;
    }
    room.seats[seatIndex] = null;
    if (room.hostSeat === seatIndex) {
      const next = room.seats.findIndex((s) => s);
      if (next >= 0) room.hostSeat = next;
    }
    const humans = room.seats.filter((s) => s && !s.isBot);
    if (humans.length === 0) {
      if (room.game) room.game.clearTimers();
      this.rooms.delete(room.id);
      this.io.to(room.id).emit('room:closed', { reason: '房间已解散' });
    } else {
      if (!silent) this.broadcastRoom(room);
    }
    this.broadcastLobby();
  }

  leaveRoom(socket) {
    this.detachFromRoom(socket, false);
    return { ok: true };
  }

  addBot(socket, user, payload) {
    const room = this.roomOf(socket);
    if (!room) return { ok: false, error: '你不在房间中' };
    const seatIndex = Number(payload && payload.seat);
    if (room.seats[room.hostSeat] && room.seats[room.hostSeat].userId !== user.id) {
      return { ok: false, error: '只有房主可以添加机器人' };
    }
    if (this.roomPhase(room) === 'playing') return { ok: false, error: '游戏进行中无法添加机器人' };

    let idx = Number.isInteger(seatIndex) && room.seats[seatIndex] === null ? seatIndex : room.seats.findIndex((s) => !s);
    if (idx < 0) return { ok: false, error: '房间已满' };
    this.botCounter += 1;
    room.seats[idx] = {
      userId: `bot:${room.id}:${idx}:${this.botCounter}`,
      username: `BOT-${String(this.botCounter).padStart(2, '0')}`,
      name: `机甲 ${String(idx + 1).padStart(2, '0')}`,
      isBot: true,
      socketId: null,
      connected: true
    };
    this.broadcastRoom(room);
    this.broadcastLobby();
    return { ok: true };
  }

  startNextRound(socket, user) {
    const room = this.roomOf(socket);
    if (!room) return { ok: false, error: '你不在房间中' };
    if (room.seats[room.hostSeat] && room.seats[room.hostSeat].userId !== user.id) {
      return { ok: false, error: '只有房主可以开始游戏' };
    }
    const phase = this.roomPhase(room);
    if (phase === 'playing') return { ok: false, error: '游戏正在进行中' };
    if (room.seats.some((s) => !s)) return { ok: false, error: '需要 4 名玩家（可添加机器人补位）' };

    const players = room.seats.map((s, i) => ({
      seat: i,
      userId: s.userId,
      username: s.username,
      name: s.name,
      isBot: s.isBot,
      connected: s.connected,
      score: room.scores[i] || 0
    }));

    const game = new Game({
      room: { id: room.id, name: room.name },
      players,
      round: room.round,
      dealerSeat: room.dealerSeat,
      onChange: () => this.broadcastGame(room),
      onRoundEnd: (results) => this.handleRoundEnd(room, results)
    });
    room.game = game;
    game.startRound();
    this.broadcastLobby();
    return { ok: true };
  }

  handleRoundEnd(room, results) {
    room.round = results.round;
    room.dealerSeat = results.nextDealer;
    for (const row of results.rows) {
      room.scores[row.seat] = row.totalScore;
      if (row.userId && !row.isBot) {
        this.store.recordGame(row.userId, {
          finishRank: row.finishRank,
          scoreDelta: row.scoreDelta
        });
      }
    }
    try {
      this.store.recordGameResult(room.id, results.round, results.rows);
    } catch (e) {
      console.error('[recordGameResult]', e);
    }
    this.broadcastLobby();
  }

  // ---------- 游戏操作 ----------

  roomOf(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  seatOf(room, socket) {
    if (!room) return -1;
    return room.seats.findIndex((s) => s && s.socketId === socket.id);
  }

  withGame(socket, fn) {
    const room = this.roomOf(socket);
    if (!room) return { ok: false, error: '你不在任何房间中' };
    if (!room.game) return { ok: false, error: '游戏尚未开始' };
    const seat = this.seatOf(room, socket);
    if (seat < 0) return { ok: false, error: '你不在座位上' };
    try {
      return fn(room.game, seat, room);
    } catch (e) {
      if (e instanceof GameError) return { ok: false, error: e.message };
      console.error('[game action]', e);
      return { ok: false, error: '操作失败，请重试' };
    }
  }

  play(socket, payload) {
    return this.withGame(socket, (game, seat) => game.play(seat, payload && payload.ids));
  }

  pass(socket) {
    return this.withGame(socket, (game, seat) => game.pass(seat));
  }

  bump(socket) {
    return this.withGame(socket, (game, seat) => game.bump(seat));
  }

  handover(socket, payload) {
    return this.withGame(socket, (game, seat) => game.submitHandover(seat, payload && payload.ids));
  }

  // ---------- 连接 ----------

  register(socket) {
    this.online.add(socket.id);
    this.broadcastLobby();
  }

  unregister(socket) {
    this.online.delete(socket.id);
    this.detachFromRoom(socket, false);
    this.broadcastLobby();
  }
}

module.exports = { RoomManager };
