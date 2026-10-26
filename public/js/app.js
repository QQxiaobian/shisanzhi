/* global io */
(() => {
  'use strict';

  // =========================================================
  // 常量 / 状态
  // =========================================================

  const TURN_MS = 30000;
  const BUMP_MS = 5000;
  const HANDOVER_MS = 45000;
  const DEALING_MS = 1400;
  const TOKEN_KEY = 't13_token';
  const ROOM_KEY = 't13_room';

  const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 };
  const TYPE_LABEL = { single: '单张', pair: '对子', bump: '撞', bomb: '炸弹', thousand: '千弹' };

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    socket: null,
    lobby: { rooms: [], online: 0 },
    room: null,
    game: null,
    screen: 'login',
    selected: new Set(),
    handoverSelected: new Set(),
    handSig: '',
    settleKey: '',
    toastTimer: null,
    offset: 0,
    lastLogCount: 0,
    overlayKey: '',
    pollTimer: null,
    rejoinTried: false,
    cardCounter: false,
    counterVisible: false,
    authMode: 'login',
    allowRegister: false
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    loginForm: $('#login-form'),
    loginUsername: $('#login-username'),
    loginPassword: $('#login-password'),
    loginError: $('#login-error'),
    loginBtn: $('#login-btn'),
    authTabs: $('#auth-tabs'),
    authLoginFields: $('#auth-login-fields'),
    authRegisterFields: $('#auth-register-fields'),
    tabRegister: $('#tab-register'),
    panelTitleText: $('#panel-title-text'),
    loginHint: $('#login-hint'),
    regUsername: $('#reg-username'),
    regName: $('#reg-name'),
    regPassword: $('#reg-password'),
    regPassword2: $('#reg-password2'),
    registerBtn: $('#register-btn'),
    onlineCount: $('#online-count'),
    onlineList: $('#online-list'),
    onlinePanelCount: $('#online-panel-count'),
    myName: $('#my-name'),
    myRole: $('#my-role'),
    adminLink: $('#admin-link'),
    statGames: $('#stat-games'),
    statWins: $('#stat-wins'),
    statScore: $('#stat-score'),
    profileId: $('#profile-id'),
    roomList: $('#room-list'),
    roomCount: $('#room-count'),
    roomCode: $('#room-code'),
    roomTitle: $('#room-title'),
    roomSub: $('#room-sub'),
    roomStatus: $('#room-status'),
    roomSeats: $('#room-seats'),
    roomHint: $('#room-hint'),
    roomMyName: $('#room-my-name'),
    btnStart: $('#btn-start'),
    btnAddBot: $('#btn-add-bot'),
    roomScoreboard: $('#room-scoreboard'),
    roomScoreList: $('#room-score-list'),
    hudRound: $('#hud-round'),
    hudDealer: $('#hud-dealer'),
    hudTurn: $('#hud-turn'),
    turnBarFill: $('#turn-bar-fill'),
    hudCollected: $('#hud-collected'),
    hudTotal: $('#hud-total'),
    seatTop: $('#seat-top'),
    seatLeft: $('#seat-left'),
    seatRight: $('#seat-right'),
    seatBottom: $('#seat-bottom'),
    baseStrip: $('#base-strip'),
    pile: $('#pile'),
    bumpAlert: $('#bump-alert'),
    bumpDesc: $('#bump-desc'),
    bumpBarFill: $('#bump-bar-fill'),
    logList: $('#log-list'),
    hand: $('#hand'),
    handEmpty: $('#hand-empty'),
    handSeat: $('#hand-seat'),
    handStatus: $('#hand-status'),
    handSelected: $('#hand-selected'),
    handHint: $('#hand-hint'),
    btnPlay: $('#btn-play'),
    btnPass: $('#btn-pass'),
    btnBump: $('#btn-bump'),
    settleTitle: $('#settle-title'),
    settleTable: $('#settle-table'),
    handoverNote: $('#handover-note'),
    btnNextRound: $('#btn-next-round'),
    settleWait: $('#settle-wait'),
    overlaySettle: $('#overlay-settle'),
    overlayHandover: $('#overlay-handover'),
    overlayRules: $('#overlay-rules'),
    overlayPassword: $('#overlay-password'),
    handoverTitle: $('#handover-title'),
    handoverDesc: $('#handover-desc'),
    handoverHand: $('#handover-hand'),
    handoverCount: $('#handover-count'),
    handoverBarFill: $('#handover-bar-fill'),
    btnHandoverConfirm: $('#btn-handover-confirm'),
    handoverWait: $('#handover-wait'),
    toast: $('#toast'),
    connBanner: $('#conn-banner'),
    pwError: $('#pw-error'),
    btnHistory: $('#btn-history'),
    overlayHistory: $('#overlay-history'),
    historyTable: $('#history-table'),
    btnCloseHistory: $('#btn-close-history'),
    btnCounter: $('#btn-counter'),
    counterPanel: $('#counter-panel'),
    counterGrid: $('#counter-grid'),
    counterCount: $('#counter-count')
  };

  // =========================================================
  // 工具
  // =========================================================

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showScreen(name) {
    state.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  }

  function toast(message, duration = 2600) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, duration);
  }

  function openOverlay(node) {
    node.hidden = false;
  }
  function closeOverlay(node) {
    node.hidden = true;
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(path, { ...options, headers });
    } catch (e) {
      return { ok: false, error: '网络连接失败' };
    }
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (res.status === 401) {
      if (state.token) logout(true);
      return { ok: false, error: data.error || '登录已过期' };
    }
    if (!res.ok) return { ok: false, error: data.error || '请求失败' };
    return { ok: true, data };
  }

  function socketCall(event, payload) {
    return new Promise((resolve) => {
      if (!state.socket || !state.socket.connected) {
        resolve({ ok: false, error: '尚未连接服务器' });
        return;
      }
      const done = (res) => resolve(res && typeof res === 'object' ? res : { ok: true });
      if (payload === undefined) state.socket.emit(event, done);
      else state.socket.emit(event, payload, done);
    });
  }

  function now() {
    return Date.now() + state.offset;
  }

  function timeText(at) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function syncOffset(serverNow) {
    if (typeof serverNow === 'number') state.offset = serverNow - Date.now();
  }

  function avatarSvg(seat, color) {
    const palettes = [
      ['#2b3d5e', '#4f7bb8', '#ffd23f'],
      ['#4a2340', '#a0457f', '#ff8ab5'],
      ['#173c35', '#2f8b74', '#3ddc97'],
      ['#3c3417', '#8a7429', '#ffe07a']
    ];
    const p = palettes[(seat + (color || 0)) % 4];
    const eyes = [
      '<rect x="4" y="5" width="2" height="2" fill="' + p[2] + '"/><rect x="10" y="5" width="2" height="2" fill="' + p[2] + '"/>',
      '<rect x="4" y="5" width="8" height="2" fill="' + p[2] + '"/>',
      '<rect x="5" y="5" width="2" height="2" fill="' + p[2] + '"/><rect x="9" y="5" width="2" height="2" fill="' + p[2] + '"/>',
      '<rect x="4" y="5" width="3" height="2" fill="' + p[2] + '"/><rect x="9" y="5" width="3" height="2" fill="' + p[2] + '"/>'
    ][seat % 4];
    return `<svg class="avatar" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
      <rect width="16" height="16" fill="#050b14"/>
      <rect x="3" y="2" width="10" height="9" fill="${p[0]}"/>
      <rect x="4" y="3" width="8" height="7" fill="${p[1]}"/>
      ${eyes}
      <rect x="7" y="8" width="2" height="1" fill="#060b14"/>
      <rect x="6" y="12" width="4" height="3" fill="${p[0]}"/>
      <rect x="5" y="13" width="6" height="2" fill="${p[1]}"/>
      <rect x="2" y="12" width="2" height="2" fill="${p[0]}"/>
      <rect x="12" y="12" width="2" height="2" fill="${p[0]}"/>
    </svg>`;
  }

  // =========================================================
  // 客户端规则校验（用于按钮状态 / 提示；服务端为最终裁判）
  // =========================================================

  function analyze(cards) {
    if (!cards || cards.length < 1 || cards.length > 4) return null;
    const rank = cards[0].rank;
    if (!cards.every((c) => c.rank === rank)) return null;
    const type = { 1: 'single', 2: 'pair', 3: 'bomb', 4: 'thousand' }[cards.length];
    return { type, rank, label: cards[0].label };
  }

  function canBeat(base, combo) {
    if (!base) return true;
    const b = base.type;
    const t = combo.type;
    if (t === 'thousand') {
      if (b === 'thousand') return combo.rank > base.rank;
      return true;
    }
    if (t === 'bomb') {
      if (b === 'thousand') return false;
      if (b === 'bomb') return combo.rank > base.rank;
      return true;
    }
    if (t === 'pair') return b === 'pair' && combo.rank > base.rank;
    if (t === 'single') return b === 'single' && combo.rank > base.rank;
    return false;
  }

  function bumpWindowOpen(game) {
    return !!(game && game.bump && game.base && game.base.type === 'single' && now() < game.bump.deadline);
  }

  function evaluateSelection(game, cards) {
    if (!cards.length) return { ok: false, kind: 'empty', text: '请选择要出的牌' };
    const combo = analyze(cards);
    if (!combo) return { ok: false, kind: 'bad', text: '只能出同点数的 1-4 张牌' };

    const remaining = game.you.hand.filter((c) => !cards.some((s) => s.id === c.id));
    if (remaining.length > 0 && remaining.every((c) => c.rank === 15)) {
      return { ok: false, kind: 'bad', text: '禁止保留全部为 2 的手牌收尾' };
    }

    const base = game.base;
    if (!base) {
      return { ok: true, text: `可出：${TYPE_LABEL[combo.type]} ${combo.label}` };
    }

    if (base.type === 'single' && combo.type === 'pair' && combo.rank === base.rank) {
      if (!bumpWindowOpen(game)) return { ok: false, kind: 'bad', text: '撞倒计时已结束' };
      return { ok: true, text: `撞！对${combo.label}` };
    }

    if (!canBeat(base, combo)) {
      return { ok: false, kind: 'bad', text: `无法压制当前${TYPE_LABEL[base.type]} ${base.label}` };
    }
    return { ok: true, text: `可出：${TYPE_LABEL[combo.type]} ${combo.label}` };
  }

  // =========================================================
  // 登录 / 会话
  // =========================================================

  async function boot() {
    bindUi();
    if (state.token) {
      const me = await api('/api/me');
      if (me.ok) {
        state.user = me.data.user;
        applyUser();
        loadSettings();
        showScreen('lobby');
        renderLobby();
        connectSocket();
        return;
      }
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
    }
    showLogin();
    loadSettings();
  }

  function showLogin() {
    showScreen('login');
    el.loginPassword.value = '';
    el.loginError.textContent = '';
    setTimeout(() => el.loginUsername.focus(), 60);
  }

  function applyUser() {
    if (!state.user) return;
    el.myName.textContent = state.user.name;
    el.myRole.textContent = state.user.role === 'admin' ? 'ADMIN' : 'PLAYER';
    el.adminLink.hidden = state.user.role !== 'admin';
    el.statGames.textContent = state.user.stats?.games ?? 0;
    el.statWins.textContent = state.user.stats?.wins ?? 0;
    el.statScore.textContent = state.user.stats?.score ?? 0;
    el.profileId.textContent = `@${state.user.username} · ID ${String(state.user.id).slice(0, 8)}`;
    if (state.room) el.roomMyName.textContent = state.user.name;
  }

  function connectSocket() {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    const socket = io({ auth: { token: state.token }, reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 4000 });
    state.socket = socket;

    socket.on('connect', () => {
      el.connBanner.hidden = true;
      const storedRoom = localStorage.getItem(ROOM_KEY);
      if (storedRoom) {
        socket.emit('room:join', { roomId: storedRoom }, (res) => {
          if (!res || !res.ok) {
            localStorage.removeItem(ROOM_KEY);
            state.room = null;
            state.game = null;
            showScreen('lobby');
            renderLobby();
          }
        });
      }
    });

    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return;
      el.connBanner.hidden = false;
    });

    socket.on('connect_error', (err) => {
      const msg = String(err && err.message ? err.message : '');
      if (msg.includes('unauthorized') || msg.includes('forbidden')) {
        logout(true);
        toast('登录状态失效，请重新登录');
        return;
      }
      el.connBanner.hidden = false;
    });

    socket.on('session:ready', (payload) => {
      if (payload && payload.user) {
        state.user = payload.user;
        applyUser();
      }
    });

    socket.on('session:replaced', (payload) => {
      toast((payload && payload.message) || '账号在其他窗口登录');
      state.room = null;
      state.game = null;
      localStorage.removeItem(ROOM_KEY);
      showScreen('lobby');
      renderLobby();
    });

    socket.on('lobby:state', (payload) => {
      state.lobby = payload || { rooms: [], online: 0, onlineUsers: [] };
      el.onlineCount.textContent = state.lobby.online ?? 0;
      renderOnline();
      if (state.screen === 'lobby') renderLobby();
    });

    socket.on('room:state', (payload) => {
      state.room = payload || null;
      if (!state.room) return;
      localStorage.setItem(ROOM_KEY, state.room.id);
      if (state.room.phase === 'waiting') {
        if (state.screen !== 'room') showRoomScreen();
      } else if (state.screen !== 'game') {
        showRoomScreen();
      }
      renderRoom();
      if (state.screen === 'game' && state.game && state.game.phase === 'settled' && state.room.phase === 'settled') {
        renderSettle(state.game);
      }
    });

    socket.on('game:state', (payload) => {
      const prev = state.game;
      syncOffset(payload.serverNow);
      state.game = payload;
      if (state.room) localStorage.setItem(ROOM_KEY, state.room.id);
      if (state.screen !== 'game') showGameScreen();
      if (payload.phase === 'playing') {
        closeOverlay(el.overlaySettle);
        closeOverlay(el.overlayHandover);
      }
      if (payload.phase === 'handover' && (!prev || prev.phase !== 'handover' || prev.round !== payload.round)) {
        state.handoverSelected.clear();
      }
      if (payload.phase === 'settled' && (!prev || prev.phase !== 'settled' || prev.round !== payload.round)) {
        state.selected.clear();
        refreshMe();
      }
      playGameSounds(prev, payload);
      renderGame();
    });

    socket.on('room:closed', (payload) => {
      toast((payload && payload.reason) || '房间已关闭');
      state.room = null;
      state.game = null;
      localStorage.removeItem(ROOM_KEY);
      closeOverlay(el.overlaySettle);
      closeOverlay(el.overlayHandover);
      showScreen('lobby');
      renderLobby();
    });

    socket.on('room:kicked', (payload) => {
      toast((payload && payload.reason) || '你已被移出房间');
      state.room = null;
      state.game = null;
      localStorage.removeItem(ROOM_KEY);
      closeOverlay(el.overlaySettle);
      closeOverlay(el.overlayHandover);
      showScreen('lobby');
      renderLobby();
    });
  }

  async function refreshMe() {
    const me = await api('/api/me');
    if (me.ok) {
      state.user = me.data.user;
      applyUser();
    }
  }

  async function loadSettings() {
    const res = await api('/api/settings');
    if (res.ok) {
      state.cardCounter = !!res.data.cardCounter;
      state.allowRegister = !!res.data.allowRegister;
      applyRegisterAvailability();
    }
  }

  function applyRegisterAvailability() {
    const open = state.allowRegister;
    if (el.tabRegister) el.tabRegister.hidden = !open;
    if (el.authTabs) el.authTabs.classList.toggle('single', !open);
    if (!open && state.authMode === 'register') setAuthMode('login');
    updateLoginHint();
  }

  function updateLoginHint() {
    if (!el.loginHint) return;
    if (!state.allowRegister) {
      el.loginHint.innerHTML = '账号由管理员创建（注册功能已关闭）。初始管理员：<code>admin / admin123</code>';
      return;
    }
    el.loginHint.innerHTML = state.authMode === 'register'
      ? '注册后自动登录。账号 2-16 位，密码至少 6 位。'
      : '还没有账号？切换到「注册」即可创建。初始管理员：<code>admin / admin123</code>';
  }

  async function openHistory() {
    el.historyTable.innerHTML = '<div class="empty-state">加载中…</div>';
    openOverlay(el.overlayHistory);
    const res = await api('/api/me/history');
    if (!res.ok) {
      el.historyTable.innerHTML = `<div class="empty-state">加载失败：${esc(res.error)}</div>`;
      return;
    }
    const games = res.data.games || [];
    if (!games.length) {
      el.historyTable.innerHTML = '<div class="empty-state">暂无战绩记录</div>';
      return;
    }
    const head = `<div class="history-row head"><span>时间</span><span>局</span><span>名次</span><span>本局</span><span>累计</span><span>对手</span></div>`;
    const rows = games
      .map((g) => {
        const d = new Date(g.finishedAt);
        const time = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const place = ['①', '②', '③', '④'][g.finishRank - 1] || g.finishRank;
        const deltaClass = g.scoreDelta > 0 ? 'plus' : g.scoreDelta < 0 ? 'minus' : '';
        return `<div class="history-row">
          <span class="h-time">${time}</span>
          <span class="h-round">R${g.round}</span>
          <span class="h-place">${place}</span>
          <span class="delta ${deltaClass}">${g.scoreDelta > 0 ? '+' : ''}${g.scoreDelta}</span>
          <span class="h-total">${g.totalScore > 0 ? '+' : ''}${g.totalScore}</span>
          <span class="h-opp">${esc((g.opponents || []).join('、'))}</span>
        </div>`;
      })
      .join('');
    el.historyTable.innerHTML = head + rows;
  }

  function renderCounter(g) {
    if (!state.cardCounter) {
      el.btnCounter.hidden = true;
      el.counterPanel.hidden = true;
      return;
    }
    el.btnCounter.hidden = false;
    el.counterPanel.hidden = !state.counterVisible;
    if (!state.counterVisible) return;

    const counts = g.playedCounts || {};
    const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const labels = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
    let total = 0;
    const cells = ranks
      .map((r) => {
        const played = counts[r] || 0;
        total += played;
        const remain = 4 - played;
        const cls = remain === 0 ? 'gone' : remain === 1 ? 'low' : remain === 4 ? 'full' : '';
        return `<div class="counter-cell ${cls}"><span class="cc-rank">${labels[r]}</span><span class="cc-num">${remain}</span></div>`;
      })
      .join('');
    el.counterGrid.innerHTML = cells;
    el.counterCount.textContent = `${total}/52`;
  }

  function setAuthMode(mode) {
    const register = mode === 'register';
    state.authMode = register ? 'register' : 'login';
    el.authLoginFields.hidden = register;
    el.authRegisterFields.hidden = !register;
    el.panelTitleText.textContent = register ? 'PLAYER SIGN UP' : 'PLAYER LOGIN';
    el.loginError.textContent = '';
    $$('.auth-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.authTab === state.authMode);
    });
    const input = register ? el.regUsername : el.loginUsername;
    updateLoginHint();
    if (input) input.focus();
  }

  function enterGame(token, user, welcome) {
    state.token = token;
    state.user = user;
    localStorage.setItem(TOKEN_KEY, token);
    resetClientState();
    applyUser();
    loadSettings();
    showScreen('lobby');
    renderLobby();
    connectSocket();
    toast(welcome);
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    if (state.authMode === 'register') return doRegister();
    return doLogin();
  }

  async function doRegister() {
    el.loginError.textContent = '';
    const username = el.regUsername.value.trim();
    const name = el.regName.value.trim();
    const password = el.regPassword.value;
    const password2 = el.regPassword2.value;
    if (!username || !password) {
      el.loginError.textContent = '请填写账号和密码';
      return;
    }
    if (password.length < 6) {
      el.loginError.textContent = '密码至少 6 位';
      return;
    }
    if (password !== password2) {
      el.loginError.textContent = '两次输入的密码不一致';
      return;
    }
    el.registerBtn.disabled = true;
    el.registerBtn.textContent = '创建中…';
    const res = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, name: name || username })
    });
    el.registerBtn.disabled = false;
    el.registerBtn.textContent = '创建账号并进入';
    if (!res.ok) {
      el.loginError.textContent = res.error;
      return;
    }
    el.regPassword.value = '';
    el.regPassword2.value = '';
    enterGame(res.data.token, res.data.user, `注册成功，欢迎 ${res.data.user.name}`);
  }

  async function doLogin() {
    el.loginError.textContent = '';
    const username = el.loginUsername.value.trim();
    const password = el.loginPassword.value;
    if (!username || !password) {
      el.loginError.textContent = '请输入账号和密码';
      return;
    }
    el.loginBtn.disabled = true;
    el.loginBtn.textContent = '连接中…';
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = '进入战场';
    if (!res.ok) {
      el.loginError.textContent = res.error;
      return;
    }
    enterGame(res.data.token, res.data.user, `欢迎回来，${res.data.user.name}`);
  }

  function resetClientState() {
    state.room = null;
    state.game = null;
    state.selected.clear();
    state.handoverSelected.clear();
    state.handSig = '';
    state.settleKey = '';
    state.overlayKey = '';
    state.lastLogCount = 0;
    state.counterVisible = false;
    localStorage.removeItem(ROOM_KEY);
    closeOverlay(el.overlaySettle);
    closeOverlay(el.overlayHandover);
    closeOverlay(el.overlayRules);
    closeOverlay(el.overlayPassword);
    closeOverlay(el.overlayHistory);
  }

  function logout(silent = false) {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    state.token = '';
    state.user = null;
    state.room = null;
    state.game = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROOM_KEY);
    resetClientState();
    el.connBanner.hidden = true;
    showLogin();
    setAuthMode('login');
    loadSettings();
    if (!silent) toast('已退出登录');
  }

  // =========================================================
  // 大厅
  // =========================================================

  function renderLobby() {
    el.onlineCount.textContent = state.lobby.online ?? 0;
    renderOnline();
    const rooms = state.lobby.rooms || [];
    el.roomCount.textContent = rooms.length;
    if (!rooms.length) {
      el.roomList.innerHTML = '<div class="empty-state">暂无房间，创建一间吧。</div>';
      return;
    }
    el.roomList.innerHTML = rooms
      .map((r) => {
        const label = r.status === 'waiting' ? '等待中' : r.status === 'playing' ? '游戏中' : '结算中';
        const canJoin = r.status !== 'playing';
        return `<div class="room-row">
          <div class="room-row-main">
            <div class="room-row-name">${esc(r.name)}</div>
            <div class="room-row-meta">
              <span>#${esc(r.id)}</span>
              <span>房主 ${esc(r.hostName)}</span>
              <span>${r.count}/4</span>
              ${r.round ? `<span>R${r.round}</span>` : ''}
            </div>
          </div>
          <span class="status-badge ${esc(r.status)}">${label}</span>
          <button class="btn btn-tiny btn-join" data-room="${esc(r.id)}" ${canJoin ? '' : 'disabled'}>加入</button>
        </div>`;
      })
      .join('');
  }

  function renderOnline() {
    const users = state.lobby.onlineUsers || [];
    if (el.onlinePanelCount) el.onlinePanelCount.textContent = users.length;
    if (!el.onlineList) return;
    if (!users.length) {
      el.onlineList.innerHTML = '<div class="empty-state">暂无在线玩家</div>';
      return;
    }
    const meId = state.user ? state.user.id : null;
    el.onlineList.innerHTML = users
      .map((u) => {
        const isMe = meId && u.id === meId;
        return `<div class="online-row${isMe ? ' me' : ''}">
          <i class="online-dot"></i>
          <span class="online-name">${esc(u.name)}${isMe ? ' · 你' : ''}</span>
          <span class="online-user">@${esc(u.username)}</span>
        </div>`;
      })
      .join('');
  }

  async function createRoom() {
    const name = $('#room-name').value.trim();
    const res = await socketCall('room:create', { name });
    if (!res.ok) return toast(res.error || '创建失败');
    $('#room-name').value = '';
    state.game = null;
    showRoomScreen();
  }

  async function joinRoom(roomId) {
    const res = await socketCall('room:join', { roomId });
    if (!res.ok) return toast(res.error || '加入失败');
    state.game = null;
    showRoomScreen();
  }

  function showRoomScreen() {
    showScreen('room');
    closeOverlay(el.overlaySettle);
    closeOverlay(el.overlayHandover);
    if (state.room) el.roomCode.textContent = state.room.id;
    el.roomMyName.textContent = state.user ? state.user.name : '-';
  }

  function renderRoom() {
    if (!state.room) return;
    const room = state.room;
    el.roomCode.textContent = room.id;
    el.roomTitle.textContent = room.name;
    el.roomMyName.textContent = state.user ? state.user.name : '-';
    const phaseLabel = room.phase === 'waiting' ? 'WAITING' : room.phase === 'playing' ? 'IN BATTLE' : 'SETTLED';
    el.roomStatus.textContent = phaseLabel;
    el.roomStatus.style.color = room.phase === 'playing' ? 'var(--yellow)' : room.phase === 'settled' ? 'var(--purple)' : 'var(--teal)';

    const seats = room.seats || [null, null, null, null];
    const hostId = seats[room.hostSeat] ? seats[room.hostSeat].userId : null;
    const hostViewer = !!(state.user && hostId && hostId === state.user.id);
    el.roomSeats.innerHTML = seats
      .map((s, i) => {
        if (!s) {
          return `<div class="seat-box empty">
            <div class="seat-index">SEAT ${i + 1}</div>
            <div class="seat-name" style="color:var(--dim)">空位</div>
            <div class="seat-state">等待加入 / 机器人</div>
          </div>`;
        }
        const isMe = state.user && s.userId === state.user.id;
        const isHost = room.hostSeat === i;
        const offline = !s.connected;
        const canKick = hostViewer && !isHost && room.phase !== 'playing';
        return `<div class="seat-box ${isMe ? 'me' : ''}">
          <div class="seat-index">SEAT ${i + 1}</div>
          ${isHost ? '<div class="seat-badge host">HOST</div>' : s.isBot ? '<div class="seat-badge">BOT</div>' : ''}
          ${canKick ? `<button class="seat-remove" data-kick="${i}" title="移除该玩家">✕</button>` : ''}
          ${avatarSvg(i)}
          <div class="seat-name">${esc(s.name)}${isMe ? ' · 你' : ''}</div>
          <div class="seat-user">@${esc(s.username)}</div>
          <div class="seat-state ${offline ? 'offline' : 'ready'}">${s.isBot ? 'AI 已就绪' : offline ? '离线' : '已就绪'}</div>
        </div>`;
      })
      .join('');

    const humans = seats.filter((s) => s && !s.isBot).length;
    const filled = seats.filter(Boolean).length;
    const isHost = hostViewer;
    el.btnStart.hidden = !isHost || room.phase === 'playing';
    el.btnStart.disabled = filled < 4 || room.phase === 'playing';
    el.btnAddBot.hidden = !isHost || filled >= 4 || room.phase === 'playing';
    el.roomHint.textContent =
      room.phase === 'playing'
        ? '游戏进行中'
        : filled < 4
          ? `还差 ${4 - filled} 个座位（当前真人 ${humans}）`
          : '四人到齐，可以开始';
    el.roomSub.textContent = `第 ${room.round || 1} 局 · 房号 ${room.id}`;

    if ((room.round || 0) > 0) {
      el.roomScoreboard.hidden = false;
      el.roomScoreList.innerHTML = room.seats
        .map((s, i) => {
          if (!s) return '';
          return `<div class="score-row">
            <span class="score-pos">SEAT ${i + 1}</span>
            <span style="flex:1">${esc(s.name)}${s.isBot ? ' <span style="color:var(--dim)">[BOT]</span>' : ''}</span>
            <b>${room.scores[i] > 0 ? '+' : ''}${room.scores[i]}</b>
          </div>`;
        })
        .join('');
    } else {
      el.roomScoreboard.hidden = true;
    }
  }

  // =========================================================
  // 牌局渲染
  // =========================================================

  function showGameScreen() {
    showScreen('game');
    closeOverlay(el.overlayRules);
    closeOverlay(el.overlayPassword);
    if (state.room) el.roomCode.textContent = state.room.id;
  }

  function renderGame() {
    const g = state.game;
    if (!g || !state.room) return;

    const mySeat = g.you.seat;
    const myInfo = g.seats.find((s) => s.seat === mySeat);
    const opponents = [
      { seat: (mySeat + 1) % 4, node: el.seatLeft },
      { seat: (mySeat + 2) % 4, node: el.seatTop },
      { seat: (mySeat + 3) % 4, node: el.seatRight }
    ];

    el.hudRound.textContent = `ROUND ${String(g.round).padStart(2, '0')}`;
    const dealer = g.seats[g.dealerSeat];
    el.hudDealer.innerHTML = `发牌：${esc(dealer ? dealer.name : '-')} · 第 ${g.seats.filter((s) => s.finishRank).length} / 4 出完`;
    el.hudCollected.textContent = myInfo ? myInfo.collected : 0;
    el.hudTotal.textContent = myInfo ? myInfo.totalScore : 0;

    const turnSeat = g.seats.find((s) => s.seat === g.turnSeat);
    if (g.phase === 'dealing') {
      el.hudTurn.textContent = '发牌中…';
      el.hudTurn.classList.remove('your-turn');
    } else if (g.phase === 'playing') {
      if (g.you.isTurn) {
        el.hudTurn.textContent = '轮到你出牌';
        el.hudTurn.classList.add('your-turn');
      } else if (turnSeat) {
        el.hudTurn.textContent = `${turnSeat.name} 出牌中`;
        el.hudTurn.classList.remove('your-turn');
      } else if (bumpWindowOpen(g)) {
        el.hudTurn.textContent = '撞倒计时中…';
        el.hudTurn.classList.remove('your-turn');
      }
    } else if (g.phase === 'handover') {
      el.hudTurn.textContent = '第四名正在上缴牌…';
      el.hudTurn.classList.remove('your-turn');
    } else {
      el.hudTurn.textContent = '本局结算';
      el.hudTurn.classList.remove('your-turn');
    }

    for (const { seat, node } of opponents) {
      const s = g.seats.find((x) => x.seat === seat);
      node.innerHTML = '';
      if (!s) continue;
      node.appendChild(renderSeatCard(s, g));
    }

    const selfSeat = g.seats.find((x) => x.seat === mySeat);
    el.seatBottom.innerHTML = '';
    if (selfSeat) el.seatBottom.appendChild(renderSeatCard(selfSeat, g));

    // 自己的手牌信息
    el.handSeat.textContent = `YOU · SEAT ${mySeat + 1}`;
    const status = [];
    if (g.phase === 'dealing') status.push('发牌中…');
    else if (g.phase !== 'playing') status.push(g.phase === 'handover' ? '等待上缴' : '本局结束');
    else if (g.you.finishRank) status.push(`你已出完手牌 · 第 ${g.you.finishRank} 名`);
    else if (g.you.isTurn) status.push('轮到你出牌');
    else status.push(`等待 ${turnSeat ? turnSeat.name : '其他玩家'}`);
    if (g.you.canBump && g.phase === 'playing') status.push('可抢撞');
    el.handStatus.textContent = status.join(' · ');
    el.handStatus.classList.toggle('my-turn', !!g.you.isTurn);

    const sig = `${g.round}:${mySeat}:${g.phase}:${g.you.isTurn}:${g.you.hand.map((c) => c.id).join(',')}`;
    if (sig !== state.handSig) {
      state.handSig = sig;
      if (!g.you.isTurn) state.selected.clear();
      renderHand(g);
    }
    updateHandSelection();
    updateActions();

    // 中央
    renderBase(g);
    renderPile(g);
    updateBump(g);
    renderLog(g);
    renderCounter(g);
    updateOverlays(g);
    updateBars();
  }

  function renderSeatCard(s, g) {
    const wrap = document.createElement('div');
    const isTurn = g.phase === 'playing' && g.turnSeat === s.seat;
    const isSelf = g.you.seat === s.seat;
    wrap.className = `seat-card ${isTurn ? 'turn' : ''} ${s.finishRank ? 'finished' : ''} ${s.connected ? '' : 'offline'} ${isSelf ? 'me' : ''}`;
    const tags = [];
    if (isSelf) tags.push('<span class="seat-rank-badge" style="color:var(--yellow);border-color:#6b5514;background:#1c1604">我</span>');
    if (s.finishRank) tags.push(`<span class="seat-rank-badge">第 ${s.finishRank} 名</span>`);
    if (!s.connected) tags.push('<span class="seat-offline-tag">离线托管</span>');
    if (s.isBot) tags.push('<span class="seat-rank-badge" style="color:var(--purple);border-color:#453475;background:#160f28">BOT</span>');
    if (isTurn) tags.push('<span class="seat-rank-badge" style="color:var(--yellow);border-color:#6b5514;background:#1c1604">出牌中</span>');

    wrap.innerHTML = `${avatarSvg(s.seat, s.isBot ? 1 : 0)}
      <div class="seat-info">
        <div class="seat-name">${esc(s.name)}</div>
        <div class="seat-meta">${tags.join(' ')}</div>
        <div class="seat-cards">手牌 <b>${s.cardCount}</b><span class="seat-collect-pill">收牌 <b>${s.collected}</b></span></div>
      </div>`;
    return wrap;
  }

  function cardElement(card, disabled) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `card ${card.red ? 'red' : ''} ${disabled ? 'disabled' : ''}`;
    btn.dataset.id = card.id;
    btn.innerHTML = `
      <span class="c-rank">${esc(card.label)}</span>
      <span class="c-suit">${card.symbol}</span>
      <span class="c-center">${card.symbol}</span>
      <span class="c-bottom"><span>${esc(card.label)}</span><span>${card.symbol}</span></span>
      ${card.id === 'S3' ? '<span class="c-spade3">♠3 首出</span>' : ''}
    `;
    return btn;
  }

  function renderHand(g) {
    el.hand.innerHTML = '';
    const canSelect = g.phase === 'playing' && g.you.isTurn && !g.you.finishRank;
    g.you.hand.forEach((card) => {
      const node = cardElement(card, !canSelect);
      node.addEventListener('click', () => {
        if (!canSelect) return;
        if (state.selected.has(card.id)) state.selected.delete(card.id);
        else {
          if (state.selected.size >= 4) return toast('最多选择 4 张牌');
          state.selected.add(card.id);
        }
        updateHandSelection();
        updateActions();
      });
      el.hand.appendChild(node);
    });
    el.handEmpty.hidden = g.you.hand.length > 0;
  }

  function selectedCards() {
    if (!state.game) return [];
    return state.game.you.hand.filter((c) => state.selected.has(c.id));
  }

  function updateHandSelection() {
    const ids = state.selected;
    $$('#hand .card').forEach((node) => node.classList.toggle('selected', ids.has(node.dataset.id)));
    const cards = selectedCards();
    const g = state.game;
    if (!cards.length) {
      el.handSelected.textContent = '';
      return;
    }
    const combo = analyze(cards);
    el.handSelected.textContent = `${cards.length} 张${combo ? ' · ' + TYPE_LABEL[combo.type] + ' ' + combo.label : ' · 牌型无效'}`;
  }

  function updateActions() {
    const g = state.game;
    if (!g) return;
    const isTurn = g.phase === 'playing' && g.you.isTurn && !g.you.finishRank;
    const cards = selectedCards();
    const evalResult = cards.length ? evaluateSelection(g, cards) : null;
    const canPlay = isTurn && evalResult && evalResult.ok;
    const bumpOpen = bumpWindowOpen(g);

    // 发牌阶段：所有按钮禁用
    if (g.phase === 'dealing') {
      el.btnPlay.disabled = true;
      el.btnPass.disabled = true;
      el.btnBump.hidden = true;
      el.handHint.textContent = '正在发牌…';
      el.handHint.className = 'hand-hint';
      return;
    }

    el.btnPlay.disabled = !canPlay;
    el.btnPass.disabled = !(isTurn && g.you.canPass);
    el.btnBump.hidden = !(g.phase === 'playing' && g.you.canBump && g.bump);
    el.btnBump.disabled = !(g.phase === 'playing' && g.you.canBump && bumpOpen);

    let hint = '';
    let hintClass = '';
    if (g.phase === 'handover') {
      hint = g.you.seat === g.handover?.seat ? '请选择上缴牌' : '第四名正在选择上缴牌…';
    } else if (g.phase === 'settled') {
      hint = '本局结束';
    } else if (g.you.finishRank) {
      hint = `你已出完手牌，排名第 ${g.you.finishRank}`;
    } else if (g.you.canBump && bumpOpen) {
      hint = `可以抢撞！手牌中有对${g.base.label}，点击「撞」`;
      hintClass = 'good';
    } else if (bumpOpen && !g.you.canBump) {
      hint = '撞倒计时中，等待其他玩家抢撞或倒计时结束…';
    } else if (isTurn) {
      if (!g.base) {
        hint = '本轮由你先出，可自由出牌';
      } else if (cards.length && evalResult) {
        hint = evalResult.text;
        hintClass = evalResult.ok ? 'good' : 'warn';
      } else if (!g.you.legalPlays.length) {
        hint = '你没有可压制的牌，请点击「不要」';
        hintClass = 'warn';
      } else {
        hint = '你有可压制的牌，必须出牌（禁止主动 Pass）';
        hintClass = 'warn';
      }
    } else {
      hint = '等待其他玩家出牌';
    }
    el.handHint.textContent = hint;
    el.handHint.className = `hand-hint ${hintClass}`;
  }

  function renderBase(g) {
    if (!g.base) {
      el.baseStrip.className = 'base-strip';
      el.baseStrip.innerHTML = '新一轮 · 自由出牌';
      return;
    }
    const owner = g.seats.find((s) => s.seat === g.base.seat);
    const cls = g.base.type === 'bump' ? 'bump-state' : g.base.type === 'bomb' || g.base.type === 'thousand' ? 'hot' : '';
    el.baseStrip.className = `base-strip ${cls}`;
    el.baseStrip.innerHTML = `当前基准：<b>${esc(g.base.typeLabel)} ${esc(g.base.label)}</b> · ${esc(owner ? owner.name : '-')}`;
  }

  function miniCard(card) {
    return `<div class="mini-card ${card.red ? 'red' : ''}"><span>${esc(card.label)}</span><span class="ms">${card.symbol}</span></div>`;
  }

  function renderPile(g) {
    el.pile.innerHTML = '';
    if (!g.pile.length) {
      el.pile.innerHTML = '<div class="pile-empty">· · · 桌面 · · ·</div>';
      return;
    }
    const recent = g.pile.slice(-3);
    recent.forEach((play, idx) => {
      const owner = g.seats.find((s) => s.seat === play.seat);
      const group = document.createElement('div');
      group.className = `pile-group ${idx === recent.length - 1 ? 'base' : ''}`;
      group.innerHTML = `<div class="mini-cards">${play.cards.map(miniCard).join('')}</div>
        <div class="pile-owner">${esc(owner ? owner.name : '-')} · ${esc(play.typeLabel)}</div>`;
      el.pile.appendChild(group);
    });
  }

  function updateBump(g) {
    const open = g.phase === 'playing' && g.bump && bumpWindowOpen(g);
    el.bumpAlert.hidden = !open;
    if (open) {
      el.bumpDesc.textContent = `可用对${g.bump.label}抢撞 · 先提交者成功`;
    }
  }

  function renderLog(g) {
    if (!g.log) return;
    if (g.log.length === state.lastLogCount && el.logList.childElementCount) return;
    state.lastLogCount = g.log.length;
    el.logList.innerHTML = g.log
      .slice(-14)
      .map((entry) => `<div class="log-entry ${esc(entry.kind)}"><span class="lg-time">${timeText(entry.at)}</span><span>${esc(entry.text)}</span></div>`)
      .join('');
    el.logList.scrollTop = el.logList.scrollHeight;
  }

  function updateBars() {
    const g = state.game;
    if (!g) return;

    if (g.phase === 'dealing' && g.dealingDeadline) {
      const left = Math.max(0, g.dealingDeadline - now());
      const ratio = Math.max(0, Math.min(1, left / DEALING_MS));
      el.turnBarFill.style.transform = `scaleX(${ratio})`;
      el.turnBarFill.style.background = 'var(--teal)';
    } else if (g.phase === 'playing' && g.turnDeadline) {
      el.turnBarFill.style.background = '';
      const left = Math.max(0, g.turnDeadline - now());
      const ratio = Math.max(0, Math.min(1, left / TURN_MS));
      el.turnBarFill.style.transform = `scaleX(${ratio})`;
    } else {
      el.turnBarFill.style.transform = 'scaleX(0)';
    }

    const bumpOpen = g.phase === 'playing' && g.bump && g.bump.deadline > now() && g.base && g.base.type === 'single';
    el.bumpAlert.hidden = !bumpOpen;
    if (bumpOpen) {
      const left = g.bump.deadline - now();
      const ratio = Math.max(0, Math.min(1, left / BUMP_MS));
      el.bumpBarFill.style.transform = `scaleX(${ratio})`;
    }

    if (g.phase === 'handover' && g.handover) {
      const left = Math.max(0, g.handover.deadline - now());
      el.handoverBarFill.style.transform = `scaleX(${Math.max(0, Math.min(1, left / HANDOVER_MS))})`;
    }
  }

  function startTicker() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (state.screen === 'game' && state.game) {
        updateBars();
        if (state.game.phase === 'playing') updateActions();
      }
    }, 120);
  }

  // =========================================================
  // 出牌动作
  // =========================================================

  async function doPlay() {
    const g = state.game;
    if (!g) return;
    const cards = selectedCards();
    if (!cards.length) return toast('请先选择手牌');
    const evaluation = evaluateSelection(g, cards);
    if (!evaluation.ok) return toast(evaluation.text);
    el.btnPlay.disabled = true;
    const res = await socketCall('game:play', { ids: cards.map((c) => c.id) });
    if (!res.ok) {
      toast(res.error || '出牌失败');
      updateActions();
      return;
    }
    state.selected.clear();
  }

  async function doPass() {
    const res = await socketCall('game:pass');
    if (!res.ok) return toast(res.error || '操作失败');
    state.selected.clear();
  }

  async function doBump() {
    const res = await socketCall('game:bump');
    if (!res.ok) return toast(res.error || '撞失败');
    state.selected.clear();
  }

  // =========================================================
  // 结算 / 上缴 / overlay
  // =========================================================

  function updateOverlays(g) {
    if (!g) return;

    if (g.phase === 'handover' && g.handover && g.you.seat === g.handover.seat) {
      openOverlay(el.overlayHandover);
      renderHandover(g);
    } else if (g.phase !== 'handover') {
      closeOverlay(el.overlayHandover);
    } else if (g.phase === 'handover' && g.you.seat !== g.handover.seat) {
      closeOverlay(el.overlayHandover);
    }

    if (g.phase === 'settled' && g.results) {
      const key = `settle:${g.round}:${g.results.rows.map((r) => r.totalScore).join(',')}`;
      if (key !== state.settleKey) {
        state.settleKey = key;
        renderSettle(g);
      }
      openOverlay(el.overlaySettle);
    } else {
      closeOverlay(el.overlaySettle);
    }
  }

  function renderHandover(g) {
    const h = g.handover;
    if (!h) return;
    const need = h.need;
    el.handoverTitle.textContent = `上缴 ${need} 张手牌`;
    const first = g.seats.find((s) => s.seat === h.toSeat);
    const topNote = h.toppedUp > 0 ? `手牌不足部分已从你本局收牌中补足 ${h.toppedUp} 张。` : '';
    el.handoverDesc.textContent = `你以第四名结束本局，需选择 ${need} 张手牌交给第一名 ${first ? first.name : '-'}。${topNote}上缴牌不计入收牌计分。`;
    el.handoverWait.hidden = true;
    el.btnHandoverConfirm.hidden = false;
    el.handoverHand.hidden = false;

    const valid = new Set(g.you.hand.map((c) => c.id));
    for (const id of Array.from(state.handoverSelected)) if (!valid.has(id)) state.handoverSelected.delete(id);

    el.handoverHand.innerHTML = '';
    g.you.hand.forEach((card) => {
      const node = cardElement(card, false);
      if (state.handoverSelected.has(card.id)) node.classList.add('selected');
      node.addEventListener('click', () => {
        if (state.handoverSelected.has(card.id)) state.handoverSelected.delete(card.id);
        else {
          if (state.handoverSelected.size >= need) return toast(`只能选择 ${need} 张`);
          state.handoverSelected.add(card.id);
        }
        renderHandover(g);
      });
      el.handoverHand.appendChild(node);
    });
    el.handoverCount.textContent = state.handoverSelected.size;
    el.btnHandoverConfirm.disabled = state.handoverSelected.size !== need;
    el.handoverBarFill.style.transform = `scaleX(${Math.max(0, Math.min(1, (h.deadline - now()) / HANDOVER_MS))})`;
  }

  async function confirmHandover() {
    const ids = Array.from(state.handoverSelected);
    const res = await socketCall('game:handover', { ids });
    if (!res.ok) return toast(res.error || '上缴失败');
  }

  function renderSettle(g) {
    const r = g.results;
    if (r.thirteenBroken != null) {
      const winner = g.seats.find((s) => s.seat === r.thirteenBroken);
      el.settleTitle.textContent = `第 ${r.round} 局 · 十三烂`;
    } else {
      el.settleTitle.textContent = `第 ${r.round} 局结算`;
    }
    const hostSeat = state.room ? state.room.hostSeat : null;
    const roomSeat = state.room && state.room.seats[hostSeat];
    const isHost = !!(state.user && roomSeat && roomSeat.userId === state.user.id);

    const head = `<div class="settle-row head"><span>名次</span><span>玩家</span><span>收牌</span><span>本局</span><span>累计</span></div>`;
    const rows = r.rows
      .map((row) => {
        const deltaClass = row.scoreDelta > 0 ? 'plus' : row.scoreDelta < 0 ? 'minus' : '';
        return `<div class="settle-row ${row.finishRank === 1 ? 'top1' : ''} ${row.seat === g.you.seat ? 'me' : ''}">
          <span class="place">${['①', '②', '③', '④'][row.finishRank - 1] || row.finishRank}</span>
          <span>${esc(row.name)}${row.seat === g.you.seat ? '（你）' : ''}${row.isBot ? ' <span style="color:var(--dim);font-size:10px">BOT</span>' : ''}</span>
          <span class="collected">${row.collected}</span>
          <span class="delta ${deltaClass}">${row.scoreDelta > 0 ? '+' : ''}${row.scoreDelta}</span>
          <span class="total">${row.totalScore > 0 ? '+' : ''}${row.totalScore}</span>
        </div>`;
      })
      .join('');
    el.settleTable.innerHTML = head + rows;

    if (r.thirteenBroken != null) {
      const winner = g.seats.find((s) => s.seat === r.thirteenBroken);
      el.handoverNote.hidden = false;
      el.handoverNote.innerHTML = `<b style="color:var(--yellow)">十三烂！</b> ${esc(winner ? winner.name : '某玩家')} 手牌 3~2 各一张（无重复），直接获胜。其余三家各输 13 分，胜者 +39 分。`;
    } else if (r.handover && r.handover.cards && r.handover.cards.length) {
      const from = g.seats.find((s) => s.seat === r.handover.fromSeat);
      const to = g.seats.find((s) => s.seat === r.handover.toSeat);
      el.handoverNote.hidden = false;
      el.handoverNote.innerHTML = `<b>上缴</b> ${esc(from ? from.name : '第四名')} → ${esc(to ? to.name : '第一名')} · ${r.handover.cards.length} 张
        <span style="color:var(--muted);font-size:11px">（末家剩余手牌计入收牌；上缴部分末家 -${r.handover.cards.length}、头家 +${r.handover.cards.length}）</span>
        <div class="tribute-cards">${r.handover.cards.map(miniCard).join('')}</div>`;
    } else {
      el.handoverNote.hidden = true;
    }

    el.btnNextRound.hidden = !isHost;
    el.btnNextRound.disabled = false;
    el.settleWait.hidden = isHost;
  }

  // =========================================================
  // 音频
  // =========================================================

  function bindAudio() {
    const A = window.Audio;
    if (!A) return;
    const $a = (id) => document.getElementById(id);
    const toggle = $a('audio-toggle');
    const body = $a('audio-body');
    const icon = $a('audio-icon');
    const bgmBtn = $a('audio-bgm-toggle');
    const sfxBtn = $a('audio-sfx-toggle');
    const bgmVol = $a('audio-bgm-vol');
    const sfxVol = $a('audio-sfx-vol');
    const masterVol = $a('audio-master-vol');

    const refresh = () => {
      bgmBtn.textContent = A.bgmOn ? '开' : '关';
      sfxBtn.textContent = A.sfxOn ? '开' : '关';
      bgmVol.value = Math.round(A.bgmVol * 100);
      sfxVol.value = Math.round(A.sfxVol * 100);
      masterVol.value = Math.round(A.masterVol * 100);
      toggle.classList.toggle('off', !A.bgmOn && !A.sfxOn);
      icon.textContent = A.bgmOn ? '♪' : '♩';
    };
    refresh();

    toggle.addEventListener('click', () => {
      A.ensure();
      if (body.hidden) {
        body.hidden = false;
      } else {
        // 点图标快速切换：全部静音/恢复
        const anyOn = A.bgmOn || A.sfxOn;
        A.toggleBGM(!anyOn);
        A.toggleSFX(!anyOn);
        body.hidden = true;
      }
      refresh();
    });

    bgmBtn.addEventListener('click', () => { A.ensure(); A.toggleBGM(); A.click(); refresh(); });
    sfxBtn.addEventListener('click', () => { A.toggleSFX(); A.click(); refresh(); });
    bgmVol.addEventListener('input', (e) => { A.setBgmVol(Number(e.target.value) / 100); });
    sfxVol.addEventListener('input', (e) => { A.setSfxVol(Number(e.target.value) / 100); });
    masterVol.addEventListener('input', (e) => { A.setMasterVol(Number(e.target.value) / 100); });
  }

  /** 根据前后两帧状态触发对应音效 */
  function playGameSounds(prev, g) {
    const A = window.Audio;
    if (!A) return;
    if (!prev) return;
    if (g.phase === 'settled' && prev.phase !== 'settled') {
      const rank = g.you && g.you.finishRank;
      if (rank === 1) A.win();
      else if (rank === 4) A.lose();
      else A.collect();
      return;
    }
    if (g.phase === 'handover' && prev.phase !== 'handover') {
      A.error();
      return;
    }
    if (g.phase !== 'playing') return;

    const prevBase = prev.base;
    const base = g.base;

    // 轮到自己
    const wasTurn = prev.you && prev.you.isTurn;
    const isTurn = g.you && g.you.isTurn;
    if (!wasTurn && isTurn && !base) A.myTurn();

    // 出牌 / 撞
    if (base && (!prevBase || prevBase.seat !== base.seat || prevBase.type !== base.type || prevBase.rank !== base.rank)) {
      if (base.type === 'bump') A.bump();
      else A.cardPlay();
      return;
    }

    // Pass
    if (g.passes > (prev.passes || 0)) {
      A.pass();
      return;
    }

    // 收牌：base 从有到无（新一墩开始）
    if (!base && prevBase) {
      A.collect();
      return;
    }

    // 发牌：进入 dealing
    if (g.phase === 'playing' && prev.phase === 'dealing' && !base) {
      A.deal();
    }
  }

  // =========================================================
  // 事件绑定
  // =========================================================

  function bindUi() {
    bindAudio();
    el.loginForm.addEventListener('submit', onAuthSubmit);
    $$('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
    });
    $('#btn-logout').addEventListener('click', () => logout());
    $('#login-rules').addEventListener('click', () => openOverlay(el.overlayRules));
    $('#lobby-rules').addEventListener('click', () => openOverlay(el.overlayRules));
    $('#btn-game-rules').addEventListener('click', () => openOverlay(el.overlayRules));
    $('#btn-close-rules').addEventListener('click', () => closeOverlay(el.overlayRules));
    el.btnHistory.addEventListener('click', openHistory);
    el.btnCloseHistory.addEventListener('click', () => closeOverlay(el.overlayHistory));
    el.btnCounter.addEventListener('click', () => {
      state.counterVisible = !state.counterVisible;
      if (state.game) renderCounter(state.game);
    });

    $('#btn-create-room').addEventListener('click', createRoom);
    $('#room-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createRoom();
    });
    $('#btn-join-room').addEventListener('click', () => {
      const code = $('#join-code').value.trim().toUpperCase();
      if (!code) return toast('请输入房号');
      joinRoom(code);
    });
    $('#join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-join-room').click();
    });
    el.roomList.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-join');
      if (!btn) return;
      joinRoom(btn.dataset.room);
    });

    $('#btn-copy-code').addEventListener('click', async () => {
      if (!state.room) return;
      try {
        await navigator.clipboard.writeText(state.room.id);
        toast('房号已复制');
      } catch (e) {
        toast(`房号：${state.room.id}`);
      }
    });

    $('#btn-add-bot').addEventListener('click', async () => {
      const res = await socketCall('room:addBot', {});
      if (!res.ok) toast(res.error || '添加失败');
    });
    el.roomSeats.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-kick]');
      if (!btn) return;
      btn.disabled = true;
      const res = await socketCall('room:kick', { seat: Number(btn.dataset.kick) });
      if (!res.ok) {
        toast(res.error || '移除失败');
        btn.disabled = false;
      }
    });
    $('#btn-start').addEventListener('click', async () => {
      el.btnStart.disabled = true;
      const res = await socketCall('room:start');
      if (!res.ok) {
        toast(res.error || '开始失败');
        el.btnStart.disabled = false;
      }
    });
    $('#btn-leave-room').addEventListener('click', leaveRoom);
    $('#btn-game-leave').addEventListener('click', leaveRoom);

    el.btnPlay.addEventListener('click', doPlay);
    el.btnPass.addEventListener('click', doPass);
    el.btnBump.addEventListener('click', doBump);
    el.btnHandoverConfirm.addEventListener('click', confirmHandover);

    $('#btn-settle-lobby').addEventListener('click', leaveRoom);
    el.btnNextRound.addEventListener('click', async () => {
      el.btnNextRound.disabled = true;
      const res = await socketCall('room:start');
      if (!res.ok) {
        toast(res.error || '开始失败');
        el.btnNextRound.disabled = false;
      }
    });

    // 改密
    $('#btn-change-pw').addEventListener('click', () => {
      el.pwError.textContent = '';
      $('#pw-old').value = '';
      $('#pw-new').value = '';
      openOverlay(el.overlayPassword);
    });
    $('#btn-pw-cancel').addEventListener('click', () => closeOverlay(el.overlayPassword));
    $('#btn-pw-save').addEventListener('click', async () => {
      const oldPassword = $('#pw-old').value;
      const newPassword = $('#pw-new').value;
      el.pwError.textContent = '';
      const res = await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword })
      });
      if (!res.ok) {
        el.pwError.textContent = res.error;
        return;
      }
      closeOverlay(el.overlayPassword);
      toast('密码已修改');
    });

    // overlay 关闭
    el.overlayRules.addEventListener('click', (e) => {
      if (e.target === el.overlayRules) closeOverlay(el.overlayRules);
    });
    el.overlayPassword.addEventListener('click', (e) => {
      if (e.target === el.overlayPassword) closeOverlay(el.overlayPassword);
    });
    el.overlayHistory.addEventListener('click', (e) => {
      if (e.target === el.overlayHistory) closeOverlay(el.overlayHistory);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeOverlay(el.overlayRules);
        closeOverlay(el.overlayPassword);
        closeOverlay(el.overlayHistory);
      }
      if (e.key === 'Enter' && state.screen === 'game' && !el.btnPlay.disabled && document.activeElement === document.body) {
        doPlay();
      }
    });

    startTicker();
  }

  async function leaveRoom() {
    const res = await socketCall('room:leave');
    if (!res.ok) return toast(res.error || '离开失败');
    state.room = null;
    state.game = null;
    state.handSig = '';
    state.selected.clear();
    state.handoverSelected.clear();
    localStorage.removeItem(ROOM_KEY);
    closeOverlay(el.overlaySettle);
    closeOverlay(el.overlayHandover);
    showScreen('lobby');
    renderLobby();
    if (state.socket) state.socket.emit('lobby:refresh');
  }

  // 启动
  boot();
})();
