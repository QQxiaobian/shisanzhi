const rules = require('./rules');

const BUMP_WINDOW_MS = 5000;
const TURN_MS = 30000;
const HANDOVER_MS = 45000;
const DEALING_MS = 1400;
const BOT_THINK_MIN = 800;
const BOT_THINK_MAX = 1800;

const TYPE_LABELS = rules.TYPE_LABELS;

function smallHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

class Game {
  /**
   * @param {object} opts
   * @param {object} opts.room 房间信息 {id,name}
   * @param {Array} opts.players 4 个座位 {seat,userId,username,name,isBot,connected,score}
   * @param {Function} opts.onChange 状态变化回调
   * @param {Function} opts.onRoundEnd 结算回调
   */
  constructor({ room, players, onChange, onRoundEnd, round = 0, dealerSeat = null, openerSeat = null }) {
    this.room = room;
    this.onChange = onChange || (() => {});
    this.onRoundEnd = onRoundEnd || (() => {});

    this.seats = [0, 1, 2, 3].map((seat) => {
      const p = players.find((x) => x.seat === seat);
      return {
        seat,
        userId: p ? p.userId : null,
        username: p ? p.username : null,
        name: p ? p.name || p.username : '玩家',
        isBot: !!(p && p.isBot),
        connected: p ? p.connected !== false : false,
        auto: !!(p && (p.isBot || p.auto)),
        hand: [],
        collected: 0,
        collectedCards: [],
        finishRank: null,
        totalScore: (p && Number(p.score)) || 0
      };
    });

    this.phase = 'waiting';
    this.round = round;
    this.dealerSeat = dealerSeat;
    this.openerSeat = openerSeat;
    this.lastFourthSeat = null;
    this.turnSeat = null;
    this.base = null;
    this.pile = [];
    this.passes = 0;
    this.opening = false;
    this.lastPlaySeat = null;
    this.bumpWindow = null;
    this.finishOrder = [];
    this.log = [];
    this.handover = null;
    this.results = null;
    this.playedCards = [];
    this.turnStartedAt = 0;
    this.turnDeadline = 0;
    this.dealingDeadline = 0;
    this.bumpTimer = null;
    this.turnTimer = null;
    this.dealingTimer = null;
    this.botTimers = [];
    this.handoverTimer = null;
    this.serverNow = Date.now();
  }

  // ---------- 基础查询 ----------

  activeSeats() {
    return this.seats.filter((s) => s.finishRank === null && s.hand.length > 0);
  }

  activeCount() {
    return this.activeSeats().length;
  }

  nextActive(fromSeat) {
    for (let i = 1; i <= 4; i++) {
      const s = this.seats[(fromSeat + i) % 4];
      if (!s) continue;
      if (s.finishRank === null && s.hand.length > 0) return s.seat;
    }
    return null;
  }

  seatOf(seat) {
    return this.seats[seat];
  }

  addLog(text, kind = 'info') {
    this.log.push({ text, kind, at: Date.now() });
    if (this.log.length > 60) this.log.shift();
  }

  isBumpWindowOpen() {
    return !!(
      this.bumpWindow &&
      this.base &&
      this.base.type === 'single' &&
      this.base.rank === this.bumpWindow.rank &&
      Date.now() < this.bumpWindow.deadline
    );
  }

  // ---------- 开局 ----------

  startRound() {
    this.clearTimers();
    this.round += 1;
    this.phase = 'playing';
    this.base = null;
    this.pile = [];
    this.passes = 0;
    this.opening = true;
    this.lastPlaySeat = null;
    this.bumpWindow = null;
    this.finishOrder = [];
    this.handover = null;
    this.results = null;
    this.playedCards = [];
    this.log = [];

    if (this.dealerSeat === null) {
      this.dealerSeat = Math.floor(Math.random() * 4);
    }

    for (const s of this.seats) {
      s.hand = [];
      s.collected = 0;
      s.collectedCards = [];
      s.finishRank = null;
      s.auto = s.isBot;
    }

    const deck = rules.shuffle(rules.createDeck());
    const hands = rules.deal(deck);
    this.seats.forEach((s, i) => {
      s.hand = hands[i];
    });

    // 十三烂判定：3~2 各一张，直接获胜
    const brokenSeat = this.seats.find((s) => rules.isThirteenBroken(s.hand));
    if (brokenSeat) {
      this.settleThirteenBroken(brokenSeat.seat);
      return;
    }

    this.phase = 'dealing';
    this.dealingDeadline = Date.now() + DEALING_MS;
    this.addLog(`第 ${this.round} 局开始 · ${this.seats[this.dealerSeat].name} 发牌`, 'system');
    this.refreshTimers();
    this.onChange();
  }

