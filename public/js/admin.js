/* global */
(() => {
  'use strict';

  const TOKEN_KEY = 't13_token';
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    users: [],
    summary: {},
    rooms: [],
    resetUser: null,
    refreshTimer: null,
    toastTimer: null
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    login: $('#admin-login'),
    dashboard: $('#admin-dashboard'),
    loginForm: $('#admin-login-form'),
    username: $('#admin-username'),
    password: $('#admin-password'),
    loginBtn: $('#admin-login-btn'),
    loginError: $('#admin-login-error'),
    adminName: $('#admin-name'),
    adminOnline: $('#admin-online'),
    sumUsers: $('#sum-users'),
    sumAdmins: $('#sum-admins'),
    sumOnline: $('#sum-online'),
    sumGames: $('#sum-games'),
    userTbody: $('#user-tbody'),
    userCount: $('#user-count'),
    roomList: $('#admin-room-list'),
    roomCount: $('#admin-room-count'),
    newUsername: $('#new-username'),
    newName: $('#new-name'),
    newPassword: $('#new-password'),
    newRole: $('#new-role'),
    createError: $('#create-error'),
    overlayReset: $('#overlay-reset'),
    resetTitle: $('#reset-title'),
    resetPassword: $('#reset-password'),
    resetError: $('#reset-error'),
    settingCardCounter: $('#setting-card-counter'),
    toast: $('#admin-toast')
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
  }

  function show(id) {
    el.login.classList.toggle('active', id === 'login');
    el.dashboard.classList.toggle('active', id === 'dash');
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
    if (!res.ok) {
      if (res.status === 401) state.token = '';
      return { ok: false, error: data.error || '请求失败' };
    }
    return { ok: true, data };
  }

  function boot() {
    bind();
    if (!state.token) {
      show('login');
      return;
    }
    api('/api/me').then((res) => {
      if (!res.ok) {
        show('login');
        return;
      }
      if (res.data.user.role !== 'admin') {
        show('login');
        el.loginError.textContent = '当前账号不是管理员，请使用管理员账号登录';
        return;
      }
      state.user = res.data.user;
      enterDashboard();
    });
  }

  function enterDashboard() {
    show('dash');
    el.adminName.textContent = state.user ? state.user.name : '-';
    loadAll();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(loadAll, 12000);
  }

  function bind() {
    el.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      el.loginError.textContent = '';
      el.loginBtn.disabled = true;
      el.loginBtn.textContent = '验证中…';
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: el.username.value.trim(), password: el.password.value })
      });
      el.loginBtn.disabled = false;
      el.loginBtn.textContent = '进入控制台';
      if (!res.ok) {
        el.loginError.textContent = res.error;
        return;
      }
      if (res.data.user.role !== 'admin') {
        state.token = '';
        localStorage.removeItem(TOKEN_KEY);
        el.loginError.textContent = '该账号不是管理员';
        return;
      }
      state.token = res.data.token;
      state.user = res.data.user;
      localStorage.setItem(TOKEN_KEY, state.token);
      el.password.value = '';
      enterDashboard();
    });

    $('#admin-logout').addEventListener('click', () => {
      state.token = '';
      localStorage.removeItem(TOKEN_KEY);
      state.user = null;
      clearInterval(state.refreshTimer);
      show('login');
      toast('已退出');
    });

    $('#btn-create-user').addEventListener('click', async () => {
      el.createError.textContent = '';
      const username = el.newUsername.value.trim();
      const name = el.newName.value.trim() || username;
      const password = el.newPassword.value;
      const role = el.newRole.value;
      if (!username || !password) {
        el.createError.textContent = '账号与密码不能为空';
        return;
      }
      const res = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, name, password, role })
      });
      if (!res.ok) {
        el.createError.textContent = res.error;
        return;
      }
      el.newUsername.value = '';
      el.newName.value = '';
      el.newPassword.value = '';
      el.newRole.value = 'player';
      toast(`用户 ${res.data.user.username} 已创建`);
      loadAll();
    });

    el.newPassword.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-create-user').click();
    });

    el.userTbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const userId = btn.dataset.id;
      const user = state.users.find((u) => u.id === userId);
      if (!user) return;
      const act = btn.dataset.act;
      if (act === 'reset') {
        state.resetUser = user;
        el.resetTitle.textContent = `重置 ${user.username} 的密码`;
        el.resetPassword.value = '';
        el.resetError.textContent = '';
        el.overlayReset.hidden = false;
      } else if (act === 'toggle-active') {
        patchUser(user.id, { active: !user.active });
      } else if (act === 'toggle-role') {
        patchUser(user.id, { role: user.role === 'admin' ? 'player' : 'admin' });
      } else if (act === 'delete') {
        if (!window.confirm(`确认删除用户 ${user.username}？此操作不可恢复。`)) return;
        api(`/api/admin/users/${user.id}`, { method: 'DELETE' }).then((res) => {
          if (!res.ok) return toast(res.error);
          toast('用户已删除');
          loadAll();
        });
      }
    });

    $('#btn-reset-cancel').addEventListener('click', () => (el.overlayReset.hidden = true));
    el.overlayReset.addEventListener('click', (e) => {
      if (e.target === el.overlayReset) el.overlayReset.hidden = true;
    });
    $('#btn-reset-save').addEventListener('click', async () => {
      if (!state.resetUser) return;
      el.resetError.textContent = '';
      const password = el.resetPassword.value;
      const res = await api(`/api/admin/users/${state.resetUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        el.resetError.textContent = res.error;
        return;
      }
      el.overlayReset.hidden = true;
      toast('密码已重置');
    });

    el.settingCardCounter.addEventListener('change', async () => {
      const enabled = el.settingCardCounter.checked;
      const res = await api('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ cardCounter: enabled })
      });
      if (!res.ok) {
        el.settingCardCounter.checked = !enabled;
        toast(res.error || '设置失败');
        return;
      }
      toast(enabled ? '记牌器已开启' : '记牌器已关闭');
    });
  }

  async function patchUser(id, patch) {
    const res = await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if (!res.ok) return toast(res.error);
    toast('已更新');
    loadAll();
  }

  async function loadAll() {
    const usersRes = await api('/api/admin/users');
    if (!usersRes.ok) {
      if (usersRes.error && usersRes.error.includes('权限')) {
        toast('管理员权限已失效');
        show('login');
      }
      return;
    }
    state.users = usersRes.data.users;
    state.summary = usersRes.data.summary || {};
    renderUsers();

    const roomsRes = await api('/api/admin/rooms');
    if (roomsRes.ok) {
      state.rooms = roomsRes.data.rooms || [];
      state.summary.online = roomsRes.data.online ?? state.summary.online;
      renderRooms();
    }
    renderSummary();
    loadSettings();
  }

  async function loadSettings() {
    const res = await api('/api/admin/settings');
    if (res.ok) {
      el.settingCardCounter.checked = !!res.data.cardCounter;
    }
  }

  function renderSummary() {
    el.sumUsers.textContent = state.summary.users ?? state.users.length;
    el.sumAdmins.textContent = state.summary.admins ?? state.users.filter((u) => u.role === 'admin').length;
    el.sumOnline.textContent = state.summary.online ?? 0;
    el.sumGames.textContent = state.summary.totalGames ?? state.users.reduce((n, u) => n + (u.stats?.games || 0), 0);
    el.adminOnline.textContent = state.summary.online ?? 0;
  }

  function renderUsers() {
    el.userCount.textContent = state.users.length;
    el.userTbody.innerHTML = state.users
      .map((u) => {
        const self = state.user && u.id === state.user.id;
        const last = u.lastLoginAt ? new Date(u.lastLoginAt) : null;
        const lastText = last
          ? `${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')} ${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}`
          : '—';
        return `<tr>
          <td><div class="user-cell-name">${esc(u.name)}${self ? ' <span class="badge">YOU</span>' : ''}</div><div class="user-cell-user">@${esc(u.username)}</div></td>
          <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'ADMIN' : 'PLAYER'}</span></td>
          <td><span class="badge ${u.active ? 'active' : 'disabled'}">${u.active ? '正常' : '禁用'}</span></td>
          <td>${u.stats?.games || 0}</td>
          <td>${u.stats?.wins || 0}</td>
          <td>${u.stats?.score || 0}</td>
          <td>${lastText}</td>
          <td>
            <div class="user-actions">
              <button class="btn btn-tiny" data-act="reset" data-id="${u.id}">改密</button>
              ${self ? '' : `<button class="btn btn-tiny" data-act="toggle-role" data-id="${u.id}">${u.role === 'admin' ? '降为玩家' : '设为管理'}</button>`}
              ${self ? '' : `<button class="btn btn-tiny ${u.active ? 'btn-danger' : ''}" data-act="toggle-active" data-id="${u.id}">${u.active ? '禁用' : '启用'}</button>`}
              ${self ? '' : `<button class="btn btn-tiny btn-danger" data-act="delete" data-id="${u.id}">删除</button>`}
            </div>
          </td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="8" style="color:var(--dim)">暂无用户</td></tr>';
  }

  function renderRooms() {
    el.roomCount.textContent = state.rooms.length;
    if (!state.rooms.length) {
      el.roomList.innerHTML = '<div class="empty-state" style="grid-column:1/-1">当前没有活跃房间</div>';
      return;
    }
    el.roomList.innerHTML = state.rooms
      .map((r) => {
        const label = r.status === 'waiting' ? '等待中' : r.status === 'playing' ? '游戏中' : '结算中';
        return `<div class="admin-room">
          <div class="admin-room-main">
            <div class="admin-room-name">${esc(r.name)}</div>
            <div class="admin-room-meta">#${esc(r.id)} · ${r.count}/4 · 真人 ${r.humans} · R${r.round}</div>
          </div>
          <span class="status-badge ${esc(r.status)}">${label}</span>
        </div>`;
      })
      .join('');
  }

  boot();
})();
