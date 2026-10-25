const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { Store } = require('./src/store');
const { signToken, verifyToken, authMiddleware, adminMiddleware } = require('./src/auth');
const { RoomManager } = require('./src/rooms');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const store = new Store();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  pingTimeout: 20000
});
const manager = new RoomManager(io, store);

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- 基础工具 ----------

function isValidUsername(username) {
  return /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/.test(String(username || '').trim());
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 64;
}

function publicUserOf(user) {
  return store.publicUser(user);
}

function validateNewUser(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const name = String(body.name || username).trim();
  if (!isValidUsername(username)) return '用户名需为 2-16 位字母/数字/下划线/中文';
  if (!isValidPassword(password)) return '密码长度需为 6-64 位';
  if (!name || name.length > 16) return '昵称需为 1-16 个字符';
  if (store.findByUsername(username)) return '用户名已存在';
  return null;
}

// ---------- 认证 ----------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.findByUsername(username);
  if (!user || !store.verifyPassword(user, password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (!user.active) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
  store.touchLogin(user);
  const token = signToken({ sub: user.id, role: user.role }, store.secret);
  res.json({ token, user: publicUserOf(user) });
});

app.get('/api/me', authMiddleware(store), (req, res) => {
  res.json({ user: publicUserOf(req.user) });
});

app.post('/api/me/password', authMiddleware(store), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!store.verifyPassword(req.user, oldPassword)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  if (!isValidPassword(newPassword)) return res.status(400).json({ error: '新密码长度需为 6-64 位' });
  store.setPassword(req.user, newPassword);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: manager.rooms.size, online: manager.online.size });
});

// ---------- 公共设置（记牌器开关等） ----------

app.get('/api/settings', (req, res) => {
  res.json({ cardCounter: !!store.getSetting('cardCounter') });
});

// ---------- 个人战绩 ----------

app.get('/api/me/history', authMiddleware(store), (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.json({ games: store.listGamesForUser(req.user.id, limit) });
});

// ---------- 管理员：用户管理 ----------

app.get('/api/admin/users', authMiddleware(store), adminMiddleware, (req, res) => {
  res.json({ users: store.listUsers(), summary: { ...store.adminSummary(), online: manager.online.size } });
});

app.post('/api/admin/users', authMiddleware(store), adminMiddleware, (req, res) => {
  const error = validateNewUser(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const user = store.createUser({
      username: String(req.body.username).trim(),
      name: String(req.body.name || req.body.username).trim(),
      password: String(req.body.password),
      role: req.body.role === 'admin' ? 'admin' : 'player'
    });
    res.status(201).json({ user: publicUserOf(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:id', authMiddleware(store), adminMiddleware, (req, res) => {
  const target = store.findById(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const body = req.body || {};

  if (target.id === req.user.id) {
    if (body.active === false) return res.status(400).json({ error: '不能禁用当前登录的管理员' });
    if (body.role && body.role !== 'admin') return res.status(400).json({ error: '不能取消自己的管理员权限' });
  }
  if (body.role && body.role !== 'admin' && target.role === 'admin') {
    const adminCount = store.listUsers().filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) return res.status(400).json({ error: '至少需要保留一名管理员' });
  }
  if (body.password !== undefined && !isValidPassword(body.password)) {
    return res.status(400).json({ error: '新密码长度需为 6-64 位' });
  }

  try {
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.role !== undefined) patch.role = body.role;
    if (body.active !== undefined) patch.active = body.active;
    if (body.password) patch.password = body.password;
    const updated = store.updateUser(target.id, patch);
    res.json({ user: publicUserOf(updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', authMiddleware(store), adminMiddleware, (req, res) => {
  const target = store.findById(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (target.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  if (target.role === 'admin') {
    const adminCount = store.listUsers().filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) return res.status(400).json({ error: '至少需要保留一名管理员' });
  }
  store.deleteUser(target.id);
  res.json({ ok: true });
});

app.get('/api/admin/rooms', authMiddleware(store), adminMiddleware, (req, res) => {
  res.json(manager.lobbyPayload());
});

app.get('/api/admin/games', authMiddleware(store), adminMiddleware, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ games: store.listGames(limit) });
});

app.get('/api/admin/settings', authMiddleware(store), adminMiddleware, (req, res) => {
  res.json({ cardCounter: !!store.getSetting('cardCounter') });
});

app.patch('/api/admin/settings', authMiddleware(store), adminMiddleware, (req, res) => {
  const body = req.body || {};
  if (body.cardCounter !== undefined) {
    store.setSetting('cardCounter', !!body.cardCounter);
  }
  res.json({ cardCounter: !!store.getSetting('cardCounter') });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- Socket 鉴权 ----------

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const payload = verifyToken(token, store.secret);
  if (!payload) return next(new Error('unauthorized'));
  const user = store.findById(payload.sub);
  if (!user || !user.active) return next(new Error('forbidden'));
  socket.data.userId = user.id;
  next();
});

function currentUser(socket) {
  const user = store.findById(socket.data.userId);
  if (!user || !user.active) return null;
  return user;
}

function reply(cb, data) {
  if (typeof cb === 'function') cb(data);
}

io.on('connection', (socket) => {
  const user = currentUser(socket);
  if (!user) {
    socket.disconnect(true);
    return;
  }

  manager.register(socket);
  socket.emit('session:ready', { user: publicUserOf(user) });
  socket.emit('lobby:state', manager.lobbyPayload());

  socket.on('lobby:refresh', () => {
    socket.emit('lobby:state', manager.lobbyPayload());
  });

  socket.on('room:create', (payload, cb) => {
    const u = currentUser(socket);
    if (!u) return reply(cb, { ok: false, error: '账号不可用' });
    reply(cb, manager.createRoom(socket, u, payload || {}));
  });

  socket.on('room:join', (payload, cb) => {
    const u = currentUser(socket);
    if (!u) return reply(cb, { ok: false, error: '账号不可用' });
    reply(cb, manager.joinRoom(socket, u, payload || {}));
  });

  socket.on('room:leave', (cb) => {
    reply(cb, manager.leaveRoom(socket));
  });

  socket.on('room:addBot', (payload, cb) => {
    const u = currentUser(socket);
    if (!u) return reply(cb, { ok: false, error: '账号不可用' });
    reply(cb, manager.addBot(socket, u, payload || {}));
  });

  socket.on('room:start', (cb) => {
    const u = currentUser(socket);
    if (!u) return reply(cb, { ok: false, error: '账号不可用' });
    reply(cb, manager.startNextRound(socket, u));
  });

  socket.on('game:play', (payload, cb) => {
    reply(cb, manager.play(socket, payload || {}));
  });

  socket.on('game:pass', (cb) => {
    reply(cb, manager.pass(socket));
  });

  socket.on('game:bump', (cb) => {
    reply(cb, manager.bump(socket));
  });

  socket.on('game:handover', (payload, cb) => {
    reply(cb, manager.handover(socket, payload || {}));
  });

  socket.on('disconnect', () => {
    manager.unregister(socket);
  });
});

// 定期刷新大厅人数
const lobbyTimer = setInterval(() => manager.broadcastLobby(), 15000);
lobbyTimer.unref();

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  十三支 · THIRTEEN  |  联机扑克对战');
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log(`  默认管理员: ${process.env.ADMIN_USERNAME || 'admin'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
  console.log('==============================================');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