  startPlaying() {
    if (this.phase !== 'dealing') return;
    this.phase = 'playing';

    // 第一局由黑桃3持有者先出牌；之后每局由上局末游先出牌
    let openerSeat = this.openerSeat;
    let reason = '（上局末游）先出牌';
    if (this.round <= 1 || openerSeat === null || openerSeat === undefined) {
      const holder = this.seats.find((s) => s.hand.some((c) => c.id === 'S3'));
      openerSeat = holder ? holder.seat : 0;
      reason = '持有黑桃3，先出牌';
    }
    this.turnSeat = openerSeat;
    this.turnStartedAt = Date.now();
    this.turnDeadline = Date.now() + TURN_MS;
    this.addLog(`${this.seats[this.turnSeat].name} ${reason}（可自由出牌）`, 'system');
    this.refreshTimers();
    this.onChange();
  }

  settleThirteenBroken(winnerSeat) {
    this.clearTimers();
    this.phase = 'settled';
    this.bumpWindow = null;
    this.turnSeat = null;
    const winner = this.seats[winnerSeat];
    winner.finishRank = 1;
    this.finishOrder = [winnerSeat];
    const others = this.seats.filter((s) => s.seat !== winnerSeat);
    others.forEach((s, i) => {
      s.finishRank = i + 2;
      this.finishOrder.push(s.seat);
    });
    this.lastFourthSeat = others[others.length - 1] ? others[others.length - 1].seat : (winnerSeat + 1) % 4;
    this.openerSeat = this.lastFourthSeat;
    this.dealerSeat = winnerSeat;

    this.addLog(`${winner.name} 十三烂（3~2 各一张），直接获胜！其余三家各输 13 分`, 'finish');

    const rows = this.seats.map((s) => {
      const scoreDelta = s.seat === winnerSeat ? 39 : -13;
      s.totalScore += scoreDelta;
      return {
        seat: s.seat,
        name: s.name,
        username: s.username,
        finishRank: s.finishRank,
        collected: 0,
        scoreDelta,
        totalScore: s.totalScore,
        isBot: s.isBot,
        userId: s.userId
      };
    });
    rows.sort((a, b) => a.finishRank - b.finishRank);

    this.results = {
      round: this.round,
      rows,
      handover: { fromSeat: null, toSeat: null, cards: [] },
      thirteenBroken: winnerSeat,
      nextDealer: winnerSeat,
      nextOpener: this.openerSeat
    };
    this.onRoundEnd(this.results, this.seats);
    this.onChange();
  }

  // ---------- 玩家操作 ----------

  play(seat, ids) {
    this.ensurePhase('playing');
    if (this.isBumpWindowOpen()) return { ok: false, error: '撞倒计时中，请抢撞或等待倒计时结束' };
    if (this.turnSeat !== seat) return { ok: false, error: '还没轮到你出牌' };
    const player = this.seats[seat];
    if (!player || player.finishRank !== null) return { ok: false, error: '你已出完手牌' };
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 4) {
      return { ok: false, error: '请选择 1-4 张牌' };
    }
    if (new Set(ids).size !== ids.length) return { ok: false, error: '出牌数据异常' };

    const cards = [];
    for (const id of ids) {
      const card = player.hand.find((c) => c.id === id);
      if (!card) return { ok: false, error: '手牌中没有这张牌' };
      cards.push(card);
    }

