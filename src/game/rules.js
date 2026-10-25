/**
 * 十三支核心规则引擎（无状态纯函数）
 *
 * 牌型：单张 / 对子 / 炸弹(3张) / 千弹(4张)
 * 压制：千弹 > 炸弹 > 撞 > 普通同牌型（点数严格更大）
 * 撞：基准为单张时，用同点数对子发起（仅炸弹、千弹可压）
 */

const RANK_LABELS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = [
  { code: 'S', symbol: '♠', name: '黑桃', red: false },
  { code: 'H', symbol: '♥', name: '红桃', red: true },
  { code: 'C', symbol: '♣', name: '梅花', red: false },
  { code: 'D', symbol: '♦', name: '方块', red: true }
];

const TYPE_LABELS = {
  single: '单张',
  pair: '对子',
  bump: '撞',
  bomb: '炸弹',
  thousand: '千弹'
};

const TYPE_ORDER = { single: 0, pair: 1, bump: 2, bomb: 3, thousand: 4 };

/** 点数标签 -> 牌力值（3最小，2最大） */
function rankValue(label) {
  const idx = RANK_LABELS.indexOf(String(label));
  if (idx < 0) return 0;
  // 3..10 => 3..10, J=11, Q=12, K=13, A=14, 2=15
  if (idx < 8) return idx + 3;
  return idx + 3;
}

function rankLabel(value) {
  return RANK_LABELS[value - 3] || '?';
}

/** 生成标准 52 张牌（无王） */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const label of RANK_LABELS) {
      const v = rankValue(label);
      deck.push({
        id: suit.code + label,
        suit: suit.code,
        symbol: suit.symbol,
        red: suit.red,
        label,
        rank: v
      });
    }
  }
  return deck;
}

/** Fisher-Yates 洗牌 */
function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** 发牌：每人 13 张 */
function deal(deck) {
  const hands = [[], [], [], []];
  deck.forEach((card, i) => hands[i % 4].push(card));
  return hands.map((hand) => sortHand(hand));
}

/** 展示排序：点数从小到大，同点数按花色 */
function sortHand(hand) {
  const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
  return hand.slice().sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return suitOrder[a.suit] - suitOrder[b.suit];
  });
}

/** 识别基础牌型（不含撞的上下文判断） */
function analyzeCombo(cards) {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 4) return null;
  if (cards.some((c) => !c || typeof c.rank !== 'number' || typeof c.id !== 'string')) return null;
  const rank = cards[0].rank;
  if (!cards.every((c) => c.rank === rank)) return null;
  const type = { 1: 'single', 2: 'pair', 3: 'bomb', 4: 'thousand' }[cards.length];
  return { type, rank, label: rankLabel(rank), size: cards.length };
}

/**
 * 普通牌型能否压制基准（不含“撞”这一特殊触发）
 * 千弹 > 炸弹 > 单张/对子（同型比点数）
 */
function canBeatCombo(base, combo) {
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
    return true; // 单张 / 对子 / 撞
  }
  if (t === 'pair') return b === 'pair' && combo.rank > base.rank;
  if (t === 'single') return b === 'single' && combo.rank > base.rank;
  return false;
}

/**
 * 结合桌面基准解析一次出牌
 * @param base 当前基准 {type,rank}
 * @param cards 打出的牌
 * @param bumpOpen 当前是否仍处于撞倒计时内
 * @returns {{ok:boolean, combo?:object, reason?:string}}
 */
function resolvePlay(base, cards, bumpOpen = false) {
  const combo = analyzeCombo(cards);
  if (!combo) return { ok: false, reason: '非法牌型：只允许单张、对子、炸弹、千弹' };

  if (base) {
    const isBump = base.type === 'single' && combo.type === 'pair' && combo.rank === base.rank;
    if (isBump) {
      if (!bumpOpen) return { ok: false, reason: '撞倒计时已结束，不能再撞' };
      return { ok: true, combo: { ...combo, type: 'bump' } };
    }
    if (!canBeatCombo(base, combo)) {
      return { ok: false, reason: `无法压制当前${TYPE_LABELS[base.type] || '牌型'}` };
    }
  }
  return { ok: true, combo };
}

