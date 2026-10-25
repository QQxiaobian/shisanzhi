const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

class Store {
  constructor() {
    ensureDir();
    this.data = this.load();
    this.bootstrapAdmin();
  }

  load() {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.users) parsed.users = [];
      if (!parsed.secret) parsed.secret = crypto.randomBytes(32).toString('hex');
      if (!parsed.stats) parsed.stats = {};
      if (!Array.isArray(parsed.games)) parsed.games = [];
      if (!parsed.settings) parsed.settings = { cardCounter: false };
      return parsed;
    } catch (e) {
      const data = {
        secret: process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex'),
        users: [],
        games: [],
        settings: { cardCounter: false },
        createdAt: nowIso()
      };
      this.persist(data);
      return data;
    }
  }

  persist(data = this.data) {
    ensureDir();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  }

  save() {
    this.persist();
  }

  get secret() {
    return process.env.TOKEN_SECRET || this.data.secret;
  }

  bootstrapAdmin() {
    const username = (process.env.ADMIN_USERNAME || 'admin').trim();
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const exists = this.data.users.some(
      (u) => u.role === 'admin' || u.username.toLowerCase() === username.toLowerCase()
    );
    if (!exists) {
      this.createUser({ username, name: '管理员', password, role: 'admin' });
      console.log(`[init] 已创建管理员账号：${username}`);
    }
  }

  static normalizeUsername(username) {
    return String(username || '').trim();
  }

  findByUsername(username) {
    const target = Store.normalizeUsername(username).toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === target) || null;
  }

  findById(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }

  createUser({ username, name, password, role = 'player' }) {
    const uname = Store.normalizeUsername(username);
    if (!uname) throw new Error('用户名不能为空');
    if (this.findByUsername(uname)) throw new Error('用户名已存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      username: uname,
      name: (name || uname).trim().slice(0, 16) || uname,
      salt,
      hash,
      role: role === 'admin' ? 'admin' : 'player',
      active: true,
      createdAt: nowIso(),
      lastLoginAt: null,
      stats: { games: 0, wins: 0, score: 0 }
    };
    this.data.users.push(user);
    this.save();
    return user;
  }

  verifyPassword(user, password) {
    if (!user) return false;
    const hash = crypto.scryptSync(String(password), user.salt, 64).toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    } catch (e) {
      return false;
    }
  }

  setPassword(user, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    this.save();
  }

  touchLogin(user) {
    user.lastLoginAt = nowIso();
    this.save();
  }

  updateUser(id, patch) {
    const user = this.findById(id);
    if (!user) throw new Error('用户不存在');
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 16);
      if (!name) throw new Error('昵称不能为空');
      user.name = name;
    }
    if (patch.role !== undefined) {
      user.role = patch.role === 'admin' ? 'admin' : 'player';
    }
    if (patch.active !== undefined) {
      user.active = !!patch.active;
    }
    if (patch.password) {
      this.setPassword(user, patch.password);
    }
    this.save();
    return user;
  }

  deleteUser(id) {
    const idx = this.data.users.findIndex((u) => u.id === id);
    if (idx < 0) throw new Error('用户不存在');
    this.data.users.splice(idx, 1);
    this.save();
  }

  recordGame(userId, { finishRank, scoreDelta }) {
    const user = this.findById(userId);
    if (!user) return;
    if (!user.stats) user.stats = { games: 0, wins: 0, score: 0 };
    user.stats.games += 1;
    if (finishRank === 1) user.stats.wins += 1;
    user.stats.score += Number(scoreDelta) || 0;
    this.save();
  }

  /**
   * 记录一局完整战绩（用于历史查询）
   * @param {string} roomId
   * @param {number} round
   * @param {Array} rows 结算行 {seat,name,finishRank,scoreDelta,totalScore,isBot,userId}
   */
  recordGameResult(roomId, round, rows) {
    const entry = {
      id: crypto.randomUUID(),
      roomId,
      round,
      finishedAt: nowIso(),
      players: rows.map((r) => ({
        userId: r.userId || null,
        username: r.username || null,
        name: r.name,
        finishRank: r.finishRank,
        scoreDelta: r.scoreDelta,
        totalScore: r.totalScore,
        isBot: !!r.isBot
      }))
    };
    this.data.games.unshift(entry);
    if (this.data.games.length > 200) this.data.games = this.data.games.slice(0, 200);
    this.save();
    return entry;
  }

  listGamesForUser(userId, limit = 30) {
    const result = [];
    for (const g of this.data.games) {
      const me = g.players.find((p) => p.userId === userId);
      if (!me) continue;
      result.push({
        id: g.id,
        finishedAt: g.finishedAt,
        round: g.round,
        finishRank: me.finishRank,
        scoreDelta: me.scoreDelta,
        totalScore: me.totalScore,
        opponents: g.players.filter((p) => p.userId !== userId).map((p) => p.name)
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  listGames(limit = 50) {
    return this.data.games.slice(0, limit).map((g) => ({
      id: g.id,
      roomId: g.roomId,
      round: g.round,
      finishedAt: g.finishedAt,
      players: g.players
    }));
  }

  getSetting(key) {
    if (!this.data.settings) this.data.settings = {};
    return this.data.settings[key];
  }

  setSetting(key, value) {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings[key] = value;
    this.save();
    return value;
  }

  adminSummary() {
    const users = this.listUsers();
    const totalGames = users.reduce((n, u) => n + (u.stats?.games || 0), 0);
    return {
      users: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      online: null,
      totalGames
    };
  }

  listUsers() {
    return this.data.users
      .map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        active: u.active,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        stats: u.stats || { games: 0, wins: 0, score: 0 }
      }))
      .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1));
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      stats: user.stats || { games: 0, wins: 0, score: 0 }
    };
  }
}

module.exports = { Store, DB_FILE, DATA_DIR };
