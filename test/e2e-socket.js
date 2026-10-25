/**
 * 端到端联机测试：
 *  - 管理员创建 3 个测试账号 + 管理员自己，共 4 人
 *  - 创建房间、4 人入座、开始游戏
 *  - 4 个 socket 自动按合法出牌打到本局结束
 *  - 校验强制出牌、黑桃3首出、名次、计分与上缴
 *
 * 运行： node test/e2e-socket.js http://localhost:3000
 */
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://localhost:3000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function http(path, options = {}, token = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ensureUser(adminToken, suffix) {
  const username = `e2e_${suffix}`;
  const password = 'test123456';
  const created = await http(
    '/api/admin/users',
    {
      method: 'POST',
      body: JSON.stringify({ username, name: `测试${suffix}`, password, role: 'player' })
    },
    adminToken
  );
  if (created.status !== 201) {
    // 已存在则直接登录
    const login = await http('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    if (login.status !== 200) throw new Error(`创建/登录 ${username} 失败: ${JSON.stringify(login.data)}`);
    return login.data;
  }
  const login = await http('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  return login.data;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

async function main() {
  const adminLogin = await http('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  if (adminLogin.status !== 200) throw new Error('admin 登录失败');
  const adminToken = adminLogin.data.token;

  const accounts = [adminLogin.data];
  for (const s of ['a', 'b', 'c']) accounts.push(await ensureUser(adminToken, s));

  const sockets = [];
  for (const acc of accounts) sockets.push(await connect(acc.token));
  console.log(`[ok] 4 个 socket 已连接`);

  // 创建房间
  const room = await new Promise((resolve) => sockets[0].emit('room:create', { name: 'E2E 测试局' }, resolve));
  if (!room.ok) throw new Error('创建房间失败');
  console.log(`[ok] 房间 ${room.roomId}`);

  for (let i = 1; i < 4; i++) {
    const res = await new Promise((resolve) => sockets[i].emit('room:join', { roomId: room.roomId }, resolve));
    if (!res.ok) throw new Error(`玩家 ${i} 加入失败: ${res.error}`);
  }
  console.log('[ok] 4 人入座');

  const states = [null, null, null, null];
  const socketBySeat = [null, null, null, null];
  let settledCount = 0;
  let firstPlayChecked = false;
  let openerSeat = null;
  let firstTurn = null;
  let passGuardChecked = false;
  let nonTurnPlayChecked = false;
  let finished = false;
  const acting = [false, false, false, false];
  let settleData = null;

  const done = new Promise((resolve) => {
    sockets.forEach((socket, seat) => {
      socket.on('game:state', async (g) => {
        states[g.you.seat] = g;
        socketBySeat[g.you.seat] = socket;
        if (finished) return;

        if (g.phase === 'playing' && firstTurn === null && g.base === null && g.opening) {
          const openerState = states[g.turnSeat];
          if (!openerState) return; // 等先手玩家的状态
          openerSeat = g.turnSeat;
          firstTurn = g.you.seat;
          const hand = openerState.you.hand;
          if (!hand.some((c) => c.id === 'S3')) throw new Error('先手玩家没有黑桃3');
          console.log(`[ok] 黑桃3先手：seat ${openerSeat}，手牌 ${hand.length} 张`);

          // 强制出牌校验：先手尝试 Pass
          if (!passGuardChecked) {
            passGuardChecked = true;
            const passRes = await new Promise((resolve) =>
              socketBySeat[openerSeat].emit('game:pass', (r) => resolve(r))
            );
            if (passRes.ok) throw new Error('首出 Pass 竟然被允许');
            console.log(`[ok] 首出 Pass 被拒绝：${passRes.error}`);

            // 非当前玩家出牌校验
            const other = (openerSeat + 1) % 4;
            const otherState = states[other];
            if (otherState && otherState.you.hand.length) {
              nonTurnPlayChecked = true;
              const bad = await new Promise((resolve) =>
                socketBySeat[other].emit('game:play', { ids: [otherState.you.hand[0].id] }, (r) => resolve(r))
              );
              if (bad.ok) throw new Error('非当前玩家出牌竟然被允许');
              console.log(`[ok] 非当前玩家出牌被拒绝：${bad.error}`);
            }
          }
        }

        if (g.phase === 'settled' && !settledCount) {
          settledCount++;
          settleData = g;
          finished = true;
          resolve();
          return;
        }
        if (g.phase === 'settled') return;

        if (g.phase === 'handover' && g.handover && g.you.seat === g.handover.seat) {
          if (acting[g.you.seat]) return;
          acting[g.you.seat] = true;
          const ids = g.you.hand.slice(0, g.handover.need).map((c) => c.id);
          const res = await new Promise((resolve) => socket.emit('game:handover', { ids }, resolve));
          acting[g.you.seat] = false;
          if (!res.ok) {
            console.error('[handover error]', res.error);
            // 自动兜底由服务端计时器完成
          }
          return;
        }

        if (g.phase !== 'playing' || !g.you.isTurn || g.you.finishRank) return;
        if (acting[g.you.seat]) return;
        acting[g.you.seat] = true;

        if (g.base && g.pile.length && !firstPlayChecked && g.pile.length === 1) {
          const first = g.pile[0];
          if (!first.cards.some((c) => c.id === 'S3')) throw new Error('首出没有包含黑桃3');
          firstPlayChecked = true;
          console.log('[ok] 首出包含黑桃3');
        }

        // 有「撞」窗口时偶尔演示撞
        if (g.you.canBump && g.bump && Math.random() < 0.5) {
          const res = await new Promise((resolve) => socket.emit('game:bump', resolve));
          acting[g.you.seat] = false;
          if (res.ok) {
            console.log(`[撞] seat ${g.you.seat} 用对${g.bump.label}撞`);
            return;
          }
        }

        if (g.you.legalPlays.length > 0) {
          const ids = g.you.legalPlays[0].ids;
          const res = await new Promise((resolve) => socket.emit('game:play', { ids }, resolve));
          acting[g.you.seat] = false;
          if (!res.ok) {
            console.error(`[play error] seat ${g.you.seat}:`, res.error, ids);
            // 兜底：重新取可选牌
            const retry = await new Promise((resolve) =>
              socket.emit('game:play', { ids: g.you.legalPlays[1] ? g.you.legalPlays[1].ids : ids }, resolve)
            );
            if (!retry.ok) console.error('[retry error]', retry.error);
          }
        } else if (g.you.canPass) {
          const res = await new Promise((resolve) => socket.emit('game:pass', resolve));
          acting[g.you.seat] = false;
          if (!res.ok) console.error(`[pass error] seat ${g.you.seat}:`, res.error);
        } else {
          acting[g.you.seat] = false;
        }
      });
    });
  });

  const res = await new Promise((resolve) => sockets[0].emit('room:start', resolve));
  if (!res.ok) throw new Error('开始游戏失败: ' + res.error);
  console.log('[ok] 游戏开始');

  await Promise.race([done, sleep(600000).then(() => Promise.reject(new Error('测试超时')))]);
  await sleep(300);
  console.log('[ok] 本局结束');

  const rows = settleData.results.rows;
  console.log('\n===== 结算 =====');
  for (const row of rows) {
    console.log(
      `第${row.finishRank}名 ${row.name.padEnd(8)} 收牌 ${String(row.collected).padStart(2)}  本局 ${
        row.scoreDelta > 0 ? '+' : ''
      }${row.scoreDelta}  累计 ${row.totalScore}`
    );
  }
  console.log('上缴：', settleData.results.handover);

  // 断言
  if (rows.length !== 4) throw new Error('结算行数不是 4');
  const ranks = rows.map((r) => r.finishRank).sort((a, b) => a - b);
  if (JSON.stringify(ranks) !== JSON.stringify([1, 2, 3, 4])) throw new Error('名次不是 1-4');
  for (const row of rows) {
    if (row.scoreDelta !== row.collected - 13) throw new Error(`计分公式错误: ${row.name}`);
  }
  const totalCollected = rows.reduce((n, r) => n + r.collected, 0);
  if (totalCollected > 52) throw new Error('收牌数超过 52');
  if (settleData.results.handover.cards.length === 0) throw new Error('缺少上缴牌');
  if (!firstPlayChecked) throw new Error('没有验证到首出');
  if (!passGuardChecked) throw new Error('没有验证到强制出牌');
  console.log(`\n[PASS] 收牌总计 ${totalCollected} 张 · 名次/计分/上缴/强制出牌 校验通过`);
  if (!nonTurnPlayChecked) console.log('[warn] 非当前玩家校验未触发（状态到达顺序原因）');

  sockets.forEach((s) => s.disconnect());
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[FAIL]', e);
  process.exit(1);
});
