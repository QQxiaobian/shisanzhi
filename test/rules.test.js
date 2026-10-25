const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/game/rules');

const deck = rules.createDeck();
const byId = new Map(deck.map((c) => [c.id, c]));
const card = (id) => byId.get(id);

test('标准牌堆：52 张、无王、花色与点数完整', () => {
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => c.id)).size, 52);
  assert.ok(deck.every((c) => c.rank >= 3 && c.rank <= 15));
  assert.equal(deck.filter((c) => c.label === '2').length, 4);
});

test('牌力顺序：2 > A > K > Q > J > 10 > ... > 3', () => {
  assert.ok(rules.rankValue('2') > rules.rankValue('A'));
  assert.ok(rules.rankValue('A') > rules.rankValue('K'));
  assert.ok(rules.rankValue('K') > rules.rankValue('Q'));
  assert.ok(rules.rankValue('10') > rules.rankValue('9'));
  assert.ok(rules.rankValue('3') === 3);
});

test('牌型识别：仅单张/对子/炸弹/千弹', () => {
  assert.equal(rules.analyzeCombo([card('S3')]).type, 'single');
  assert.equal(rules.analyzeCombo([card('S7'), card('H7')]).type, 'pair');
  assert.equal(rules.analyzeCombo([card('S9'), card('H9'), card('C9')]).type, 'bomb');
  assert.equal(rules.analyzeCombo([card('S2'), card('H2'), card('C2'), card('D2')]).type, 'thousand');
  assert.equal(rules.analyzeCombo([card('S3'), card('H4')]), null);
  assert.equal(rules.analyzeCombo([card('S3'), card('H3'), card('C3'), card('D3'), card('S4')]), null);
});

test('压制：普通同型点数严格更大，跨型不可压', () => {
  const single5 = { type: 'single', rank: 5 };
  assert.equal(rules.canBeatCombo(single5, rules.analyzeCombo([card('S6')])), true);
  assert.equal(rules.canBeatCombo(single5, rules.analyzeCombo([card('S5')])), false);
  assert.equal(rules.canBeatCombo(single5, rules.analyzeCombo([card('S7'), card('H7')])), false);
  const pair5 = { type: 'pair', rank: 5 };
  assert.equal(rules.canBeatCombo(pair5, rules.analyzeCombo([card('S6'), card('H6')])), true);
  assert.equal(rules.canBeatCombo(pair5, rules.analyzeCombo([card('S4'), card('H4')])), false);
});

test('炸弹可压单张/对子/撞，千弹压一切，炸弹压不住千弹', () => {
  const bomb10 = rules.analyzeCombo([card('S10'), card('H10'), card('C10')]);
  assert.equal(rules.canBeatCombo({ type: 'single', rank: 15 }, bomb10), true);
  assert.equal(rules.canBeatCombo({ type: 'pair', rank: 15 }, bomb10), true);
  assert.equal(rules.canBeatCombo({ type: 'bump', rank: 15 }, bomb10), true);
  assert.equal(rules.canBeatCombo({ type: 'bomb', rank: 9 }, bomb10), true);
  assert.equal(rules.canBeatCombo({ type: 'bomb', rank: 11 }, bomb10), false);

  const thousand3 = rules.analyzeCombo([card('S3'), card('H3'), card('C3'), card('D3')]);
  assert.equal(rules.canBeatCombo({ type: 'bomb', rank: 15 }, thousand3), true);
  assert.equal(rules.canBeatCombo({ type: 'thousand', rank: 4 }, thousand3), false);
  const thousand2 = rules.analyzeCombo([card('S2'), card('H2'), card('C2'), card('D2')]);
  assert.equal(rules.canBeatCombo(thousand3, thousand2), true);
});

test('撞：仅基准为单张 + 同点对子 + 倒计时内', () => {
  const base = { type: 'single', rank: 7 };
  const pair7 = [card('S7'), card('H7')];
  assert.equal(rules.resolvePlay(base, pair7, true).ok, true);
  assert.equal(rules.resolvePlay(base, pair7, true).combo.type, 'bump');
  assert.equal(rules.resolvePlay(base, pair7, false).ok, false);
  assert.equal(rules.resolvePlay(base, [card('S8'), card('H8')], true).ok, false);
  assert.equal(rules.resolvePlay(base, [card('S7')], true).ok, false); // 同点单张不能压
  assert.equal(rules.resolvePlay({ type: 'single', rank: 6 }, [card('S7')], true).combo.type, 'single');
  assert.equal(rules.resolvePlay({ type: 'pair', rank: 7 }, pair7, true).ok, false); // 同点不能压
});