    const resolved = rules.resolvePlay(this.base, cards, this.isBumpWindowOpen());
    if (!resolved.ok) return { ok: false, error: resolved.reason };

    if (rules.leavesOnlyTwos(player.hand, ids)) {
      return { ok: false, error: '禁止保留全部为 2 的手牌收尾' };
    }

    this.applyPlay(seat, cards, resolved.combo);
    return { ok: true };
  }

  pass(seat) {
    this.ensurePhase('playing');
    if (this.isBumpWindowOpen()) return { ok: false, error: '撞倒计时中，请抢撞或等待倒计时结束' };
    if (this.turnSeat !== seat) return { ok: false, error: '还没轮到你' };
    const player = this.seats[seat];
    if (!player || player.finishRank !== null) return { ok: false, error: '你已出完手牌' };
    if (!this.base) return { ok: false, error: '新一轮首出必须出牌，不能不要' };

    const legal = rules.enumeratePlays(player.hand, this.base, { opening: false });
    if (legal.length > 0) {
      return { ok: false, error: '你有可压制的牌，必须出牌（禁止主动 Pass）' };
    }

    this.passes += 1;
    this.addLog(`${player.name} 要不起，Pass`, 'pass');
    const lastHasCards = !!(this.seats[this.lastPlaySeat] && this.seats[this.lastPlaySeat].hand.length > 0);
    const needed = rules.passesNeeded(this.activeCount(), lastHasCards);
    if (this.passes >= needed) {
      this.endTrick();
    } else {
      this.turnSeat = this.nextActive(seat);
      this.startTurnClock();
      this.refreshTimers();
    }
    this.onChange();
    return { ok: true };
  }

  bump(seat) {
    this.ensurePhase('playing');
    if (!this.isBumpWindowOpen()) return { ok: false, error: '撞的倒计时已结束' };
    if (this.base && this.base.seat === seat) return { ok: false, error: '不能撞自己打出的单张' };
    const player = this.seats[seat];
    if (!player || player.finishRank !== null) return { ok: false, error: '你已出完手牌' };
    if (!rules.canBump(player.hand, this.base)) {
      return { ok: false, error: '没有同点数的对子，无法撞' };
    }
    const cards = rules.findBumpCards(player.hand, this.base);
    if (rules.leavesOnlyTwos(player.hand, cards.map((c) => c.id))) {
      return { ok: false, error: '撞后剩余手牌全为 2，违规' };
    }
    this.applyPlay(seat, cards, { type: 'bump', rank: this.base.rank, label: this.base.label, size: 2 });
    return { ok: true };
  }

  // ---------- 出牌应用 ----------

  applyPlay(seat, cards, combo) {
    const player = this.seats[seat];
    const ids = new Set(cards.map((c) => c.id));
    player.hand = player.hand.filter((c) => !ids.has(c.id));

    const play = {
      seat,
      cards: rules.sortHand(cards),
      type: combo.type,
      rank: combo.rank,
      label: combo.label,
      typeLabel: TYPE_LABELS[combo.type]
    };
    this.pile.push(play);
    this.playedCards.push(...play.cards);
    this.base = play;
    this.passes = 0;
    this.lastPlaySeat = seat;

    const isBump = combo.type === 'bump';
    this.addLog(
      isBump
        ? `${player.name} 用对${play.label} 撞！`
        : `${player.name} 打出${play.typeLabel} ${play.label}`,
      isBump ? 'bump' : 'play'
    );

    if (this.opening) this.opening = false;

    if (player.hand.length === 0) {
      player.finishRank = this.finishOrder.length + 1;
      this.finishOrder.push(seat);
      this.addLog(`${player.name} 出完手牌，第 ${player.finishRank} 名`, 'finish');
    }

    if (this.finishOrder.length >= 3) {
      this.finalizeTrick();
      this.beginHandover();
      return;
    }

    if (play.type === 'single') {
      // 撞为强制行为：单张打出后，若某家持有该点数的普通对子（恰好 2 张，不拆炸弹/千弹），系统直接出牌
      const bumperSeat = this.findBumpSeat(play.rank, seat);
      if (bumperSeat !== null) {
        const bumpCards = rules.findBumpCards(this.seats[bumperSeat].hand, play);
        this.addLog(`${this.seats[bumperSeat].name} 持有对${play.label}，系统自动撞！`, 'bump');
        this.applyPlay(bumperSeat, bumpCards, {
          type: 'bump',
          rank: play.rank,
          label: play.label,
          size: 2
        });
        return;
      }
    }

    this.turnSeat = this.nextActive(seat);
    this.startTurnClock();
    this.refreshTimers();
    this.onChange();
  }

  /** 找出必须撞的座位：按出牌顺序，首个恰好持有该点数 2 张（非炸弹/千弹）且撞后不会只剩 2 的玩家 */
  findBumpSeat(rank, fromSeat) {
    for (let i = 1; i <= 3; i++) {
      const seat = (fromSeat + i) % 4;
      const s = this.seats[seat];
      if (!s || s.finishRank !== null || s.hand.length === 0) continue;
      const same = s.hand.filter((c) => c.rank === rank);
      if (same.length !== 2) continue;
      if (rules.leavesOnlyTwos(s.hand, same.map((c) => c.id))) continue;
      return seat;
    }
    return null;
  }

  endTrick() {
    if (this.pile.length === 0) return;
    const collector = this.lastPlaySeat;
    if (collector !== null && this.seats[collector]) {
      const cards = this.pile.flatMap((p) => p.cards);
      this.seats[collector].collected += cards.length;
      this.seats[collector].collectedCards.push(...cards);
      this.addLog(`${this.seats[collector].name} 收走本轮 ${cards.length} 张牌`, 'collect');
      this.turnSeat = this.seats[collector].hand.length > 0 ? collector : this.nextActive(collector);
    } else {
      this.turnSeat = this.nextActive(0);
    }
    this.pile = [];
    this.base = null;
    this.passes = 0;
    this.lastPlaySeat = null;
    this.bumpWindow = null;
    this.opening = false;
    this.startTurnClock();
    this.refreshTimers();
    this.onChange();
  }

  finalizeTrick() {
    if (!this.pile.length || this.lastPlaySeat === null) return;
    const collector = this.seats[this.lastPlaySeat];
    if (collector) {
      const cards = this.pile.flatMap((p) => p.cards);
      collector.collected += cards.length;
      collector.collectedCards.push(...cards);
    }
    this.pile = [];
    this.base = null;
  }

  // ---------- 结算 ----------

  beginHandover() {
    this.phase = 'handover';
    this.bumpWindow = null;
    this.turnSeat = null;
    this.clearTimers();

    const fourth = this.seats.find((s) => s.finishRank === null);
    const first = this.seats.find((s) => s.finishRank === 1);
    if (!fourth || !first) {
      this.settle(null, null);
      return;
    }

    // 上缴固定 3 张；若第四名手牌不足，用其本局收牌补足
    const TRIBUTE = 3;
    // 记录上缴前第四名剩余手牌数：结算时计入其收牌，保证四人收牌合计恒为 52
    const surplus = fourth.hand.length;
    let toppedUp = 0;
    if (fourth.hand.length < TRIBUTE && fourth.collectedCards.length > 0) {
      const extra = fourth.collectedCards.slice(0, TRIBUTE - fourth.hand.length);
      if (extra.length) {
        fourth.collectedCards = fourth.collectedCards.slice(extra.length);
        fourth.hand = rules.sortHand(fourth.hand.concat(extra));
        toppedUp = extra.length;
        this.addLog(`第四名手牌不足 3 张，从本局收牌中补足 ${extra.length} 张`, 'system');
      }
    }
    const need = Math.min(TRIBUTE, fourth.hand.length);
    if (need < TRIBUTE) {
      this.addLog(`第四名可上缴的牌不足 3 张，实际上缴 ${need} 张`, 'system');
    }
    this.handover = {
      seat: fourth.seat,
      toSeat: first.seat,
      need,
      toppedUp,
      surplus,
      deadline: Date.now() + HANDOVER_MS,
      chosen: null
    };
    this.addLog(`第 ${fourth.finishRank || 4} 名 ${fourth.name} 需向第一名 ${first.name} 上缴 ${need} 张牌`, 'system');
    this.refreshTimers();
    this.onChange();
  }

  submitHandover(seat, ids) {
    this.ensurePhase('handover');
    if (!this.handover || this.handover.seat !== seat) {
      return { ok: false, error: '当前不需要你上缴牌' };
    }
    if (!Array.isArray(ids) || ids.length !== this.handover.need) {
      return { ok: false, error: `请选择 ${this.handover.need} 张牌` };
    }
    if (new Set(ids).size !== ids.length) return { ok: false, error: '上缴数据异常' };
    const player = this.seats[seat];
    const cards = [];
    for (const id of ids) {
      const card = player.hand.find((c) => c.id === id);
      if (!card) return { ok: false, error: '手牌中没有这张牌' };
      cards.push(card);
    }
    this.handover.chosen = rules.sortHand(cards);
    this.addLog(`${player.name} 完成上缴 ${cards.length} 张`, 'system');
    this.settle(this.handover.seat, this.handover.toSeat);
    return { ok: true };
  }

  autoHandover() {
    if (!this.handover) return;
    const fourth = this.seats[this.handover.seat];
    const cards = fourth.hand.slice(0, this.handover.need);
    this.handover.chosen = rules.sortHand(cards);
    this.addLog(`${fourth.name} 超时，自动上缴 ${cards.length} 张`, 'system');
    this.settle(this.handover.seat, this.handover.toSeat);
  }

  settle(fromSeat, toSeat) {
    if (this.phase === 'settled') return;
    this.clearTimers();
    this.phase = 'settled';
    this.bumpWindow = null;
    this.turnSeat = null;

    const fourth = this.seats.find((s) => s.finishRank === null);
    const fourthSeat = fourth ? fourth.seat : 3;
    const first = this.seats.find((s) => s.finishRank === 1);
    const firstSeat = first ? first.seat : 0;
    this.lastFourthSeat = fourthSeat;
    this.openerSeat = fourthSeat;
    this.dealerSeat = firstSeat;

    // 收牌数口径：末家剩余手牌计入其收牌，上缴的牌由末家转给头家，
    // 四人收牌合计恒为 52，因此本局输赢总和为 0
    const chosen = this.handover && this.handover.chosen ? this.handover.chosen : [];
    const surplus = this.handover ? this.handover.surplus || 0 : 0;
    if (surplus > 0) {
      this.seats[fourthSeat].collected += surplus;
    }
    if (fromSeat != null && toSeat != null && chosen.length > 0) {
      this.seats[fromSeat].collected -= chosen.length;
      this.seats[toSeat].collected += chosen.length;
    }

    const rows = this.seats.map((s) => {
      const scoreDelta = s.collected - 13;
      s.totalScore += scoreDelta;
      return {
        seat: s.seat,
        name: s.name,
        username: s.username,
        finishRank: s.finishRank || 4,
        collected: s.collected,
        scoreDelta,
        totalScore: s.totalScore,
        isBot: s.isBot,
        userId: s.userId
      };
    });
    rows.sort((a, b) => a.finishRank - b.finishRank);

    this.results = {
      round: this.round,
      rows,
      handover: {
        fromSeat,
        toSeat,
        cards: chosen.map((c) => ({ id: c.id, label: c.label, suit: c.suit, symbol: c.symbol, red: c.red }))
      },
      nextDealer: firstSeat,
      nextOpener: fourthSeat
    };

    this.handover = null;
    this.onRoundEnd(this.results, this.seats);
    this.onChange();
  }

  // ---------- 计时器 / 机器人 ----------

  ensurePhase(phase) {
    if (this.phase !== phase) {
      throw new GameError(`当前阶段不能执行该操作（${this.phase}）`);
    }
  }

  startTurnClock() {
    this.turnStartedAt = Date.now();
    this.turnDeadline = Date.now() + TURN_MS;
  }

  clearTimers() {
    for (const key of ['bumpTimer', 'turnTimer', 'handoverTimer', 'dealingTimer']) {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
  }

  refreshTimers() {
    this.clearTimers();
    if (this.phase === 'dealing') {
      const left = Math.max(0, this.dealingDeadline - Date.now());
      this.dealingTimer = setTimeout(() => this.startPlaying(), left + 30);
      return;
    }
    if (this.phase !== 'playing' && this.phase !== 'handover') return;

    if (this.phase === 'playing') {
      if (this.bumpWindow) {
        const left = this.bumpWindow.deadline - Date.now();
        if (left > 0) {
          this.bumpTimer = setTimeout(() => {
            if (this.bumpWindow && Date.now() >= this.bumpWindow.deadline) {
              this.addLog('撞倒计时结束，无人撞，轮到下一家出牌', 'system');
              this.bumpWindow = null;
              if (this.base && this.phase === 'playing') {
                this.turnSeat = this.nextActive(this.base.seat);
                this.startTurnClock();
              }
              this.refreshTimers();
              this.onChange();
            }
          }, left + 30);
        } else {
          this.bumpWindow = null;
        }
      }

      if (this.turnSeat !== null) {
        const turnLeft = Math.max(0, this.turnDeadline - Date.now());
        this.turnTimer = setTimeout(() => {
          if (this.phase === 'playing' && this.turnSeat !== null) {
            this.addLog(`${this.seats[this.turnSeat].name} 超时，系统托管出牌`, 'system');
            this.autoAct(this.turnSeat);
          }
        }, turnLeft + 30);

        const turnPlayer = this.seats[this.turnSeat];
        if (turnPlayer && (turnPlayer.isBot || turnPlayer.auto)) {
          const delay = Math.max(200, this.turnStartedAt + 1000 + (smallHash(String(this.round) + this.turnSeat + this.pile.length) % 900) - Date.now());
          this.botTimers.push(setTimeout(() => this.autoAct(this.turnSeat), delay));
        }
      }

      // 机器人/托管玩家抢撞
      if (this.bumpWindow && this.base && this.base.type === 'single' && this.isBumpWindowOpen()) {
        const windowId = `${this.round}:${this.base.seat}:${this.base.rank}:${this.bumpWindow.deadline}`;
        for (const s of this.seats) {
          if (s.finishRank !== null) continue;
          if (s.seat === this.base.seat) continue;
          if (!(s.isBot || s.auto)) continue;
          if (!rules.canBump(s.hand, this.base)) continue;
          const intent = smallHash(windowId + ':' + s.seat) % 100;
          if (intent >= 55) continue;
          const at = this.bumpWindow.deadline - BUMP_WINDOW_MS + 900 + (smallHash(windowId + s.seat) % 1300);
          const delay = Math.max(150, at - Date.now());
          this.botTimers.push(setTimeout(() => {
            if (this.phase !== 'playing' || !this.isBumpWindowOpen()) return;
            const res = this.bump(s.seat);
            if (!res.ok) {
              this.refreshTimers();
            }
          }, delay));
        }
      }
    }

    if (this.phase === 'handover' && this.handover) {
      const player = this.seats[this.handover.seat];
      const isAuto = player && (player.isBot || player.auto);
      const at = isAuto ? Date.now() + 1600 : this.handover.deadline;
      this.handoverTimer = setTimeout(() => this.autoHandover(), Math.max(0, at - Date.now()) + 30);
    }
  }

  autoAct(seat) {
    if (this.phase !== 'playing' || this.turnSeat !== seat) return;
    const player = this.seats[seat];
    if (!player || player.finishRank !== null) return;

    const legal = rules.enumeratePlays(player.hand, this.base);
    if (legal.length > 0) {
      const pick = legal[0];
      const res = this.play(seat, pick.ids);
      if (!res.ok) {
        // 理论兜底：若首出无法完成，跳过首出限制
        this.addLog(`${player.name} 无法完成首出，顺延`, 'system');
        this.opening = false;
        this.turnSeat = this.nextActive(seat);
        this.startTurnClock();
        this.refreshTimers();
        this.onChange();
      }
      return;
    }

    if (!this.base) {
      this.addLog(`${player.name} 无牌可出，顺延`, 'system');
      this.opening = false;
      this.turnSeat = this.nextActive(seat);
      this.startTurnClock();
      this.refreshTimers();
      this.onChange();
      return;
    }

    const res = this.pass(seat);
    if (!res.ok) {
      this.addLog(`${player.name} 自动出牌失败：${res.error}`, 'system');
    }
  }

  // ---------- 连接状态 ----------

  setConnected(seat, connected) {
    const s = this.seats[seat];
    if (!s) return;
    s.connected = connected;
    if (s.isBot) s.auto = true;
    else s.auto = !connected;
    if (!connected && this.phase === 'playing' && this.turnSeat === seat) {
      this.refreshTimers();
    }
    if (!connected && this.phase === 'handover' && this.handover && this.handover.seat === seat) {
      this.refreshTimers();
    }
    this.onChange();
  }

  // ---------- 状态序列化 ----------

  publicSeats() {
    return this.seats.map((s) => ({
      seat: s.seat,
      userId: s.userId,
      username: s.username,
      name: s.name,
      isBot: s.isBot,
      connected: s.connected,
      auto: s.auto,
      cardCount: s.hand.length,
      collected: s.collected,
      finishRank: s.finishRank,
      totalScore: s.totalScore
    }));
  }

  /** 按点数统计已出牌数（记牌器用） */
  playedCounts() {
    const counts = {};
    for (const c of this.playedCards) {
      counts[c.rank] = (counts[c.rank] || 0) + 1;
    }
    return counts;
  }

  stateFor(viewerSeat) {
    const viewer = this.seats[viewerSeat];
    const isTurn = this.phase === 'playing' && this.turnSeat === viewerSeat;
    let legalPlays = [];
    let canBumpNow = false;
    if (viewer && viewer.finishRank === null && this.phase === 'playing') {
      if (isTurn) {
        legalPlays = rules.enumeratePlays(viewer.hand, this.base);
      }
      canBumpNow = this.isBumpWindowOpen() && this.base.seat !== viewerSeat && rules.canBump(viewer.hand, this.base);
    }

    return {
      roomId: this.room.id,
      roomName: this.room.name,
      phase: this.phase,
      round: this.round,
      dealerSeat: this.dealerSeat,
      turnSeat: this.turnSeat,
      opening: this.opening,
      seats: this.publicSeats(),
      base: this.base
        ? {
            seat: this.base.seat,
            type: this.base.type,
            typeLabel: this.base.typeLabel,
            rank: this.base.rank,
            label: this.base.label,
            cards: this.base.cards
          }
        : null,
      pile: this.pile.map((p) => ({
        seat: p.seat,
        cards: p.cards,
        type: p.type,
        typeLabel: p.typeLabel,
        label: p.label
      })),
      passes: this.passes,
      bump: this.bumpWindow ? { rank: this.bumpWindow.rank, label: this.bumpWindow.label, deadline: this.bumpWindow.deadline } : null,
      playedCounts: this.playedCounts(),
      log: this.log.slice(-40),
      turnDeadline: this.turnDeadline,
      dealingDeadline: this.dealingDeadline,
      handover: this.handover
        ? {
            seat: this.handover.seat,
            toSeat: this.handover.toSeat,
            need: this.handover.need,
            toppedUp: this.handover.toppedUp || 0,
            deadline: this.handover.deadline
          }
        : null,
      results: this.results,
      you: {
        seat: viewerSeat,
        hand: viewer ? viewer.hand : [],
        isTurn,
        legalPlays,
        canBump: canBumpNow,
        mustPlay: isTurn && !!this.base && legalPlays.length > 0,
        canPass: isTurn && !!this.base && legalPlays.length === 0,
        finishRank: viewer ? viewer.finishRank : null
      },
      serverNow: Date.now()
    };
  }
}

class GameError extends Error {}

module.exports = { Game, GameError, BUMP_WINDOW_MS, TURN_MS, HANDOVER_MS };
