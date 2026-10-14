// 執行：npm test（或 node tests/engine.test.mjs）
import assert from 'node:assert/strict';
import { localReply, computeQuote, normalize, parseAiReply, buildOrder, fixHomophones, bafQuote, singleQuote, ecoCountFrom, fixFacts, isClarify, dietFor, dietProblems, guardDietReply, dietFallback } from '../public/engine.js';
import { DRINKS, DRINK_ALIASES, CANE_FREE, BASE_SYRUP, dietSafe } from '../public/drinks.js';
import { HOMOPHONES } from '../public/homophones.js';
import { buildSystemPrompt, ROUTE_EXAMPLES, ROUTE_NEAR_MISS } from '../public/kb.js';
import { decideRoute, semanticRoute, resetBank, BANK } from '../functions/api/semantic.js';
import { onRequestPost } from '../functions/api/chat.js';
import { onEventPost, parseUA, sourceOf, maskPII } from '../functions/api/stats.js';
import { regionLabel, mergeDrinks, toCSV, netLabel, questionRegion, rangeStart } from '../admin/lib.js';
import { checkAccess } from '../admin/access.js';
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
t('買一送一：每杯加價照收，有加價的杯子帶環保杯照折（店長說明）', () => assert.equal(total('買一送一 燕麥奶 環保杯'), 10));
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
t('蜜柚紅茶不含奶：少冰反問補紅茶、不出現補奶類', () => {
  const o = order('蜜柚紅茶少冰1下糖');
  assert.equal(o.drink.n, '冰蜜柚紅茶');
  assert.equal(o.drink.m, 'none');
  assert.match(o.ask.sub, /補紅茶（補飲料）/);
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
t('兩杯一起問 → 每杯帶自己的杯型，點了就算那一杯', () => {
  const o = order('大杯冷萃和特大杯咖啡星冰樂');
  assert.deepEqual(o.drinks.map(d => d.text), ['大杯冷萃', '特大杯咖啡星冰樂']);
  const o2 = order('冰那堤大杯冰美式中杯');
  assert.deepEqual(o2.drinks.map(d => d.text), ['冰那堤大杯', '冰美式中杯']);
  for (const d of [...o.drinks, ...o2.drinks]) assert.equal(order(d.text).kind, 'drink');
});
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

console.log('店長第二輪回饋');
t('特選馥郁那堤大杯 $170（新制特選 +$15，比官網多 $5）', () => {
  const o = order('特選馥郁那堤大杯去冰');
  assert.equal(o.basePrice, 170);
});
t('只說去冰：不算錢，立刻反問需要補牛奶嗎', () => {
  const r = reply('特選馥郁那堤大杯去冰');
  assert.equal(r.order.addTotal, 0);
  assert.match(r.order.ask.q, /需要補牛奶嗎/);
  assert.deepEqual(r.pending, { add: '補牛奶' });
});
t('回答「要」→ 加上補牛奶 +$15', () => {
  const r = reply('要', { lastOrder: '特選馥郁那堤大杯去冰', pending: { add: '補牛奶' } });
  assert.equal(r.order.basePrice + r.order.addTotal, 185);
});
t('回答「不用補」→ 不加價、不再追問', () => {
  const r = reply('不用補', { lastOrder: '特選馥郁那堤大杯去冰', pending: { add: '補牛奶' } });
  assert.equal(r.order.addTotal, 0);
  assert.equal(r.order.ask, null);
});
t('冷萃去冰：不反問，說明不能補', () => {
  const o = order('香檸蜜柚冷萃咖啡去冰');
  assert.equal(o.ask, null);
  assert.ok(o.tips.some(x => /冷萃類飲品不能補/.test(x)));
});
t('冷萃硬要補 → 標示不能補、不收費', () => {
  const o = order('冷萃去冰補滿');
  const l = o.lines.find(x => x.id === 'ice_drink');
  assert.ok(l.blocked);
  assert.equal(o.addTotal, 0);
});
t('茶類只說少冰 → 反問需要補茶', () => assert.match(order('蜜柚紅茶少冰').ask.q, /補紅茶/));
t('那堤去冰補滿 → 補牛奶', () => assert.ok(order('那堤去冰補滿').lines.some(l => l.id === 'ice_milk' && l.amount === 15)));

console.log('店長第三輪回饋：濃縮咖啡');
t('醇濃抹茶那堤不含濃縮：加特選濃縮＝加濃縮 +15＋特選豆 +15', () => {
  const o = order('醇濃抹茶那堤去冰升級特選濃縮');
  assert.equal(o.lines.find(l => l.id === 'esp_extra').amount, 15);
  assert.equal(o.lines.find(l => l.id === 'esp_upgrade').amount, 15);
  assert.equal(o.addTotal, 30);
});
t('醇濃抹茶那堤加一份一般濃縮 +15', () => assert.equal(order('冰醇濃抹茶那堤加一份濃縮').addTotal, 15));
t('那堤（有濃縮）升級特選 +15', () => assert.equal(order('冰那堤升級特選').addTotal, 15));
t('特選馥郁那堤再升級特選不加價', () => assert.equal(order('特選馥郁那堤升級特選').addTotal, 0));
t('不含濃縮的飲品換低咖啡因 → 不適用', () => assert.equal(order('抹茶那堤換低咖啡因').lines[0].status, '不適用'));
t('要補按鈕的版本：加上補牛奶後多 $15', () => {
  const base = order('醇濃抹茶那堤大杯去冰');
  const yes = buildOrder(normalize('醇濃抹茶那堤大杯去冰' + base.ask.add));
  assert.equal(yes.basePrice + yes.addTotal - (base.basePrice + base.addTotal), 15);
});

t('「升級精選豆」＝特選（不含濃縮的飲品 +30）', () => assert.equal(order('冰醇濃抹茶那堤，升級精選豆').addTotal, 30));
t('看不懂的詞會明講', () => assert.ok(order('冰那堤加珍珠').notes.some(n => /沒看懂：「珍珠」/.test(n))));
t('常見點法不會誤報看不懂', () => {
  for (const q of ['蜜柚紅茶少冰1下糖', '純濃抹茶去冰加牛奶加一匙抹茶粉', '冰美式大杯去冰補奶 環保杯', '特選馥郁那堤大杯去冰',
    '冰那堤換燕麥奶', '焦糖瑪奇朵換成榛果', '我要一杯大杯冰那堤多少錢', '冰醇濃抹茶那堤加兩份特選濃縮', '那堤有奶嗎', '冰那堤正常冰正常甜']) {
    const o = order(q);
    assert.ok(!o.notes.some(n => /沒看懂/.test(n)), `${q} → ${o.notes.join(' / ')}`);
  }
});

console.log('模糊比對飲品名稱（店長第四輪）');
t('「巧克力可可碎片加一份特選濃縮加一下香草糖漿」→ 巧克力可可碎片星冰樂，不是經典巧克力', () => {
  const o = order('巧克力可可碎片加一份特選濃縮加一下香草糖漿');
  assert.equal(o.drink.n, '巧克力可可碎片星冰樂');
  assert.ok(!o.lines.some(l => l.id === 'o_cocoa'), '可可碎片是品名，不是加料');
  assert.equal(o.addTotal, 45);
  assert.ok(o.match.fuzzy && o.match.alts.some(a => a.name === '經典巧克力'));
});
t('點「經典巧克力」改選 → 經典巧克力＋可可碎片加料', () => {
  const o0 = order('巧克力可可碎片加一份特選濃縮加一下香草糖漿');
  const o = order(o0.match.alts.find(a => a.name === '經典巧克力').text);
  assert.equal(o.summary.name.replace(/（.*$/, ''), '經典巧克力');
  assert.ok(o.lines.some(l => l.id === 'o_cocoa'));
});
t('錯字：焦糖馬奇朵 → 焦糖瑪奇朵', () => assert.match(order('焦糖馬奇朵').summary.name, /^焦糖瑪奇朵/));
t('漏字：巧克力碎片星冰樂、摩卡碎片星冰樂', () => {
  assert.equal(order('巧克力碎片星冰樂').drink.n, '巧克力可可碎片星冰樂');
  assert.equal(order('摩卡碎片星冰樂').drink.n, '摩卡可可碎片星冰樂');
});
t('一樣像 → 列出選項：可可碎片星冰樂', () => {
  const o = order('可可碎片星冰樂');
  assert.equal(o.kind, 'choose');
  assert.equal(o.options.length, 3);
});
t('加料詞不會被當成飲品', () => {
  assert.equal(order('冰那堤加可可碎片').drink.n, '冰那堤');
  assert.equal(order('可可碎片要加錢嗎'), null);
  assert.equal(order('高蛋白雲朵是什麼'), null);
  assert.equal(order('抹茶要加錢嗎'), null);
});
t('飲品名裡的口味不會被當加料：我要焦糖瑪奇朵', () => assert.equal(order('我要焦糖瑪奇朵').lines.length, 0));
t('常見別稱：冰黑糖拿鐵、桂花拿鐵', () => {
  assert.equal(order('冰黑糖拿鐵').drink.n, '冰黑糖風味奶香咖啡');
  assert.match(order('桂花拿鐵').summary.name, /^米香桂花那堤/);
});

console.log('模糊搜尋：只打部分名稱');
t('「巧克力」→ 自動選經典巧克力，並提供「不是這杯？」巧克力可可碎片星冰樂', () => {
  const o = order('巧克力');
  assert.match(o.summary.name, /^經典巧克力/);
  assert.ok(o.match.fuzzy);
  assert.ok(o.match.alts.some(a => a.name === '巧克力可可碎片星冰樂'));
});
t('「可可」→ 列出名稱含可可的飲品', () => {
  const o = order('可可');
  assert.equal(o.kind, 'choose');
  assert.ok(o.options.length >= 4);
  assert.ok(o.options.some(x => /^可可瑪奇朵/.test(x.name)));
  assert.ok(o.options.some(x => x.name === '巧克力可可碎片星冰樂'));
});
t('「蛋白雲朵那堤」→ 香草、可可兩款讓人選', () => assert.equal(order('蛋白雲朵那堤').options.length, 2));
t('「美式」→ 美式咖啡，並提供其他名稱有美式的飲品', () => {
  const o = order('美式');
  assert.match(o.summary.name, /^美式咖啡/);
  assert.ok(o.match.alts.some(a => /雲朵泡泡美式/.test(a.name)));
});
t('點候選後不會又跳回原本那杯', () => {
  for (const q of ['巧克力', '美式', '冷萃', '奶茶', '巧克力可可碎片加一份特選濃縮加一下香草糖漿']) {
    for (const a of order(q).match.alts) {
      const o = order(a.text);
      assert.ok(o && o.kind === 'drink' && o.summary.name.replace(/（.*$/, '') === a.name, `${q} → ${a.name} 得到 ${o && o.summary?.name}`);
    }
  }
});
t('「星冰樂」→ 列出全部星冰樂', () => assert.ok(order('星冰樂').options.length >= 8));
t('打完整品名不出現候選', () => {
  assert.equal(order('經典巧克力').match.fuzzy, false);
  assert.equal(order('冰那堤').match.fuzzy, false);
});
t('「冰美式」「熱美式」：常用簡稱加冷熱 → 不列候選', () => {
  assert.equal(order('冰美式特大杯去冰補美式').match.fuzzy, false);
  assert.equal(order('熱美式大杯').match.fuzzy, false);
});
t('「補美式」是補飲料，不會被當成第二杯', () => {
  const o = order('冰美式去冰補美式');
  assert.equal(o.kind, 'drink');
  assert.ok(o.lines.some(l => l.id === 'ice_drink' && l.amount === 15));
});
t('BAF、環保杯的說法不會變成「看不懂」', () => {
  const o = order('兩杯冰美式特大杯去冰補美式都用環保杯 用BAF券');
  assert.ok(!o.notes.some(n => /沒看懂/.test(n)), o.notes.join('/'));
});
t('收費問題不會被當成搜尋', () => {
  assert.equal(order('可可碎片要加錢嗎'), null);
  assert.equal(order('咖啡要加錢嗎'), null);
});

console.log('AI 回覆的價格校正');
t('AI 寫錯價格（冰美式 $105）→ 拿掉，改附官網價格卡片', () => {
  const raw = '- 這邊有幾杯不含奶的選擇：\n1. **冰美式咖啡 中杯**\n- 簡單清爽\n- **價格：中杯 $105**\n2. **冰搖紅茶 中杯**\n- 價格：中杯 $105\n補牛奶 +$15 也可以';
  const p = parseAiReply(raw);
  assert.ok(!/\$105/.test(p.text), p.text);
  assert.match(p.text, /\+\$15/);
  assert.deepEqual(p.drinks.map(d => d.name), ['冰美式咖啡', '冰搖紅茶']);
  assert.match(p.drinks[0].prices, /中杯 \$100/);
});
t('AI 用 [[DRINKS:…]] 指定飲品', () => {
  const p = parseAiReply('冷萃比較順口。\n[[DRINKS:冷萃咖啡,冰美式咖啡]]');
  assert.equal(p.text, '冷萃比較順口。');
  assert.deepEqual(p.drinks.map(d => d.name), ['冷萃咖啡', '冰美式咖啡']);
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

console.log('不含奶／過敏推薦');
const u = q => [{ role: 'user', content: q }];
t('辨識推薦題', () => {
  assert.deepEqual(dietFor(u('推薦我一杯不含奶的飲料')), { diet: 'nomilk', recommend: true, inherited: false });
  assert.deepEqual(dietFor(u('我對牛奶過敏可以喝什麼')), { diet: 'allergy', recommend: true, inherited: false });
  assert.deepEqual(dietFor(u('有沒有不含奶的')), { diet: 'nomilk', recommend: true, inherited: false });
});
t('不是推薦題：問某杯有沒有奶、去冰不補奶、不要奶泡', () => {
  for (const q of ['冰美式有沒有奶', '去冰不補奶', '冰那堤不要奶泡', '冷萃跟美式差在哪']) assert.equal(dietFor(u(q)).diet, null, q);
  assert.equal(dietFor(u('乳糖不耐冰那堤換燕麥奶多少')).recommend, false);
});
t('短追問沿用上一句的需求', () => {
  const r = dietFor([...u('我對牛奶過敏可以喝什麼'), { role: 'assistant', content: 'x' }, ...u('那熱的呢')]);
  assert.deepEqual(r, { diet: 'allergy', recommend: true, inherited: true });
});
t('新問題不沿用上一句的過敏需求', () => {
  const r = dietFor([...u('我對牛奶過敏可以喝什麼'), { role: 'assistant', content: 'x' }, ...u('冷萃跟美式差在哪')]);
  assert.equal(r.diet, null);
});
t('AI 推薦含奶飲品、自創無奶版本 → 換成固定答案', () => {
  const p = parseAiReply('推薦你：\n- 冰美式咖啡：清爽\n- 冰摩卡（無奶）：濃縮咖啡＋摩卡醬\n- 冰那堤：可以要求不加奶\n[[DRINKS:冰美式咖啡,冰摩卡,冰那堤]]');
  const g = guardDietReply('allergy', p);
  assert.equal(g.status, 'replaced');
  assert.equal(g.refs[0].text, '冰美式咖啡');
  assert.ok(g.refs.length > 1 && g.refs.every(r => r.dairyFree));
  assert.ok(!/冰摩卡|冰那堤|要求不加奶/.test(g.text));
});
t('只說「可以要求不加奶」也算錯', () => assert.equal(dietProblems('如果想喝那堤，可以請夥伴不加奶').length, 1));
t('經典特調冷萃（奶油）對過敏不算不含奶', () => assert.equal(dietProblems('- 經典特調冷萃咖啡：冷萃加香草甜奶油').length, 1));
t('正確的回答保留，提醒句不算錯', () => {
  const ok = '不含奶的可以選：\n- 冷萃咖啡：冷水長時間浸泡，沒有加牛奶\n- 冰搖檸檬紅茶：酸甜\n- 雙果果汁星冰樂：果汁冰沙\n名字有那堤、摩卡的都含奶，請避開。\n不要把含奶的飲品改成不加奶來點。\n椰奶款星沁爽有椰奶。';
  assert.deepEqual(dietProblems(ok), []);
  const g = guardDietReply('nomilk', parseAiReply(ok + '\n[[DRINKS:冷萃咖啡,冰搖檸檬紅茶]]'));
  assert.equal(g.status, 'ok');
  assert.deepEqual(g.refs.map(r => r.text), ['冷萃咖啡', '冰搖檸檬紅茶']);
});
t('只有一兩行含奶 → 拿掉那幾行（含編號項目底下的說明），其餘保留', () => {
  const raw = '對牛奶過敏的話，熱飲可以選：\n1. **美式咖啡**\n- 濃縮咖啡加熱水\n2. **經典紅茶那堤**\n- 口感溫和\n3. **英式紅茶**\n- 清爽\n[[DRINKS:美式咖啡,經典紅茶那堤,英式紅茶]]';
  const g = guardDietReply('allergy', parseAiReply(raw));
  assert.equal(g.status, 'repaired');
  assert.ok(!/紅茶那堤|口感溫和/.test(g.text));
  assert.ok(/美式咖啡/.test(g.text) && /英式紅茶/.test(g.text) && /清爽/.test(g.text));
  assert.ok(g.text.includes('請不要用「不加奶」的方式點'));
  assert.deepEqual(g.refs.map(r => r.text), ['美式咖啡', '英式紅茶']);
});
t('「對牛奶過敏」是在說需求，不算含奶', () => assert.deepEqual(dietProblems('對牛奶過敏的話，可以選這幾杯：\n- 冷萃咖啡'), []));
t('固定答案只列不含奶的飲品', () => {
  const fb = dietFallback('allergy');
  assert.ok(fb.refs.length && fb.refs.every(r => r.dairyFree));
  for (const d of DRINKS.filter(d => !dietSafe(d))) assert.ok(!fb.text.split('\n').slice(1, 5).join('').includes(d.n), d.n);
});
t('AI 提示：推薦題只給不含奶的飲品資料', () => {
  const sp = buildSystemPrompt({ diet: 'allergy' });
  const okPart = sp.slice(sp.indexOf('｜價格）：'), sp.indexOf('含奶或有乳製品（不能推薦）'));
  assert.ok(okPart.includes('冰美式咖啡｜不含奶'));
  assert.ok(!/｜含奶|有奶油|有冰淇淋|雲朵泡泡/.test(okPart));
  assert.ok(buildSystemPrompt().includes('冷萃咖啡：用冷水長時間浸泡咖啡粉萃取，不是用濃縮咖啡做的'));
});

console.log('AI 飲品知識校正');
t('「冷萃和美式都用濃縮咖啡」整句拿掉並補正確說法', () => {
  const r = parseAiReply('差別：\n- 冷萃和美式都是用濃縮咖啡做基底，但冷萃是冷泡的。\n- 冰美式是用熱水沖泡濃縮咖啡後加冰。\n冷萃不能補，但可以加一份濃縮 +$15。');
  assert.ok(!/都是用濃縮|熱水沖泡/.test(r.text));
  assert.ok(r.text.includes('不是用濃縮咖啡做的'));
  assert.ok(r.text.includes('加一份濃縮 +$15'));
  assert.ok(!/\n\s*\n/.test(r.text));
});
t('「熱美式加熱水，冰美式加冷水和冰塊」是對的，不拿掉', () => {
  const ok = '美式咖啡是濃縮咖啡加水（熱美式加熱水，冰美式加冷水和冰塊）。';
  assert.equal(fixFacts(ok), ok);
});
t('正確的說法不動', () => {
  const ok = '冷萃咖啡是用冷水浸泡萃取，不是濃縮咖啡。美式是濃縮咖啡加水。冷萃也可以升級特選，加濃縮 +$15。';
  assert.equal(fixFacts(ok), ok);
});

console.log('店內菜單（2026/10/12）');
import { readFileSync } from 'node:fs';
const MENU = readFileSync(new URL('../data/menu-2026-10-12.csv', import.meta.url), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map(line => {
  const out = []; let cur = '', q = false;
  for (const c of line) { if (c === '"') { q = !q; continue; } if (c === ',' && !q) { out.push(cur); cur = ''; continue; } cur += c; }
  out.push(cur);
  return { name: out[4], marker: out[3], p: [out[8], out[9], out[10]].map(x => (x ? Number(x) : null)), other: out[11], notes: out[12], map: out[13].split('、') };
});
t('菜單 57 列都對應到飲品資料，價格一致', () => {
  assert.equal(MENU.length, 57);
  for (const r of MENU) for (const n of r.map) {
    const d = DRINKS.find(x => x.n === n);
    assert.ok(d, `找不到 ${n}`);
    if (d.sz) assert.equal(d.sz.map(([l, p]) => `${l} ${p}`).join('; '), r.other, n);
    else assert.deepEqual(d.p.slice(1), r.p, `${n}（菜單：${r.name}）`);
  }
});
t('菜單標示 → 資料旗標（不提供客製化、不提供冰塊客製化、●、○）', () => {
  for (const r of MENU) for (const n of r.map) {
    const d = DRINKS.find(x => x.n === n);
    assert.equal(!!d.nocustom, /不提供客製化服務/.test(r.notes), `nocustom ${n}`);
    assert.equal(!!d.noicecustom, /不提供冰塊客製化/.test(r.notes), `noicecustom ${n}`);
    const isFruitTea = /果茶$/.test(n);
    if (!/（紅茶\/○果茶）/.test(r.name)) assert.equal(!!d.sweetAdj, r.marker.includes('•'), `sweetAdj ${n}`);
    if (!/^冰搖(檸檬)?(紅|果)茶$/.test(n)) assert.equal(!!d.decaf, r.marker.includes('○'), `decaf ${n}`);
    else assert.equal(!!d.decaf, isFruitTea, `decaf ${n}`);
  }
});
t('特選蜜柚雲朵泡泡美式咖啡：依菜單 145／160／175', () => assert.deepEqual(DRINKS.find(d => d.id === 1000).p, [null, 145, 160, 175]));
t('不提供客製化的飲品：去冰、補飲料都不算錢並標示不提供', () => {
  const o = order('草莓巴西莓椰奶星沁爽去冰補飲料');
  assert.equal(o.addTotal, 0);
  assert.ok(o.lines.every(l => l.status === '不提供'));
  assert.ok(!o.ask);
});
t('不提供冰塊客製化：星冰樂去冰不行，加鮮奶油照算', () => {
  assert.equal(order('焦糖星冰樂去冰').lines[0].status, '不提供');
  assert.equal(order('焦糖星冰樂加鮮奶油').addTotal, 15);
});
t('「加鮮奶油」不會被當成加牛奶', () => assert.deepEqual(order('冰那堤加鮮奶油').lines.map(l => l.id), ['o_cream']));
t('冰搖茶／冰搖檸檬茶 → 列出紅茶、果茶讓人選', () => {
  assert.equal(buildOrder('冰搖茶').kind, 'choose');
  assert.deepEqual(buildOrder('冰搖茶').options.map(o => o.text), ['冰搖紅茶', '冰搖果茶']);
  assert.equal(buildOrder('冰搖檸檬茶大杯').options.length, 2);
});
t('菜單沒寫含奶的飲品：不說不含奶、不推薦給過敏', () => {
  const o = order('冰西印度櫻桃紅茶少冰');
  assert.ok(!/不含奶/.test([...o.notes, ...o.tips].join('')));
  assert.ok(!dietSafe(DRINKS.find(d => d.n === '冰搖果茶')));
});
t('可調整甜度（●）與沒標示的飲品說明不同', () => {
  assert.ok(/可調整甜度/.test(order('冰醇濃抹茶那堤半糖').notes.join('')));
  assert.ok(/沒有在這杯標示/.test(order('冰福吉茶那堤半糖').notes.join('')));
});
t('濃縮咖啡選擇的說明附上單點價格 Solo／Doppio', () => assert.ok(/Solo \*\*\$85\*\*/.test(reply('濃縮咖啡選擇').text)));
console.log('單點濃縮咖啡（店長 2026/10/14）');
t('沒有其他飲品時，「濃縮咖啡」是品名：Solo $85／Doppio $100', () => {
  for (const q of ['濃縮咖啡', '濃縮咖啡多少錢', '一杯濃縮', 'espresso', 'doppio', 'solo']) {
    const o = order(q);
    assert.equal(o?.kind, 'drink', q);
    assert.equal(o.drink.n, '濃縮咖啡', q);
    assert.deepEqual(o.sizeTotals.map(x => [x.label, x.total]), [['Solo', 85], ['Doppio', 100]], q);
  }
  assert.equal(order('doppio').sizeLabel, 'Doppio');
  assert.equal(order('兩份濃縮').sizeLabel, 'Doppio');
});
t('Solo＋加一份濃縮＝Doppio $100；加兩份＝$115', () => {
  const o = order('濃縮咖啡加一份濃縮');
  assert.deepEqual([o.sizeLabel, o.basePrice + o.addTotal], ['Doppio', 100]);
  const o2 = order('濃縮咖啡加兩份濃縮');
  assert.equal(o2.sizeTotals.find(x => x.label === 'Solo').total, 115);
});
t('「加一份濃縮」是加料：沒有飲品時回答收費說明；有飲品時算進那一杯', () => {
  for (const q of ['加一份濃縮', '加一份濃縮多少錢', '多加兩份濃縮多少？', '濃縮咖啡要加錢嗎', '升級特選濃縮咖啡多少']) {
    const r = reply(q);
    assert.ok(!r.order && r.topics.includes('espresso'), q);
  }
  assert.equal(order('冰那堤加一份濃縮').drink.n, '冰那堤');
  assert.equal(order('冰那堤換低咖啡因濃縮咖啡').drink.n, '冰那堤');
});
t('新主題：提袋、無咖啡因、過敏原、季節限定', () => {
  assert.ok(/\$2／個/.test(reply('提袋要錢嗎').text));
  assert.ok(/星沁爽含咖啡因/.test(reply('哪些飲料沒有咖啡因').text));
  assert.ok(/花生/.test(reply('有哪些過敏原').text));
  assert.ok(/2026\/10\/12–2026\/11\/2/.test(reply('有哪些季節限定').text));
});

console.log('買一送一券（BAF）');
const baf = (a, b, e) => bafQuote(order(a), order(b), e);
t('兩杯冰那堤大杯換燕麥奶：付費 $160＋送 $20＝$180（燕麥奶兩杯各 +$20）', () => {
  const r = baf('冰那堤大杯換燕麥奶', '冰那堤大杯換燕麥奶').rows[0];
  assert.deepEqual(r.cups.map(c => c.pay), [160, 20]);
  assert.equal(r.total, 180);
});
t('2 個環保杯、送的那杯沒加價：付費杯折 $10，送的 $0 不再折', () => {
  const r = baf('冰那堤大杯', '冰那堤大杯', { eco: 2 }).rows[0];
  assert.deepEqual(r.cups.map(c => c.pay), [130, 0]);
});
t('2 個環保杯、送的那杯有加價：兩杯都折 $10', () => {
  const r = baf('冰那堤大杯去冰補奶', '冰那堤大杯去冰補奶', { eco: 2 }).rows[0];
  assert.deepEqual(r.cups.map(c => c.pay), [145, 5]);
  assert.equal(r.total, 150);
});
t('1 個環保杯：折在付費那杯', () => {
  const r = baf('冰那堤大杯去冰補奶', '冰那堤大杯去冰補奶', { eco: 1 }).rows[0];
  assert.deepEqual(r.cups.map(c => c.pay), [145, 15]);
});
t('單杯：環保杯 1 個折 $10、0 個不折', () => {
  assert.equal(singleQuote(order('冰那堤大杯換燕麥奶'), { eco: 1 }).find(x => x.label === '大杯').total, 150);
  assert.equal(singleQuote(order('冰那堤大杯換燕麥奶'), { eco: 0 }).find(x => x.label === '大杯').total, 160);
});
t('從文字讀環保杯數量', () => {
  assert.equal(ecoCountFrom('冰那堤 環保杯'), 1);
  assert.equal(ecoCountFrom('兩杯都用環保杯'), 2);
  assert.equal(ecoCountFrom('2個環保杯'), 2);
  assert.equal(ecoCountFrom('沒帶環保杯'), 0);
  assert.equal(ecoCountFrom('冰那堤'), 0);
});
t('兩杯冷熱不一致、大小不一致 → 不能用', () => {
  assert.match(baf('冰那堤', '熱那堤').error, /冷熱一致/);
  assert.match(baf('冰那堤大杯', '冰美式中杯').error, /大小要一致/);
});
t('兩杯不同：送價格較低的那杯', () => {
  const r = baf('冰那堤大杯', '冰美式大杯').rows[0];
  assert.equal(r.cups.find(c => c.role === '送').name, '冰美式咖啡');
  assert.equal(r.total, 140);
});
t('沒說杯型：列出每個杯型的合計', () => assert.deepEqual(baf('冰那堤', '冰那堤').rows.map(r => r.label), ['中杯', '大杯', '特大杯']));
t('「用BAF券」沿用上一杯並打開買一送一試算', () => {
  const r = reply('用BAF券', { lastOrder: '冰那堤大杯換燕麥奶' });
  assert.ok(r.order.baf && r.order.drink.n === '冰那堤');
  assert.ok(reply('冰那堤大杯 買一送一').order.baf);
});
t('買一送一問答：寫出環保杯鐵律（每一杯用環保杯就折 $10）', () => assert.match(reply('買一送一券怎麼算').text, /每一杯用環保杯就折 \$10/));

t('「哪些飲料有牛奶？」是問含奶清單，不是「熱牛奶」這杯', () => {
  for (const q of ['哪些飲料有牛奶？', '有牛奶的飲料有哪些', '哪些不含牛奶']) {
    const r = reply(q);
    assert.notEqual(r?.order?.kind, 'drink', q);
  }
  assert.equal(order('熱牛奶大杯').drink.n, '熱牛奶');
});

console.log('加蔗糖免費（店長 2026/10/14）');
t('店長截圖那一句：冰醇濃抹茶那堤大杯，蔗糖不收費，合計 $190', () => {
  const o = reply('純濃抹茶那堤 少冰補滿 兩下蔗糖加香草糖漿 風味換低脂牛奶 大杯').order;
  assert.equal(o.drink.n, '冰醇濃抹茶那堤');
  assert.equal(o.lines.find(l => l.id === 'syrup_cane').amount, 0);
  assert.equal(o.lines.find(l => l.id === 'syrup_vanilla').amount, 15);
  assert.equal(o.basePrice + o.addTotal, 190);
  assert.ok(!o.notes.some(n => /沒看懂/.test(n)), o.notes.join('/'));
});
t('圈選的飲品加蔗糖 $0；沒圈選的照收 $15', () => {
  for (const q of ['焦糖瑪奇朵加蔗糖', '冰搖紅茶加蔗糖', '米香桂花那堤加蔗糖', '夏日冰柚冷萃咖啡加蔗糖', '伯爵茶那堤加糖', '西印度櫻桃紅茶加蔗糖']) {
    assert.equal(order(q).lines.find(l => l.id === 'syrup_cane').amount, 0, q);
  }
  for (const q of ['冰那堤加蔗糖', '摩卡加蔗糖', '福吉茶那堤加蔗糖', '冷萃咖啡加蔗糖']) {
    assert.equal(order(q).lines.find(l => l.id === 'syrup_cane').amount, 15, q);
  }
  assert.equal(order('焦糖瑪奇朵加榛果糖漿').lines.find(l => l.id === 'syrup_hazel').amount, 15);
});
t('蔗糖清單、基底糖漿清單的品名都對得到菜單', () => {
  const bases = new Set(DRINKS.map(d => d.n.replace(/^熱/, '').replace(/^冰(?!搖)/, '')));
  assert.deepEqual(CANE_FREE.filter(n => !bases.has(n)), []);
  assert.deepEqual(Object.keys(BASE_SYRUP).filter(n => !bases.has(n)), []);
});
t('沒有免費更換糖漿：換成別的風味＝加 +$15', () => {
  assert.equal(order('冰那堤換成香草糖漿').lines.find(l => l.id === 'syrup_vanilla').amount, 15);
  const o = order('焦糖瑪奇朵換鹹焦糖');
  assert.equal(o.lines.find(l => l.id === 'syrup_saltcar').amount, 15);
  assert.ok(o.notes.some(n => /香草基底最少要 1 下/.test(n)));
});
t('基底糖漿最少 1 下：「不要香草」不會變成加香草', () => {
  for (const q of ['焦糖瑪奇朵不要香草', '焦糖瑪奇朵去掉香草糖漿', '伯爵茶那堤香草不要']) {
    const o = order(q);
    assert.ok(!o.lines.some(l => l.id === 'syrup_vanilla'), q);
    assert.equal(o.lines.find(l => l.id === 'base_rm')?.status, '最少 1 下', q);
  }
});
t('原本的基底再多加：不另收費（店長 2026/10/14）', () => {
  for (const q of ['焦糖瑪奇朵加香草糖漿', '焦糖瑪奇朵香草多一下', '焦糖星冰樂多加焦糖', '香草風味星冰樂加香草']) {
    const o = order(q);
    const l = o.lines.find(x => x.id.startsWith('syrup_'));
    assert.deepEqual([l.amount, l.status], [0, '免費'], q);
  }
  assert.equal(order('焦糖瑪奇朵加榛果').lines.find(l => l.id === 'syrup_hazel').amount, 15);
});
t('「甜一點」「加糖漿」：原配方有的糖漿多加免費；都沒有才 +$15', () => {
  const amt = q => order(q).lines.filter(l => l.id.startsWith('syrup_')).map(l => l.amount);
  assert.deepEqual(amt('冰搖紅茶甜一點'), [0]);
  assert.deepEqual(amt('焦糖星冰樂再甜一點'), [0]);
  assert.deepEqual(amt('冰那堤甜一點'), [15]);
  assert.deepEqual(amt('冰搖紅茶加糖漿'), [0]);
  assert.deepEqual(amt('冰那堤加糖漿'), [15]);
  assert.ok(!order('冰那堤甜一點').notes.some(n => /沒看懂/.test(n)));
  assert.equal(order('焦糖瑪奇朵少甜一點').lines.find(l => l.id === 'sweet').status, '可減量');
});
t('甜度只調蔗糖：有基底糖漿的飲品說無糖，提醒最少 1 下；沒有基底的不提醒', () => {
  assert.ok(order('伯爵茶那堤無糖').notes.some(n => /做不到完全無糖/.test(n)));
  assert.ok(!order('冰搖紅茶無糖').notes.some(n => /基底/.test(n)));
});

console.log('同音錯字');
t('「特大杯冷翠，再加一份濃縮」→ 冷萃咖啡特大杯＋加一份濃縮', () => {
  const r = reply('我要一杯特大杯冷翠，再加一份濃縮');
  assert.equal(r.order?.kind, 'drink');
  assert.equal(r.order.drink.n, '冷萃咖啡');
  assert.equal(r.order.sizeLabel, '特大杯');
  assert.ok(r.order.lines.some(l => /濃縮/.test(l.label) && l.amount === 15));
  assert.deepEqual(r.typos, [{ from: '冷翠', to: '冷萃' }]);
});
t('常見同音錯字都改得回來', () => {
  const cases = { 焦糖馬奇朵: '焦糖瑪奇朵', 冰那堤換雁麥奶: '冰那堤換燕麥奶', 冰那堤加農縮: '冰那堤加濃縮', 冰的星兵樂: '冰的星冰樂', 香草那題: '香草那堤', 環報杯可以折嗎: '環保杯可以折嗎', 加一下香草糖將: '加一下香草糖漿' };
  for (const [q, want] of Object.entries(cases)) assert.equal(fixHomophones(q).text, want, q);
});
t('寫對的字、常用詞不亂改', () => {
  for (const q of ['冰美式少冰補美式', '美式和那堤差在哪', '我乳糖不耐可以喝什麼', '沒事', '教堂', '可以加奶嗎', '我很不滿意', '這糖漿要加錢嗎', '卡布奇諾', '冰搖紅茶', '大杯冰那堤', '環保杯可以折幾元']) {
    assert.deepEqual(fixHomophones(normalize(q)).fixes, [], q);
  }
});
t('同音字表涵蓋所有品名、別稱、加料用字（新品有新字時要重跑 build-homophones）', () => {
  const have = new Set(Object.values(HOMOPHONES).join(''));
  const names = [...DRINKS.map(d => d.n), ...Object.entries(DRINK_ALIASES).flat(2), ...ITEMS.flatMap(it => (it.names || []).map(n => (typeof n === 'string' ? n : n.n)))];
  const miss = [...new Set(names.join('').match(/\p{Script=Han}/gu))].filter(c => !have.has(c));
  assert.deepEqual(miss, []);
});

console.log('使用統計');
t('裝置、作業系統、瀏覽器', () => {
  assert.deepEqual(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.8.0'), { os: 'iOS', device: 'mobile', browser: 'LINE' });
  assert.deepEqual(parseUA('Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'), { os: 'Android', device: 'mobile', browser: 'Chrome' });
  assert.equal(parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 5).device, 'tablet');
  assert.equal(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0').browser, 'Edge');
});
t('開啟來源', () => {
  assert.equal(sourceOf({ ref: 'https://www.google.com/', browser: 'Chrome' }), 'Google');
  assert.equal(sourceOf({ ref: '', browser: 'LINE' }), 'LINE');
  assert.equal(sourceOf({ ref: 'https://l.facebook.com/l.php', browser: 'Safari' }), 'Facebook');
  assert.equal(sourceOf({ ref: 'https://a.workers.dev/', host: 'a.workers.dev' }), '直接開啟');
  assert.equal(sourceOf({ utm: 'Store_QR' }), 'utm:store_qr');
});
t('原句遮掉個人資料，價格和品名照留', () => {
  assert.equal(maskPII('我的電話是0912-345-678，冰那堤大杯$140'), '我的電話是［已遮蔽］，冰那堤大杯$140');
  assert.equal(maskPII('寄到 a.b@gmail.com 身分證A123456789'), '寄到 ［已遮蔽］ 身分證［已遮蔽］');
  assert.equal(maskPII('卡號 4111 1111 1111 1111'), '卡號 ［已遮蔽］');
  assert.equal(maskPII('兩杯冰美式特大杯去冰補美式'), '兩杯冰美式特大杯去冰補美式');
});
t('後台：縣市、網路業者、飲品合併、CSV', () => {
  assert.equal(regionLabel({ country: 'TW', region_code: 'NWT', region: 'New Taipei' }), '新北市');
  assert.equal(regionLabel({ country: 'TW', region_code: null, region: 'Taichung City' }), '台中市');
  assert.equal(regionLabel({ country: 'JP', region_code: '13', region: 'Tokyo' }), '海外：JP Tokyo');
  assert.equal(questionRegion('TPE'), '台北市');
  assert.equal(netLabel('Chunghwa Telecom Co., Ltd.'), '中華電信');
  const m = mergeDrinks([{ name: '冰那堤', n: 5 }, { name: '那堤', n: 2 }, { name: '冰搖紅茶', n: 3 }, { name: '熱美式咖啡', n: 1 }]);
  assert.deepEqual(m.map(x => [x.name, x.n]), [['那堤', 7], ['冰搖紅茶', 3], ['美式咖啡', 1]]);
  assert.equal(toCSV(['a'], [['=1+1'], ['x,"y"']]), '﻿a\r\n\'=1+1\r\n"x,""y"""\r\n');
  assert.equal(rangeStart('today', Date.parse('2026-10-14T17:00:00Z')), '2026-10-15');
  assert.equal(rangeStart('7', Date.parse('2026-10-14T03:00:00Z')), '2026-10-08');
});
// 假的 D1：記錄寫入內容
function fakeD1() {
  const rows = { salts: [], visits: [], questions: [] };
  const stmt = sql => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async first() { return /FROM salts/.test(sql) ? (rows.salts.find(r => r.day === this.args[0]) || null) : null; },
    async run() {
      if (/INSERT OR IGNORE INTO salts/.test(sql)) rows.salts.push({ day: this.args[0], salt: this.args[1] });
      if (/INSERT INTO visits/.test(sql)) rows.visits.push(this.args);
      if (/INSERT INTO questions/.test(sql)) rows.questions.push(this.args);
      return {};
    },
    async all() { return { results: [] }; },
  });
  return { rows, prepare: stmt, async batch(list) { for (const x of list) await x.run(); return list.map(() => ({ results: [] })); } };
}
const evReq = (body, headers = {}) => new Request('https://x.workers.dev/api/e', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Safari/604.1', 'CF-Connecting-IP': '203.0.113.9', ...headers },
});
await (async () => {
  const DB = fakeD1();
  const r1 = await onEventPost({ request: evReq({ t: 'v', ref: '', tp: 5 }), env: { DB } });
  await onEventPost({ request: evReq({ t: 'q', q: '電話0912345678 冰那堤', via: 'local', kind: 'drink', drinks: ['冰那堤'], topics: [], typos: ['冷翠→冷萃'] }), env: { DB } });
  t('統計：寫入開啟與提問（遮掉個資、不存 IP）', () => {
    assert.equal(r1.status, 204);
    assert.equal(DB.rows.visits.length, 1);
    assert.equal(DB.rows.questions.length, 1);
    const q = DB.rows.questions[0];
    assert.equal(q[4], '電話［已遮蔽］ 冰那堤');
    assert.equal(q[7], '["冰那堤"]');
    assert.ok(!JSON.stringify(DB.rows).includes('203.0.113.9'));
  });
  const DB2 = fakeD1();
  await onEventPost({ request: evReq({ t: 'v' }, { 'Sec-Fetch-Site': 'cross-site' }), env: { DB: DB2 } });
  const r2 = await onEventPost({ request: evReq({ t: 'v' }), env: {} });
  t('統計：別的網站送來的不收；沒有資料庫時不出錯', () => {
    assert.equal(DB2.rows.visits.length, 0);
    assert.equal(r2.status, 204);
  });
})();

// 後台門禁：用自己產生的金鑰模擬 Cloudflare Access 的 JWT
await (async () => {
  const TEAM = 'https://vibebrick.cloudflareaccess.com', AUD = 'aud-test-123';
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256' };
  const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
  async function jwt(payload, kid = 'k1') {
    const head = b64({ alg: 'RS256', kid, typ: 'JWT' }), body = b64(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => (String(url) === `${TEAM}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [jwk] })) : new Response('no', { status: 404 }));
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: TEAM, aud: [AUD], email: 'owner@example.com', exp: now + 600, iat: now };
  const req = (token, host = 'custom-fee-admin.x.workers.dev') => new Request(`https://${host}/`, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });
  const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD };
  const ok = await checkAccess(req(await jwt(good)), env);
  const noToken = await checkAccess(req(null), env);
  const setup = await checkAccess(req(await jwt(good)), {});
  const wrongAud = await checkAccess(req(await jwt({ ...good, aud: ['other'] })), env);
  const expired = await checkAccess(req(await jwt({ ...good, exp: now - 10 })), env);
  const t0 = await jwt(good); const tampered = t0.replace(/\.[^.]+\./, `.${b64({ ...good, email: 'evil@example.com' })}.`);
  const forged = await checkAccess(req(tampered), env);
  const wrongEmail = await checkAccess(req(await jwt(good)), { ...env, ADMIN_EMAIL: 'someone@example.com' });
  const bareTeam = await checkAccess(req(await jwt(good)), { TEAM_DOMAIN: TEAM.replace('https://', ''), POLICY_AUD: AUD });
  const devRemote = await checkAccess(req(null), { DEV_NO_ACCESS: '1' });
  const devLocal = await checkAccess(req(null, 'localhost:8788'), { DEV_NO_ACCESS: '1' });
  globalThis.fetch = realFetch;
  t('後台門禁：正確的 Access JWT 才能進入', () => {
    assert.equal(ok.ok, true);
    assert.equal(bareTeam.ok, true);
    assert.equal(noToken.why, 'no_access');
    assert.deepEqual([setup.ok, setup.why, setup.iss, setup.aud], [false, 'setup', TEAM, AUD]);
    assert.equal(wrongAud.ok, false);
    assert.equal(expired.ok, false);
    assert.equal(forged.ok, false);
    assert.equal(wrongEmail.ok, false);
  });
  t('後台門禁：略過門禁只在本機有效', () => {
    assert.equal(devRemote.ok, false);
    assert.equal(devLocal.ok, true);
  });
})();

console.log('語意分流');
const TH = { soft: 0.7, margin: 0.05 };
const sc = (topic, score) => ({ topic, score, text: topic });
t('很像預寫答案能回答的問法 → 用預寫答案', () => {
  assert.equal(decideRoute([sc('eco', 0.9), sc('_near', 0.6)], ['eco'], TH).local, true);
});
t('比較像「沒回答到」的問法 → 交給 AI', () => {
  assert.equal(decideRoute([sc('eco', 0.74), sc('_near', 0.88)], ['eco'], TH).local, false);
});
t('分數很高，但「答不到的例句」更像 → 交給 AI（正式環境校正時的兩題）', () => {
  assert.equal(decideRoute([sc('eco', 0.831), sc('_near', 0.904)], ['eco'], TH).local, false);
  assert.equal(decideRoute([sc('protein', 0.86), sc('_near', 0.986)], ['protein'], TH).local, false);
  assert.equal(decideRoute([sc('ice', 0.776), sc('_near', 0.661)], ['ice'], TH).local, true);
});
t('都不夠像 → 交給 AI', () => {
  assert.equal(decideRoute([sc('eco', 0.6), sc('_near', 0.5)], ['eco'], TH).local, false);
});
t('最像的是別的主題 → 交給 AI', () => {
  assert.equal(decideRoute([sc('eco', 0.75), sc('bogo', 0.8), sc('_near', 0.5)], ['eco'], TH).local, false);
});
t('例句都對得到主題，且沒有重複', () => {
  const ids = new Set(TOPICS.map(x => x.id));
  for (const k of Object.keys(ROUTE_EXAMPLES)) assert.ok(ids.has(k), k);
  const texts = BANK.map(b => b.text);
  assert.equal(new Set(texts).size, texts.length);
  assert.ok(ROUTE_NEAR_MISS.length >= 10);
});
t('「我意思是／我是問」算澄清，不算看不懂', () => {
  assert.ok(isClarify('我意思是，環保杯有限定是用保溫杯還是塑膠杯？'));
  assert.ok(isClarify('我是問保溫杯可不可以'));
  assert.ok(!isClarify('補飲料是什麼意思？'));
  const r = reply('我意思是，環保杯有限定是用保溫杯還是塑膠杯？', { lastTopics: ['eco'] });
  assert.ok(!r?.regions && !/這部分是門市規則/.test(r?.text || ''));
});
t('關鍵字找到的預寫答案會標記 faq（要先做語意確認）', () => {
  assert.deepEqual(reply('用環保杯可以折嗎？').faq, ['eco']);
  assert.equal(reply('冰那堤去冰').faq, undefined);
  assert.equal(reply('燕麥奶加抹茶液多少').faq, undefined);
});

// 假的向量模型：用字的二元組當特徵，夠測流程
function fakeAI(log = []) {
  const vec = s => {
    const v = new Array(256).fill(0);
    const t = String(s).replace(/[？?，,。！!\s]/g, '');
    for (let i = 0; i < t.length - 1; i++) { let h = 0; for (const c of t.slice(i, i + 2)) h = (h * 31 + c.codePointAt(0)) >>> 0; v[h % 256] += 1; }
    return v;
  };
  return {
    run: async (model, input) => {
      log.push(model);
      if (/bge-m3/.test(model)) return { shape: [input.text.length, 256], data: input.text.map(vec) };
      return { response: '圖表沒有規定環保杯的材質，保溫杯、塑膠隨行杯能不能用，請以門市夥伴說明為準。' };
    },
  };
}
const post = async (env, body) => {
  const r = await onRequestPost({ request: new Request('https://x.dev/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
  return r.json();
};
await (async () => {
  const calls = [];
  const env = { AI: fakeAI(calls), ROUTE_SOFT: '0.5', ROUTE_MARGIN: '0.02' };
  resetBank();
  const a = await post(env, { messages: [{ role: 'user', content: '用環保杯可以折嗎？' }], route: { topics: ['eco'] } });
  t('後端：問法夠像 → 回 route local，不叫 AI', () => {
    assert.equal(a.route, 'local');
    assert.ok(!calls.some(m => /qwen/.test(m)));
  });
  const b = await post(env, { messages: [{ role: 'user', content: '環保杯有限定是用保溫杯還是塑膠杯？' }], route: { topics: ['eco'] } });
  t('後端：問法像「沒回答到」的例句 → 交給 AI 回答', () => {
    assert.equal(b.route, 'ai');
    assert.ok(/門市夥伴/.test(b.reply));
    assert.ok(b.sem.near > b.sem.score, JSON.stringify(b.sem));
  });
  const c = await post({ AI: fakeAI() }, { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: '我意思是保溫杯可以嗎' }], route: { clarify: true, topics: ['eco'] } });
  t('後端：澄清 → 直接叫 AI', () => assert.ok(c.reply && c.route === 'ai'));
  const d = await post({}, { messages: [{ role: 'user', content: '用環保杯可以折嗎？' }], route: { topics: ['eco'] } });
  t('後端：沒有 Workers AI → 維持預寫答案', () => assert.equal(d.route, 'local'));
})();

console.log(`\n${pass} 項通過`);