test('对子基准时同点对子不能撞（没有更大力）', () => {
  const res = rules.resolvePlay({ type: 'pair', rank: 7 }, [card('S7'), card('H7')], true);
  assert.equal(res.ok, false);
});

test('禁止留 2：出牌后剩余全为 2 则非法', () => {
  const hand = [card('S2'), card('H3')];
  assert.equal(rules.leavesOnlyTwos(hand, ['S2']), false); // 剩 3
  assert.equal(rules.leavesOnlyTwos(hand, ['H3']), true); // 剩单 2
  const hand2 = [card('S2'), card('H2'), card('S5')];
  assert.equal(rules.leavesOnlyTwos(hand2, ['S5']), true);
  assert.equal(rules.leavesOnlyTwos(hand2, ['S2', 'H2']), false);
  assert.equal(rules.leavesOnlyTwos([card('S2')], ['S2']), false); // 出完可以
});

test('枚举合法出牌：黑桃3强制首出', () => {
  const hand = [card('S3'), card('H3'), card('S7'), card('H8')];
  const plays = rules.enumeratePlays(hand, null, { opening: true });
  assert.ok(plays.length >= 2);
  for (const p of plays) {
    assert.ok(p.ids.includes('S3'), '每一手都必须包含黑桃3');
    assert.equal(p.rank, 3);
  }
  assert.ok(plays.some((p) => p.type === 'single'));
  assert.ok(plays.some((p) => p.type === 'pair'));
});

test('枚举合法出牌：无解时允许 Pass（空数组）', () => {
  const hand = [card('S7'), card('H7'), card('S8')];
  const base = { type: 'single', rank: 13 }; // K
  const plays = rules.enumeratePlays(hand, base, {});
  assert.equal(plays.length, 0);
});

test('枚举合法出牌：炸弹/千弹都被列为可压', () => {
  const hand = [card('S9'), card('H9'), card('C9'), card('S8'), card('S2'), card('H2'), card('C2'), card('D2')];
  const base = { type: 'single', rank: 7 };
  const plays = rules.enumeratePlays(hand, base, {});
  assert.ok(plays.some((p) => p.type === 'bomb' && p.rank === 9));
  assert.ok(plays.some((p) => p.type === 'thousand' && p.rank === 15));
  assert.ok(plays.some((p) => p.type === 'single' && p.rank === 9), '单张更大可以压');
  assert.ok(!plays.some((p) => p.type === 'pair'), '普通对子不能压单张');
});

test('撞资格：仅同点对子，且撞后不能只剩 2', () => {
  const base = { type: 'single', rank: 7 };
  assert.equal(rules.canBump([card('S7'), card('H7'), card('S8')], base), true);
  assert.equal(rules.canBump([card('S7'), card('S8')], base), false);
  assert.equal(rules.canBump([card('S7'), card('H7')], { type: 'pair', rank: 7 }), false);
  assert.equal(rules.canBump([card('S7'), card('H7'), card('S2'), card('H2'), card('C2'), card('D2')], base), false);
});

test('三家 Pass 判定（考虑已出完玩家）', () => {
  assert.equal(rules.passesNeeded(4, true), 3);
  assert.equal(rules.passesNeeded(3, false), 3);
  assert.equal(rules.passesNeeded(2, true), 1);
});

test('十三烂：13 张点数互不相同（3~2 各一张）', () => {
  const broken = [
    card('S3'), card('H4'), card('C5'), card('D6'),
    card('S7'), card('H8'), card('C9'), card('D10'),
    card('SJ'), card('HQ'), card('CK'), card('DA'), card('S2')
  ];
  assert.equal(broken.length, 13);
  assert.equal(rules.isThirteenBroken(broken), true);

  // 有重复点数则不是十三烂
  const withDup = broken.slice(0, 12).concat([card('H3')]);
  assert.equal(rules.isThirteenBroken(withDup), false);

  // 不足 13 张
  assert.equal(rules.isThirteenBroken(broken.slice(0, 12)), false);
});
