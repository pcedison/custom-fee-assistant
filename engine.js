// =============================================================
// 關鍵字比對、加價試算、看不懂偵測（純函式，不碰 DOM，可在 Node 測試）
// =============================================================
import { TOPICS, ITEMS, REGIONS, ECO_CUP_DISCOUNT } from './kb.js?v=202610121515';
import { DRINKS, DRINK_ALIASES, NAME_FIXES, MILK_LABEL, hasMilk, refillType, hasEspresso, isChoiceDrink } from './drinks.js?v=202610121515';

const NUM = '(\\d{1,2}|[一二兩三四五六七八九十]{1,3})';
const CN = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const BLANK = '□';

export const TOPIC_BY_ID = Object.fromEntries(TOPICS.map(t => [t.id, t]));
const uniq = arr => [...new Set(arr)];
const blank = s => BLANK.repeat(s.length);

export function parseNum(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (CN[s[1]] || 0);
  if (s.length === 2 && s[1] === '十') return (CN[s[0]] || 0) * 10;
  if (s.length === 3 && s[1] === '十') return (CN[s[0]] || 0) * 10 + (CN[s[2]] || 0);
  return CN[s[0]] ?? null;
}

// 全形轉半形、轉小寫、去空白
export function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// 先把「焦糖瑪奇朵、香草拿鐵、抹茶拿鐵」這類飲品名稱遮掉，避免誤判成加料
const DRINK_RE = /(鹹焦糖|焦糖|香草|榛果|白摩卡|摩卡|抹茶|福吉|焙茶|可可|蜂蜜|太妃核果|肉桂)(風味)?(拿鐵|那堤|拿堤|瑪奇朵|星冰樂|歐蕾|奶茶|密斯朵|冰沙|咖啡(?!液)|可可)/g;
export function stripDrinks(norm) {
  return norm.replace(DRINK_RE, m => blank(m));
}

// ---------------------------------------------------------------
// 主題比對：所有關鍵字由長到短比對，比對到的字會被遮掉，
// 避免「香草風味」同時算進糖漿和高蛋白雲朵
// ---------------------------------------------------------------
const TOPIC_KW = TOPICS
  .flatMap(t => t.keywords.map(k => ({ k: normalize(k), t })))
  .filter(x => x.k)
  .sort((a, b) => b.k.length - a.k.length);

export function matchTopics(norm) {
  let work = stripDrinks(norm);
  const scores = new Map();
  const weakOnly = new Map();
  for (const { k, t } of TOPIC_KW) {
    if (!work.includes(k)) continue;
    scores.set(t.id, (scores.get(t.id) || 0) + k.length);
    const isWeak = (t.weak || []).includes(k);
    weakOnly.set(t.id, (weakOnly.get(t.id) ?? true) && isWeak);
    work = work.split(k).join(blank(k));
  }
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => TOPIC_BY_ID[id]);
  let normal = ranked.filter(t => !t.low);
  if (normal.length > 1) normal = normal.filter(t => !(t.id === 'overview' && weakOnly.get('overview')));
  if (normal.length) return normal.slice(0, 2);
  return ranked.slice(0, 1);
}

// ---------------------------------------------------------------
// 加價項目擷取（含份數）
// ---------------------------------------------------------------
const ITEM_NAMES = ITEMS
  .flatMap(it => it.names.map(n => (typeof n === 'string'
    ? { n: normalize(n), add: false, it }
    : { n: normalize(n.n), add: !!n.add, verbOnly: !!n.verb, tag: n.tag || '', it })))
  .sort((a, b) => b.n.length - a.n.length);
const ALL_NAMES = ITEM_NAMES.map(x => x.n).filter(n => n.length >= 2);

const VERB = '(?:多加|再加|另加|加|多|要|換成|換|升級|來|點)';
const UNIT = '(?:份|個|次|種|匙|下|shot)';
const RE_QTY_BEFORE = new RegExp(NUM + UNIT + '(?:的)?$');
const RE_VERB_BEFORE = new RegExp(VERB + '(?:' + NUM + UNIT + ')?$');
const RE_NEG_BEFORE = /(不|沒|沒有|免|別|勿|不用|不要)(加|要|用|補)?$/;
const RE_QTY_AFTER = new RegExp('^(?:多加|再加|加|要|來)?' + NUM + UNIT);
const RE_X_AFTER = /^[x×*](\d{1,2})/;

function startsWithItem(rest) {
  return ALL_NAMES.some(n => rest.startsWith(n));
}

