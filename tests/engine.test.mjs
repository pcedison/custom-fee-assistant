// 執行：npm test（或 node tests/engine.test.mjs）
import assert from 'node:assert/strict';
import { localReply, computeQuote, normalize, parseAiReply, buildOrder } from '../public/engine.js';
import { REGIONS, TOPICS, ITEMS } from '../public/kb.js';

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}
const total = q => computeQuote(normalize(q)).total;
const reply = (q, s) => localReply(q, s || {});

console.log('知識庫');
t('所有標示區塊都存在', () => {
  for (const tp of TOPICS) for (const r of tp.regions) assert.ok(REGIONS[r], `${tp.id}:${r}`);
  for (const it of ITEMS) for (const r of it.regions) assert.ok(REGIONS[r], `${it.id}:${r}`);
});

console.log('試算');
t('燕麥奶＋抹茶液＋環保杯 = +25', () => assert.equal(total('燕麥奶＋抹茶液＋環保杯多少？'), 25));
t('去冰補奶 = +15', () => assert.equal(total('去冰補奶要加錢嗎'), 15));
t('加兩份濃縮 = +30（按份計價）', () => assert.equal(total('加兩份濃縮'), 30));
t('8份抹茶仍以 1 份計', () => assert.equal(total('我要8份抹茶'), 15));
t('買一送一不折環保杯', () => assert.equal(total('買一送一 燕麥奶 環保杯'), 20));
t('一般情況環保杯折 10', () => assert.equal(total('燕麥奶 環保杯'), 10));
t('沒帶環保杯不折', () => assert.equal(total('沒帶環保杯 燕麥奶'), 20));
t('飲品名稱不算加料（焦糖瑪奇朵、香草拿鐵）', () => assert.equal(total('焦糖瑪奇朵 香草拿鐵 去冰'), 0));
t('高蛋白雲朵可可＋燕麥奶 = +80', () => assert.equal(total('高蛋白雲朵可可加燕麥奶'), 80));
t('不加糖不收費', () => assert.equal(total('不加糖去冰'), 0));
t('加2份濃縮＋燕麥奶＋環保杯 = +40', () => assert.equal(total('加2份濃縮 燕麥奶 環保杯'), 40));
t('抹茶液加兩份濃縮：份數算給濃縮', () => assert.equal(total('抹茶液加兩份濃縮'), 45));

console.log('問答');
t('環保杯規則', () => assert.match(reply('用環保杯可以折嗎').text, /折 \$10/));
t('實施日期', () => assert.match(reply('什麼時候開始').text, /2026\/10\/12/));
t('抹茶份數', () => assert.match(reply('抹茶液可以加幾份？').text, /限加一份/));
t('不相關問題交給 AI', () => assert.equal(reply('今天天氣如何'), null));
t('飲品原價依官網價格', () => assert.match(reply('大杯拿鐵多少錢').text, /大杯）：\$140/));

console.log('飲品判斷（店長回饋）');
const order = q => buildOrder(normalize(q));
t('蜜柚紅茶不含奶：少冰提示補飲料、不出現補奶類', () => {
  const o = order('蜜柚紅茶少冰1下糖');
  assert.equal(o.drink.n, '冰蜜柚紅茶');
  assert.equal(o.drink.m, 'none');
  assert.ok(o.tips.some(x => /補飲料（補紅茶）/.test(x)));
  assert.ok(!o.lines.some(l => l.id === 'ice_milk'));
  assert.ok(o.lines.some(l => l.id === 'sweet' && l.amount == null));
});
t('醇濃抹茶那堤含奶：去冰加牛奶＝補奶類、抹茶粉＝抹茶液，加價 +30', () => {
  const o = order('純濃抹茶去冰加牛奶加一匙抹茶粉');
  assert.equal(o.drink.n, '冰醇濃抹茶那堤');
  assert.equal(o.addTotal, 30);
  assert.deepEqual(o.sizeTotals.map(x => x.total), [175, 190, 205]);
});
t('冰美式大杯去冰補奶＋環保杯 = $120', () => {
  const o = order('冰美式大杯去冰補奶 環保杯');
  assert.equal(o.basePrice + o.addTotal, 120);
});
t('熱飲去冰不收費也不列項', () => assert.equal(order('熱那堤去冰').lines.length, 0));
t('兩杯一起問 → 分別列出含奶狀態', () => assert.equal(order('拿鐵和美式哪個有奶').kind, 'multi'));
t('摩卡醬是加料，不是摩卡', () => {
  const o = order('冰那堤加摩卡醬');
  assert.equal(o.drink.n, '冰那堤');
  assert.ok(o.lines.some(l => l.id === 'syrup_mocha'));
});
t('冰搖紅茶名稱完整辨識', () => assert.equal(order('冰搖紅茶').drink.n, '冰搖紅茶'));
t('燕麥奶那堤換燕麥奶不加價', () => assert.equal(order('冰特選燕麥奶那堤換燕麥奶').addTotal, 0));
t('接續追問「大杯呢？」沿用上一杯', () => {
  const r = reply('大杯呢？', { lastOrder: '蜜柚紅茶少冰' });
  assert.match(r.text, /合計（大杯）：\$150/);
});

t('飲品試算後按看不懂 → 依那杯解釋並標示', () => {
  const r = reply('看不懂，標給我看', { lastOrder: '醇濃抹茶去冰加牛奶', lastTopics: ['ice'], lastWasQuote: true });
  assert.match(r.text, /有奶的飲品/);
  assert.ok(r.regions.includes('ice_milk'));
});

console.log('看不懂 → 標示圖片');
t('補飲料是什麼意思 → 帶圖', () => {
  const r = reply('補飲料是什麼意思？');
  assert.ok(r.regions.includes('ice_drink'));
});
t('沿用上一題主題', () => {
  const r = reply('看不懂，標給我看', { lastTopics: ['milk'], lastItemRegions: [] });
  assert.ok(r.regions.includes('milk_oat'));
});
t('上一題是試算 → 只標試算項目', () => {
  const r = reply('看不懂', { lastTopics: ['milk', 'matcha'], lastItemRegions: ['milk_oat', 'o_matcha'], lastWasQuote: true });
  assert.deepEqual(r.regions.sort(), ['milk_oat', 'o_matcha']);
});
t('環保杯不在圖上 → 不帶圖', () => {
  const r = reply('環保杯那個看不懂');
  assert.ok(!r.regions && !r.plainImage);
});
t('原圖', () => assert.ok(reply('給我看原圖').plainImage));

console.log('AI 回覆整理');
t('取出 [[HL:...]] 並移除', () => {
  const r = parseAiReply('<think>x</think>去冰補奶 +$15\n[[HL:ice]]');
  assert.equal(r.text, '去冰補奶 +$15');
  assert.ok(r.regions.includes('ice_milk'));
});

console.log(`\n${pass} 項通過`);