/** 打出这些牌后，剩余手牌是否“只剩 2”（禁止留 2 收尾） */
function leavesOnlyTwos(hand, playIds) {
  const set = new Set(playIds);
  const rest = hand.filter((c) => !set.has(c.id));
  return rest.length > 0 && rest.every((c) => c.rank === 15);
}

function isSubset(hand, cards) {
  const map = new Map(hand.map((c) => [c.id, c]));
  const used = new Set();
  for (const c of cards) {
    if (!c || used.has(c.id) || !map.has(c.id)) return false;
    used.add(c.id);
  }
  return true;
}

function groupByRank(hand) {
  const map = new Map();
  for (const card of hand) {
    if (!map.has(card.rank)) map.set(card.rank, []);
    map.get(card.rank).push(card);
  }
  return map;
}

/**
 * 枚举当前手牌所有合规的普通出牌（不含撞）
 * @param hand 手牌
 * @param base 当前基准（null 表示新一轮首出）
 * @param opts.opening 是否为黑桃3强制首出
 */
function enumeratePlays(hand, base = null, opts = {}) {
  const { opening = false } = opts;
  const groups = groupByRank(hand);
  const result = [];

  for (const [rank, cards] of groups) {
    const maxSize = Math.min(4, cards.length);
    for (let size = 1; size <= maxSize; size++) {
      if (size === 2 && base && base.type === 'single' && base.rank === rank) {
        // 同点对子属于“撞”，不放进普通出牌列表
        continue;
      }
      let chosen = cards.slice(0, size);

      if (opening) {
        if (rank !== 3) continue;
        // 必须包含黑桃3
        const spade3 = hand.find((c) => c.id === 'S3');
        if (!spade3 || !chosen.some((c) => c.id === 'S3')) {
          chosen = [spade3, ...cards.filter((c) => c.id !== 'S3').slice(0, size - 1)];
        }
      }

      const combo = analyzeCombo(chosen);
      if (!combo) continue;
      if (leavesOnlyTwos(hand, chosen.map((c) => c.id))) continue;

      if (base) {
        if (!canBeatCombo(base, combo)) continue;
      } else if (opening && !chosen.some((c) => c.id === 'S3')) {
        continue;
      }

      result.push({
        ids: chosen.map((c) => c.id),
        type: combo.type,
        rank,
        label: combo.label,
        typeLabel: TYPE_LABELS[combo.type]
      });
    }
  }

  result.sort((a, b) => {
    if (TYPE_ORDER[a.type] !== TYPE_ORDER[b.type]) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    return a.rank - b.rank;
  });
  return result;
}

/** 当前手牌是否可以用“撞”压制（基准为单张，且持有同点对子） */
function canBump(hand, base) {
  if (!base || base.type !== 'single') return false;
  const pair = hand.filter((c) => c.rank === base.rank).slice(0, 2);
  if (pair.length < 2) return false;
  if (leavesOnlyTwos(hand, pair.map((c) => c.id))) return false;
  return true;
}

/** 找出用于撞的两张牌 */
function findBumpCards(hand, base) {
  if (!canBump(hand, base)) return null;
  return hand.filter((c) => c.rank === base.rank).slice(0, 2);
}

/** 判断某一墩是否结束：连续三家（或剩余可行动玩家数）Pass */
function passesNeeded(activeSeats, lastPlaySeatHasCards) {
  return Math.max(1, activeSeats - (lastPlaySeatHasCards ? 1 : 0));
}

/**
 * 十三烂：手牌恰好 13 张，且点数 3~2 各一张（无重复）
 */
function isThirteenBroken(hand) {
  if (!Array.isArray(hand) || hand.length !== 13) return false;
  const ranks = new Set();
  for (const c of hand) {
    if (!c || typeof c.rank !== 'number') return false;
    if (ranks.has(c.rank)) return false;
    ranks.add(c.rank);
  }
  return ranks.size === 13;
}

module.exports = {
  RANK_LABELS,
  SUITS,
  TYPE_LABELS,
  TYPE_ORDER,
  rankValue,
  rankLabel,
  createDeck,
  shuffle,
  deal,
  sortHand,
  analyzeCombo,
  canBeatCombo,
  resolvePlay,
  leavesOnlyTwos,
  isSubset,
  enumeratePlays,
  canBump,
  findBumpCards,
  passesNeeded,
  isThirteenBroken
};
