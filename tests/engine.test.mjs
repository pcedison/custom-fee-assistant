// 執行：npm test（或 node tests/engine.test.mjs）
import assert from 'node:assert/strict';
import { localReply, computeQuote, normalize, parseAiReply, buildOrder, fixFacts, dietFor, dietProblems, guardDietReply, dietFallback } from '../public/engine.js';
import { DRINKS, dietSafe } from '../public/drinks.js';
import { buildSystemPrompt } from '../public/kb.js';
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

console.log(`\n${pass} 項通過`);