export function extractItems(norm, out) {
  let work = stripDrinks(norm);
  const found = new Map();
  for (const { n, add, verbOnly, tag, it } of ITEM_NAMES) {
    let idx = work.indexOf(n);
    while (idx !== -1) {
      const before = work.slice(Math.max(0, idx - 5), idx);
      const afterAll = work.slice(idx + n.length);
      let qty = null;
      const mb = before.match(RE_QTY_BEFORE);
      if (mb) qty = parseNum(mb[1]);
      if (qty == null) {
        const ma = afterAll.match(RE_QTY_AFTER) || afterAll.match(RE_X_AFTER);
        if (ma && !startsWithItem(afterAll.slice(ma[0].length))) qty = parseNum(ma[1]);
      }
      const negated = RE_NEG_BEFORE.test(before);
      const mv = before.match(RE_VERB_BEFORE);
      const hasVerb = !!mv;
      const ok = !add || hasVerb || (!verbOnly && qty != null);
      if (!negated && ok) {
        const prev = found.get(it.id);
        found.set(it.id, {
          item: it,
          qty: Math.max(prev?.qty || 0, qty || 1),
          askedQty: qty,
          tag: prev?.tag || tag,
          swap: /^換/.test(mv?.[0] || ''),
        });
      }
      work = work.slice(0, idx) + blank(n) + work.slice(idx + n.length);
      idx = work.indexOf(n, idx + n.length);
    }
  }
  if (out) out.rest = work;
  // 有指定口味就不再重複計算「未指定口味」
  if ([...found.keys()].some(id => id === 'pro_vanilla' || id === 'pro_cocoa')) found.delete('pro_any');
  if ([...found.values()].some(f => f.item.group === 'syrup' && f.item.id !== 'syrup_any')) found.delete('syrup_any');
  // 依 ITEMS 原本順序排列
  return ITEMS.filter(it => found.has(it.id)).map(it => found.get(it.id));
}

const RE_ECO = /(環保杯|自備杯|自帶杯|隨行杯|自備容器|保溫杯|自己的杯|帶杯|環保)/;
const RE_ECO_NEG = /(沒|沒有|不|忘了|忘記|未)(帶|用|使用)?(自己的)?$/;
export function detectEco(norm) {
  const m = norm.match(RE_ECO);
  if (!m) return false;
  const before = norm.slice(Math.max(0, m.index - 5), m.index);
  return !RE_ECO_NEG.test(before);
}
export function detectBogo(norm) {
  return /(買一送一|買1送1|一送一|1送1|bogo|好友分享)/.test(norm);
}

// ---------------------------------------------------------------
// 試算
// ---------------------------------------------------------------
export function computeQuote(norm) {
  const items = extractItems(norm);
  const eco = detectEco(norm);
  const bogo = detectBogo(norm);
  const lines = [];
  const notes = [];
  let total = 0;

  for (const f of items) {
    const it = f.item;
    let qty = f.qty || 1;
    let label = it.label;
    let amount = it.price;
    if (it.perServing) {
      amount = it.price * qty;
      if (qty > 1) label = `${it.label} ×${qty}`;
    } else if (it.id === 'syrup_any') {
      amount = it.price * qty;
      if (qty > 1) {
        label = `風味糖漿 ×${qty} 種`;
        notes.push('同一種口味每杯限一份，以不同口味各一份計算。');
      }
    } else if (it.limitOne) {
      if (qty > 1) notes.push(`${it.label}每杯每項限一份，已以 1 份計算。`);
      qty = 1;
    }
    total += amount;
    lines.push({ id: it.id, label, amount });
  }

  if (eco) {
    if (bogo) {
      lines.push({ id: 'eco', label: '自備環保杯（買一送一不折抵）', amount: 0 });
    } else {
      lines.push({ id: 'eco', label: '自備環保杯', amount: -ECO_CUP_DISCOUNT });
      total -= ECO_CUP_DISCOUNT;
    }
  }

  const ids = items.map(f => f.item.id);
  if ((ids.includes('ice_milk') || ids.includes('ice_drink')) && !ids.includes('ice_less')) {
    notes.push('補奶類／補飲料適用於少冰、去冰的飲品。');
  }
  if (items.filter(f => f.item.group === 'milk').length > 1) {
    notes.push('一杯只能選一種奶，上面把提到的奶類都列出來了，請以實際選擇為準。');
  }
  if (items.some(f => f.item.group === 'protein')) {
    notes.push('高蛋白雲朵建議避免搭配熱飲、冰搖茶、星沁爽、星冰樂、Cold Foam、果汁類及冰淇淋系列。');
  }

  return {
    lines, total, notes, eco, bogo,
    items,
    regions: uniq(items.flatMap(f => f.item.regions)),
    hasQty: items.some(f => (f.askedQty || 1) > 1),
  };
}

const RE_SUM_INTENT = /(合計|總共|一共|試算|算一下|幫我算|總價|加起來|共多少|要付多少|多少錢)/;
export function shouldShowQuote(quote, norm) {
  const count = quote.items.length + (quote.eco ? 1 : 0);
  if (count >= 2) return true;
  if (quote.hasQty && quote.items.length) return true;
  if (count >= 1 && quote.items.length && /(試算|幫我算|算一下|合計|總共)/.test(norm)) return true;
  return false;
}

export function money(n) {
  if (n > 0) return `+$${n}`;
  if (n < 0) return `−$${Math.abs(n)}`;
  return '$0';
}

export function quoteToText(q) {
  const rows = q.lines.map(l => `- ${l.label} ${l.amount === 0 ? '$0（不加價）' : money(l.amount)}`);
  return [
    '加價試算（不含飲品本身價格）：',
    ...rows,
    `**合計：${money(q.total)}**`,
    ...q.notes.map(n => `⚠️ ${n}`),
  ].join('\n');
}

// ---------------------------------------------------------------
// 飲品辨識與點單試算
// ---------------------------------------------------------------
export function fixNames(norm) {
  let s = norm;
  for (const [re, to] of NAME_FIXES) s = s.replace(re, to);
  return s;
}
// 「冰那堤」「熱蜜柚紅茶」→ 去掉冷熱字；「冰搖紅茶」的冰是品名一部分，不去掉
const baseName = n => n.replace(/^熱/, '').replace(/^冰(?!搖)/, '');
const BASES = new Map();
for (const d of DRINKS) {
  const b = baseName(d.n);
  if (!BASES.has(b)) BASES.set(b, []);
  BASES.get(b).push(d);
}
const SIZE_LABEL = ['短杯', '中杯', '大杯', '特大杯'];
const SIZE_IDX = { 短杯: 0, short: 0, 中杯: 1, tall: 1, 大杯: 2, grande: 2, 特大杯: 3, venti: 3 };
const RE_SIZE = /(特大杯|短杯|中杯|大杯|venti|grande|tall|short)/;
const MILK_NAME = { dairy: '鮮奶', oat: '燕麥奶', coconut: '椰奶' };

// 看起來像飲品名、其實是加料的詞：先吃掉，避免「摩卡醬」被當成「摩卡」
const ADDON_BLOCK = ['摩卡醬', '摩卡風味淋醬', '摩卡淋醬', '焦糖醬', '焦糖風味淋醬', '焦糖淋醬', '焦糖糖漿', '鹹焦糖糖漿',
  '香草糖漿', '榛果糖漿', '可可碎片', '抹茶液', '抹茶粉', '福吉茶粉', '蜂蜜紅柚醬', '紅柚醬', '蜜柚醬',
  '星冰樂咖啡液', '咖啡液', '高蛋白雲朵', '濃縮咖啡'];

const DRINK_KEYS = (() => {
  const keys = new Map();
  const add = (k, base) => { k = normalize(k); if (k.length >= 2 && !keys.has(k)) keys.set(k, base); };
  for (const base of BASES.keys()) {
    add(base, base);
    (DRINK_ALIASES[base] || []).forEach(a => add(a, base));
    if (base.endsWith('咖啡') && base.length > 4) add(base.slice(0, -2), base);
    if (base.includes('風味')) add(base.replace('風味', ''), base);
  }
  add('燕麥那堤', '特選燕麥奶那堤');
  add('燕麥奶那堤', '特選燕麥奶那堤');
  const list = [...keys.entries()].map(([k, base]) => ({ k, base }));
  ADDON_BLOCK.forEach(k => list.push({ k, base: null }));
  return list.sort((a, b) => b.k.length - a.k.length);
})();

export function findDrinks(fixed) {
  let work = fixed;
  const hits = [];
  for (const { k, base } of DRINK_KEYS) {
    let idx = work.indexOf(k);
    while (idx !== -1) {
      if (base) hits.push({ base, idx, len: k.length });
      work = work.slice(0, idx) + blank(k) + work.slice(idx + k.length);
      idx = work.indexOf(k, idx + k.length);
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  return hits.filter(h => (seen.has(h.base) ? false : seen.add(h.base)));
}

function pickVariant(base, fixed, idx) {
  const vs = BASES.get(base);
  if (vs.length === 1) return { drink: vs[0], alt: null, tempKnown: true };
  const iced = vs.find(d => d.t === 'iced');
  const hot = vs.find(d => d.t === 'hot');
  const prev = fixed[idx - 1];
  let want = null;
  if (prev === '冰') want = 'iced';
  else if (prev === '熱' || prev === '溫') want = 'hot';
  else if (/(少冰|去冰|微冰|正常冰|多冰|冰塊|冰的)/.test(fixed)) want = 'iced';
  else if (/(熱的|熱飲|溫的|做熱|要熱)/.test(fixed)) want = 'hot';
  if (want === 'iced' && iced) return { drink: iced, alt: hot, tempKnown: true };
  if (want === 'hot' && hot) return { drink: hot, alt: iced, tempKnown: true };
  return { drink: iced || hot || vs[0], alt: iced ? hot : null, tempKnown: false };
}

const RE_SWEET = /(?:^|[^加多])((?:\d|[一二兩三四五六七八九十半])下(?:糖漿|糖)|(?:糖漿|糖)(?:\d|[一二兩三四五六七八九十半])下|半糖|微糖|少糖|減糖|無糖|去糖|不要糖|不加糖|不要加糖|少甜|微甜|無甜|不要甜)/;
export function matchSweet(text) {
  const m = text.match(RE_SWEET);
  return m ? m[1] : null;
}

const GROUP_TOPIC2 = { ice: 'ice', esp: 'espresso', milk: 'milk', syrup: 'syrup', other: 'other', protein: 'protein' };

function drinkSummary(pk) {
  const d = pk.drink;
  const sizes = d.p.map((p, i) => (p == null ? null : `${SIZE_LABEL[i]} $${p}`)).filter(Boolean);
  const altPrice = pk.alt && pk.alt.p.join() !== d.p.join();
  return {
    name: pk.tempKnown ? d.n : `${baseName(d.n)}（${pk.alt ? '冰／熱' : d.n}）`.replace(/（(.+)）$/, (m, x) => (x === d.n ? '' : `（${x}）`)),
    milk: MILK_LABEL[d.m],
    hasMilk: hasMilk(d),
    comp: d.c,
    prices: sizes.join('／') || '價格請洽門市',
    altNote: altPrice ? `${pk.alt.n}：${pk.alt.p.map((p, i) => (p == null ? null : `${SIZE_LABEL[i]} $${p}`)).filter(Boolean).join('／')}` : '',
    info: [d.note, d.season ? '季節限定，依門市供應為準' : ''].filter(Boolean).join('；'),
  };
}

// 把認得的部分（加料、杯型、甜度、環保杯、口語）拿掉後，剩下的就是看不懂的詞
const RE_FILLER = new RegExp([
  RE_SIZE.source,
  '(?:\\d+|[一二兩三四五六七八九十半]+)(?:份|個|次|種|匙|下|杯|shot)',
  '(?:糖漿|糖)?(?:\\d|[一二兩三四五六七八九十半])下(?:糖漿|糖)?|半糖|微糖|少糖|減糖|無糖|去糖|不要糖|不加糖|少甜|微甜|無甜',
  '環保杯|自備杯|自帶杯|隨行杯|自備容器|保溫杯|自己的杯|帶杯|環保|買一送一|買1送1|一送一|1送1|好友分享',
  '正常冰|正常甜|正常|冰的|熱的|溫的|多冰',
  '請問|我要|我想|想要|幫我|麻煩|多少錢|多少|價錢|價格|總共|一共|合計|試算|算一下|有奶嗎|有牛奶嗎|有沒有奶|含奶|會怎樣|可以嗎|可以|怎麼算',
  '不要|不用|沒有|沒帶|要|請|的|嗎|呢|吧|啊|喔|跟|和|還有|然後|另外|加上|再|換成|換|加|改|升級|多|點|杯|冰|熱|溫',
].map(x => `(?:${x})`).join('|'), 'g');
function leftoverWords(rest) {
  return rest
    .replace(RE_FILLER, ' ')
    .split(/[^\p{Script=Han}a-z0-9]+/u)
    .filter(w => w.length >= 2);
}

export function buildOrder(norm) {
  const fixed = fixNames(norm);
  const hits = findDrinks(fixed);
  if (!hits.length) return null;
  const picks = hits.map(h => ({ ...pickVariant(h.base, fixed, h.idx), hit: h }));
  if (picks.length > 1) {
    return { kind: 'multi', drinks: picks.slice(0, 4).map(drinkSummary) };
  }

  const pk = picks[0];
  const d = pk.drink;
  const dn = pk.tempKnown ? d.n : baseName(d.n);
  let itemsText = fixed;
  for (const h of hits) itemsText = itemsText.slice(0, h.idx) + blank(itemsText.slice(h.idx, h.idx + h.len)) + itemsText.slice(h.idx + h.len);

  const ex0 = {};
  const items = extractItems(itemsText, ex0);
  const unknown = leftoverWords(ex0.rest || '');
  const eco = detectEco(itemsText);
  const bogo = detectBogo(itemsText);
  const sm = itemsText.match(RE_SIZE);
  const sizeIdx = sm ? SIZE_IDX[sm[1]] : null;
  const sweet = matchSweet(itemsText);
  const ids = items.map(f => f.item.id);
  const iceLess = ids.includes('ice_less');
  const refill = ids.includes('ice_milk') || ids.includes('ice_drink');
  const milky = hasMilk(d);
  const rt = refillType(d);
  const milkWord = d.m === 'dairy' ? '牛奶' : (MILK_NAME[d.m] || '牛奶');
  const iceWord = (itemsText.match(/少冰|去冰|微冰|不要冰|無冰/) || ['少冰'])[0];
  const lines = [];
  const notes = [];
  const tips = [];
  const extraRegions = [];

  if (unknown.length) notes.push(`有一段我沒看懂：「${unknown.join('」「')}」。可以換個說法，例如「升級特選」「加一份濃縮」「換燕麥奶」。`);
  if (d.nocustom && (items.length || sweet)) notes.push('官網註明：這款不提供客製化調整。');

  // ---- 濃縮咖啡：先看這杯本身有沒有濃縮 ----
  const up = items.find(f => f.item.id === 'esp_upgrade');
  const ex = items.find(f => f.item.id === 'esp_extra');
  const decaf = items.find(f => f.item.id === 'esp_decaf');
  if (!hasEspresso(d)) {
    if (up || ex) {
      const shots = Math.max(up?.qty || 0, ex?.qty || 0, 1);
      const x = shots > 1 ? ` ×${shots}` : '';
      lines.push({ id: 'esp_extra', label: shots > 1 ? `加濃縮咖啡${x}` : '加一份濃縮咖啡', amount: 15 * shots });
      extraRegions.push('esp_extra');
      if (up) {
        lines.push({ id: 'esp_upgrade', label: `特選豆${x}`, amount: 15 * shots });
        extraRegions.push('esp_upgrade');
        notes.push(shots > 1
          ? `${dn}原本不含濃縮咖啡：每加一份特選濃縮＝加濃縮 +$15＋特選豆 +$15，${shots} 份一共 +$${30 * shots}。`
          : `${dn}原本不含濃縮咖啡：要加特選濃縮＝加一份濃縮咖啡 +$15＋特選豆 +$15，一共 +$30。`);
      } else {
        notes.push(`${dn}原本不含濃縮咖啡，加一份一般濃縮咖啡 +$15${shots > 1 ? `，${shots} 份 +$${15 * shots}` : ''}。`);
      }
    }
    if (decaf) {
      lines.push({ id: 'esp_decaf', label: '低咖啡因', amount: null, status: '不適用' });
      notes.push(`${dn}不含濃縮咖啡，沒有低咖啡因可以換。`);
    }
  } else {
    if (up) {
      const q = up.qty || 1;
      if (isChoiceDrink(d)) {
        lines.push({ id: 'esp_upgrade', label: '特選濃縮咖啡', amount: 0, status: '本來就是' });
        notes.push(`${dn}本來就是特選濃縮咖啡，不用再升級。`);
      } else {
        lines.push({ id: 'esp_upgrade', label: `升級特選濃縮咖啡${q > 1 ? ` ×${q}` : ''}`, amount: 15 * q });
      }
    }
    if (ex) {
      const q = ex.qty || 1;
      lines.push({ id: 'esp_extra', label: `多加一份濃縮咖啡${q > 1 ? ` ×${q}` : ''}`, amount: 15 * q });
    }
    if (decaf) lines.push({ id: 'esp_decaf', label: '低咖啡因', amount: 0 });
  }

  for (const f of items) {
    const it = f.item;
    if (it.group === 'esp') continue;
    let label = it.label;
    let amount = it.price;
    const qty = f.qty || 1;

    if (it.id === 'ice_less') {
      if (d.t === 'hot') { notes.push('熱飲沒有冰塊，不需要調整冰量。'); continue; }
      if (d.noice) { notes.push('官網註明：這款不開放冰塊、甜度調整。'); continue; }
      if (d.t === 'blended') notes.push('冰沙類飲品的冰量調整，請以門市為準。');
      label = (itemsText.match(/少冰|去冰|微冰|不要冰|無冰/) || ['少冰／去冰'])[0];
    } else if (it.id === 'ice_milk' || it.id === 'ice_drink') {
      // 有奶的飲品說「補滿」＝補牛奶
      const asMilk = it.id === 'ice_milk' || (f.tag === 'fill' && rt === 'milk');
      const lineId = asMilk ? 'ice_milk' : 'ice_drink';
      if (lineId !== it.id) extraRegions.push(lineId, 'ice_note2');
      if (d.t === 'hot') {
        amount = null; label = asMilk ? '補牛奶' : '補飲料';
        notes.push('熱飲沒有冰塊，不適用補牛奶／補飲料；熱飲想多加牛奶，請以門市為準。');
      } else if (rt === 'nocb') {
        amount = null; label = asMilk ? '補牛奶' : `補${d.fill || '冷萃'}`;
        notes.push(`冷萃類飲品不能補。${asMilk ? '想加牛奶請以門市為準。' : ''}`);
        lines.push({ id: lineId, label, amount, blocked: true, status: '不能補' });
        continue;
      } else if (rt === null) {
        amount = null; label = asMilk ? '補牛奶' : '補飲料';
        notes.push('冰沙、冰淇淋類飲品不適用補牛奶／補飲料，請以門市為準。');
      } else if (asMilk && f.tag === 'addmilk' && !iceLess) {
        amount = null; label = '加牛奶';
        notes.push('圖表的「補奶類 +$15」是給少冰／去冰的飲品；正常冰想加牛奶，圖表沒有寫，請以門市為準。');
      } else if (asMilk) {
        label = milky ? `補${milkWord}（補奶類）` : '補牛奶（補奶類）';
        if (!milky) notes.push(`${dn}本身不含奶；補牛奶圖表同樣收 $15，能否這樣調整請以門市為準。`);
      } else {
        label = `補${d.fill || '飲料'}（補飲料）`;
        if (rt === 'ask') notes.push('這款能不能補飲料，請以門市為準。');
        if (rt === 'milk') notes.push(`這杯有奶，一般是補${milkWord}；補飲料同樣 $15。`);
      }
      lines.push({ id: lineId, label, amount });
      continue;
    } else if (it.group === 'milk') {
      if (!milky) {
        amount = null;
        notes.push(`${dn}本身${MILK_LABEL[d.m]}，沒有奶類可以更換；想加奶請以門市為準。`);
      } else if ((d.m === 'oat' && it.id === 'milk_oat') || (d.m === 'coconut' && it.id === 'milk_coco')) {
        amount = 0; label = `${it.label}（本來就是）`;
      }
    } else if (it.group === 'syrup' && f.swap) {
      amount = 0; label = `換成${it.label}`;
      notes.push('官網客製化頁：更換飲料原有的風味糖漿不另收費，額外添加才收 $15。');
    } else if (it.group === 'protein') {
      const why = d.t === 'hot' ? '熱飲' : d.shaken ? '冰搖茶' : d.g === 'ref' ? '星沁爽' : d.g === 'frap' ? '星冰樂'
        : d.coldfoam ? 'Cold Foam 飲品' : d.g === 'juice' ? '果汁類' : d.g === 'float' ? '冰淇淋飲品' : '';
      if (/蛋白雲朵/.test(d.n)) notes.push(`${dn}本身就有高蛋白奶泡。`);
      if (why) notes.push(`這杯是${why}，圖表建議避免搭配高蛋白雲朵。`);
    }

    if (amount != null && amount !== 0) {
      if (it.perServing) {
        amount = it.price * qty;
        if (qty > 1) label = `${label} ×${qty}`;
      } else if (it.id === 'syrup_any' && qty > 1) {
        amount = it.price * qty; label = `風味糖漿 ×${qty} 種`;
      } else if (it.limitOne && qty > 1) {
        notes.push(`${it.label}每杯每項限一份，已以 1 份計算。`);
      }
    }
    if (it.id === 'o_matcha' && f.tag === 'powder') notes.push('圖表列的是「抹茶液」：加一份 $15，每杯限一份。');
    lines.push({ id: it.id, label, amount });
  }

  if (sweet) {
    lines.push({ id: 'sweet', label: `調整甜度（${sweet}）`, amount: null });
    if (d.noice) { /* 冰雪星沁爽：上面已提醒不開放甜度調整 */ }
    else if (d.sauce) {
      const sauceName = d.sauce.split('為維持')[0];
      notes.push(`調整甜度圖表沒有列價格。這杯的甜味來自${sauceName}，官網註明${sauceName}為維持風味最少 1 匙。`);
    } else {
      notes.push('調整甜度圖表沒有列價格（圖上標示「調整甜度 風味不變」），請以門市為準。');
    }
    extraRegions.push('sweet_btn');
  }

  // 只說少冰／去冰、沒說要補：不算錢，但立刻反問要不要補
  let ask = null;
  if (iceLess && !refill && !d.noice) {
    if (rt === 'milk') {
      ask = { add: `補${milkWord}`, q: `需要補${milkWord}嗎？`, yes: `要補${milkWord}`,
        sub: `補${milkWord} +$15；只${iceWord}、沒有要補，就不加價。` };
      extraRegions.push('ice_milk', 'ice_note2');
    } else if (rt === 'tea') {
      ask = { add: `補${d.fill || '茶'}`, q: `需要補${d.fill || '茶'}嗎？`, yes: `要補${d.fill || '茶'}`,
        sub: `補${d.fill || '茶'}（補飲料）+$15；只${iceWord}、沒有要補，就不加價。這杯不含奶，不會補牛奶。` };
      extraRegions.push('ice_drink', 'ice_note2');
    } else if (rt === 'nocb') {
      tips.push(`冷萃類飲品不能補，只${iceWord}不加價。`);
    } else if (rt === 'ask') {
      tips.push(`這杯${milky ? '' : '不含奶，'}只${iceWord}不加價；能不能補飲料請以門市為準（補飲料 +$15）。`);
    }
  }

  if (eco) {
    lines.push(bogo
      ? { id: 'eco', label: '自備環保杯（買一送一不折抵）', amount: 0 }
      : { id: 'eco', label: '自備環保杯', amount: -ECO_CUP_DISCOUNT });
  }

  if (lines.some(l => l.amount == null && !l.status)) notes.push('標示「未列價」的項目沒有算進合計。');

  let basePrice = null;
  if (sizeIdx != null) {
    basePrice = d.p[sizeIdx];
    if (basePrice == null) {
      const avail = d.p.map((p, i) => (p == null ? null : SIZE_LABEL[i])).filter(Boolean).join('、');
      notes.push(`${dn}沒有${SIZE_LABEL[sizeIdx]}，可選：${avail || '請洽門市'}。`);
    }
  }
  const addTotal = lines.reduce((sum, l) => sum + (l.amount || 0), 0);
  const sizeTotals = d.p.map((p, i) => (p == null ? null : { label: SIZE_LABEL[i], total: p + addTotal })).filter(Boolean);

  const topicIds = uniq([
    ...items.map(f => (f.item.id === 'o_matcha' ? 'matcha' : GROUP_TOPIC2[f.item.group])),
    eco ? 'eco' : null, sweet ? 'sweetness' : null,
  ].filter(Boolean));

  return {
    kind: 'drink',
    summary: drinkSummary(pk),
    drink: d,
    tempKnown: pk.tempKnown,
    sizeIdx, sizeLabel: sizeIdx != null ? SIZE_LABEL[sizeIdx] : null,
    basePrice, lines, addTotal, sizeTotals, notes, tips, ask, iceWord,
    // 冰飲、可補、還沒指定冰量 → 卡片上給「正常冰／少冰／去冰」按鈕
    iceSelectable: d.t === 'iced' && !iceLess && !refill && !d.noice && (rt === 'milk' || rt === 'tea'),
    regions: uniq([...items.filter(f => lines.some(l => l.id === f.item.id)).flatMap(f => f.item.regions), ...extraRegions]),
    topics: topicIds,
    fixed,
    hasExtras: lines.length > 0,
  };
}

function explainOrder(o) {
  const s = o.summary;
  const rt = refillType(o.drink);
  const head = rt === 'nocb'
    ? `${s.name}是冷萃類飲品（${s.comp}），不能補；只${o.iceWord}不加價。`
    : s.hasMilk
      ? `${s.name}是有奶的飲品（${s.comp}），所以少冰／去冰想補滿，補的是牛奶（補奶類）。`
      : `${s.name}不含奶（${s.comp}），所以少冰／去冰想補滿，補的是飲料本身，不是牛奶。`;
  const rows = o.lines.map(l => `- ${l.label}：${l.status ? l.status : l.amount == null ? '圖表沒有列價格' : l.amount === 0 ? '不用加錢' : `多付 ${money(l.amount).replace('+', '')}`}`);
  return [head, ...rows, ...o.tips, ...(o.ask ? [`${o.ask.q}${o.ask.sub}`] : [])].join('\n');
}

export function orderToText(o) {
  if (o.kind === 'multi') {
    return o.drinks.map(s => `${s.name}：${s.milk}｜${s.comp}｜${s.prices}`).join('\n');
  }
  const s = o.summary;
  const out = [`${s.name}：${s.milk}｜${s.comp}`, `價格：${s.prices}`];
  o.lines.forEach(l => out.push(`- ${l.label} ${l.status || (l.amount == null ? '未列價' : l.amount === 0 ? '$0' : money(l.amount))}`));
  if (o.lines.length) out.push(`加價合計 ${money(o.addTotal)}`);
  if (o.basePrice != null) out.push(`**合計（${o.sizeLabel}）：$${o.basePrice + o.addTotal}**`);
  else if (o.lines.length) out.push(`含飲品：${o.sizeTotals.map(t => `${t.label} $${t.total}`).join('／')}`);
  o.tips.forEach(t => out.push(t));
  if (o.ask) out.push(`**${o.ask.q}**${o.ask.sub}`);
  o.notes.forEach(n => out.push(`⚠️ ${n}`));
  return out.join('\n');
}

// ---------------------------------------------------------------
// 看不懂／想看圖
// ---------------------------------------------------------------
const RE_CONFUSED = /(看不懂|聽不懂|不懂|沒懂|不太懂|搞不懂|不明白|不了解|不理解|不清楚|看不清|什麼意思|甚麼意思|啥意思|意思是|是指|指什麼|是什麼|是甚麼|什麼是|甚麼是|是啥|哪裡|在哪|圖上|標出|標給|標示|畫給|圈出|指給|給我看|霧煞煞|解釋|霧沙沙)/;
export function isConfused(norm) {
  if (RE_CONFUSED.test(norm)) return true;
  return /^(蛤+|啊+\?*|\?+|嗯\?+|什麼\?*|甚麼\?*)$/.test(norm);
}
const RE_WANT_IMAGE = /(原圖|完整圖|整張圖|圖表|收費表|價目表|看圖|圖片|那張圖|這張圖)/;
export function wantsImage(norm) {
  return RE_WANT_IMAGE.test(norm);
}

// ---------------------------------------------------------------
// 主流程：能用關鍵字回答就回答；回 null 代表交給 AI
// ---------------------------------------------------------------
export function localReply(input, state = {}) {
  let norm = normalize(input);
  if (!norm) return null;

  const topics = matchTopics(norm);
  const specific = topics.filter(t => !t.low);
  const quote = computeQuote(norm);
  const showQuote = shouldShowQuote(quote, norm);
  const confused = isConfused(norm);
  const wantImage = wantsImage(norm);

  // 只想看完整原圖
  if (/(原圖|完整圖|整張圖|全圖)/.test(norm) && !specific.filter(t => t.id !== 'overview').length) {
    return {
      source: 'local',
      text: '這是完整的客製化收費圖表，點圖可以放大。想問哪一項，我可以幫你標出來。',
      plainImage: true,
      topics: [],
      chips: ['有哪些新收費？', '去冰補奶要加錢嗎？', '抹茶液可以加幾份？'],
    };
  }

  if (confused || wantImage) {
    let target = specific;
    let itemRegions = quote.regions;
    let fromContext = false;
    if (!target.length && !itemRegions.length) {
      target = (state.lastTopics || []).map(id => TOPIC_BY_ID[id]).filter(Boolean);
      itemRegions = state.lastItemRegions || [];
      fromContext = true;
    }
    const withImg = target.filter(t => t.regions.length);
    // 上一則是試算：只標出試算裡的那幾項，比整區標示更清楚
    const regions = (fromContext && state.lastWasQuote && itemRegions.length)
      ? uniq(itemRegions)
      : uniq([...withImg.flatMap(t => t.regions), ...itemRegions]);

    // 上一則是飲品試算：用那杯飲品的情況來解釋
    const lastOrder = (fromContext && state.lastOrder) ? buildOrder(state.lastOrder) : null;
    if (lastOrder && lastOrder.kind === 'drink' && lastOrder.regions.length) {
      return {
        source: 'local',
        text: explainOrder(lastOrder),
        regions: lastOrder.regions,
        caption: '圖上相關的地方用橘色螢光筆標起來了，點圖可以放大。',
        topics: lastOrder.topics,
        itemRegions: lastOrder.regions,
        chips: ['哪些飲料有牛奶？', '用環保杯呢？'],
      };
    }

    if (regions.length) {
      const parts = withImg.map(t => t.simple);
      if (!parts.length && quote.items.length) parts.push(quoteToText(quote));
      const noImg = target.filter(t => !t.regions.length);
      noImg.forEach(t => parts.push(`${t.simple}（這部分不在圖表上）`));
      return {
        source: 'local',
        text: parts.join('\n\n'),
        regions,
        caption: '圖上相關的地方用橘色螢光筆標起來了，點圖可以放大。',
        topics: target.map(t => t.id),
        itemRegions,
        chips: followChips(target),
      };
    }

    if (target.length) {
      return {
        source: 'local',
        text: target.map(t => t.simple).join('\n\n') + '\n\n這部分是門市規則，收費圖表上沒有，所以沒辦法用圖標示。',
        topics: target.map(t => t.id),
        chips: followChips(target),
      };
    }

    if (wantImage && !confused) {
      return {
        source: 'local',
        text: '這是完整的客製化收費圖表，點圖可以放大。想問哪一項，我可以幫你標出來。',
        plainImage: true,
        topics: [],
        chips: ['有哪些新收費？', '去冰補奶要加錢嗎？', '抹茶液可以加幾份？'],
      };
    }

    if (!fromContext || !(state.lastTopics || []).length) {
      const ov = TOPIC_BY_ID.overview;
      return {
        source: 'local',
        text: `${ov.simple}\n\n想更細看哪一項，直接點下面的問題或打字問我。`,
        regions: ov.regions,
        caption: '先把圖上各區的標題標出來，點圖可以放大。',
        topics: ['overview'],
        chips: ov.follow,
      };
    }
    return null;
  }

  // 剛反問「需要補牛奶嗎？」：處理「要／不用」這類簡短回答
  if (state.pending && state.lastOrder) {
    const short = norm.replace(/[。!！~～,，.]+$/g, '');
    if (/^(要|好|需要|要的|好的|可以|對|是|嗯|麻煩|ok|yes)(喔|啊|呀|唷|欸|哦)?$/.test(short)) {
      norm = state.lastOrder + state.pending.add;
    } else if (/^(不用|不要|不需要|不補|免|沒關係|不必|不了|no)(補)?(了|喔|啦|囉|唷)?$/.test(short)) {
      const o = buildOrder(state.lastOrder);
      if (o && o.kind === 'drink') {
        o.ask = null;
        o.tips = [`好的，不補。只${o.iceWord}不加價。`];
        return {
          source: 'local', text: orderToText(o), order: o, orderText: state.lastOrder,
          topics: o.topics.length ? o.topics : ['ice'], itemRegions: o.regions,
          chips: [o.sizeIdx == null ? '大杯呢？' : null, '用環保杯呢？', '哪些飲料有牛奶？'].filter(Boolean),
          pending: null,
        };
      }
    }
  }

  // 有提到飲品：依那杯飲品回答（含不含奶、價格、加價）
  let order = buildOrder(norm);
  let orderText = order ? fixNames(norm) : null;
  if (!order && state.lastOrder && norm.length <= 24) {
    const fx = fixNames(norm);
    const hasNew = RE_SIZE.test(fx) || extractItems(fx).length || detectEco(fx) || matchSweet(fx);
    if (hasNew) {
      const prev = RE_SIZE.test(fx) ? state.lastOrder.replace(new RegExp(RE_SIZE.source, 'g'), '') : state.lastOrder;
      orderText = prev + fx;
      order = buildOrder(orderText);
    }
  }
  if (order) {
    if (order.kind === 'multi') {
      return {
        source: 'local',
        text: orderToText(order),
        order,
        topics: [],
        chips: ['哪些飲料有牛奶？', ...order.drinks.slice(0, 2).map(x => `${x.name.replace(/（.*$/, '')}去冰補滿多少？`)],
      };
    }
    const chips = [];
    if (order.regions.length) chips.push('看不懂，標給我看');
    if (order.sizeIdx == null) chips.push('大杯呢？');
    if (!order.lines.some(l => l.id === 'eco')) chips.push('用環保杯呢？');
    chips.push('哪些飲料有牛奶？');
    return {
      source: 'local',
      text: orderToText(order),
      order,
      orderText,
      topics: order.topics.length ? order.topics : ['milk_list'],
      itemRegions: order.regions,
      chips: chips.slice(0, 3),
      markable: !!order.regions.length,
      pending: order.ask ? { add: order.ask.add } : null,
    };
  }

  if (showQuote) {
    return {
      source: 'local',
      text: quoteToText(quote),
      quote,
      topics: quoteTopics(quote),
      itemRegions: quote.regions,
      chips: ['看不懂，標給我看', ...followChips(specific.length ? specific : quoteTopics(quote).map(id => TOPIC_BY_ID[id]))].slice(0, 3),
      markable: true,
    };
  }

  if (specific.length) {
    const hasRegions = specific.some(t => t.regions.length) || quote.regions.length;
    return {
      source: 'local',
      text: specific.map(t => t.answer).join('\n\n'),
      topics: specific.map(t => t.id),
      itemRegions: quote.regions,
      chips: [...(hasRegions ? ['看不懂，標給我看'] : []), ...followChips(specific)].slice(0, 3),
      markable: !!hasRegions,
    };
  }

  if (topics.length) {
    const t = topics[0];
    return { source: 'local', text: t.answer, topics: [], chips: t.follow };
  }

  return null;
}

// 試算裡每一項對應的主題（看不懂時用來解釋）
const GROUP_TOPIC = { ice: 'ice', esp: 'espresso', milk: 'milk', syrup: 'syrup', other: 'other', protein: 'protein' };
function quoteTopics(q) {
  return uniq([
    ...q.items.map(f => (f.item.id === 'o_matcha' ? 'matcha' : GROUP_TOPIC[f.item.group])),
    q.eco ? 'eco' : null,
    q.bogo ? 'bogo' : null,
  ].filter(Boolean));
}

function followChips(topics) {
  return uniq(topics.flatMap(t => t.follow || [])).slice(0, 3);
}

// ---------------------------------------------------------------
// AI 回覆整理：拿掉思考內容、取出 [[HL:...]] 標示
// ---------------------------------------------------------------
export function parseAiReply(raw) {
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '');
  const ids = [];
  text = text.replace(/\[\[\s*HL\s*[:：]\s*([^\]]*)\]\]/gi, (_, s) => {
    ids.push(...s.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean));
    return '';
  });
  text = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
  const topicIds = ids.filter(id => TOPIC_BY_ID[id]);
  const regions = uniq(ids.flatMap(id => TOPIC_BY_ID[id]?.regions || (REGIONS[id] ? [id] : [])));
  const mentioned = matchTopics(normalize(text)).filter(t => !t.low).map(t => t.id);
  return { text, regions, topics: uniq([...topicIds, ...mentioned]).slice(0, 3) };
}
