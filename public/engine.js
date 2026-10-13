// =============================================================
// 關鍵字比對、加價試算、看不懂偵測（純函式，不碰 DOM，可在 Node 測試）
// =============================================================
import { TOPICS, ITEMS, REGIONS, ECO_CUP_DISCOUNT } from './kb.js?v=202610132345';
import { DRINKS, DRINK_ALIASES, DRINK_CHOICES, NAME_FIXES, MILK_LABEL, hasMilk, refillType, hasEspresso, isChoiceDrink, isDairyFree, dietSafe, dairyUnsure, dietFor } from './drinks.js?v=202610132345';

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
  return /(買一送一|買1送1|一送一|1送1|bogo|baf|好友分享|好友券)/.test(norm);
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
    // 買一送一（BAF）：每杯分開算；送的那杯沒有加價就不折（店長 2026/10/13 說明）
    if (bogo && total <= 0) {
      lines.push({ id: 'eco', label: '自備環保杯（送的那杯沒有加價不折）', amount: 0 });
    } else {
      lines.push({ id: 'eco', label: bogo ? '自備環保杯（每杯）' : '自備環保杯', amount: -ECO_CUP_DISCOUNT });
      total -= ECO_CUP_DISCOUNT;
    }
  }
  if (bogo) notes.push('買一送一（BAF 券）：上面是每一杯的加價，兩杯分別計算；付費那杯另付飲品原價。在卡片上點「買一送一」，可以算兩杯的總價。');

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

// ---------------------------------------------------------------
// 飲品名稱模糊比對
//  1. 「加／換／升級／補」後面的加料詞先拿掉（例如「冰那堤加可可碎片」的可可碎片）
//  2. 其餘文字和每個飲品名稱比「共同片段」：相同的連續字越多越像，可容忍錯字、漏字
//  3. 只落在加料詞裡的片段不算（例如單獨說「可可碎片」不會被當成飲品）
//  4. 自動選最像的；幾杯一樣像就列出來讓人點選
// ---------------------------------------------------------------
const SOFT_NAMES = uniq([...ITEM_NAMES.map(x => x.n), ...ADDON_BLOCK.map(normalize)])
  .filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
const RE_HARD_VERB = /(?:多加|再加|另加|加|多|換成|換|升級|補)(?:(?:\d{1,2}|[一二兩三四五六七八九十]{1,3})(?:份|個|次|種|匙|下|shot))?$/;
const HARD_PREFIX = /^(升級|補|加|換|多加|再加)/;
const RE_SEP = /[\p{P}\s]/u;

function addonSpans(fixed) {
  let work = stripDrinks(fixed);
  const spans = [];
  for (const n of SOFT_NAMES) {
    let idx = work.indexOf(n);
    while (idx !== -1) {
      const before = fixed.slice(Math.max(0, idx - 6), idx);
      spans.push({ s: idx, e: idx + n.length, hard: RE_HARD_VERB.test(before) || HARD_PREFIX.test(n) });
      work = work.slice(0, idx) + blank(n) + work.slice(idx + n.length);
      idx = work.indexOf(n, idx + n.length);
    }
  }
  return spans;
}

function commonChunks(q, k) {
  const qa = [...q], ka = [...k];
  const chunks = [];
  for (;;) {
    let best = null;
    for (let i = 0; i < qa.length; i++) {
      if (qa[i] === BLANK) continue;
      for (let j = 0; j < ka.length; j++) {
        let L = 0;
        while (i + L < qa.length && j + L < ka.length && qa[i + L] !== BLANK && ka[j + L] !== '■' && qa[i + L] === ka[j + L]) L++;
        if (L >= 2 && (!best || L > best.len)) best = { qs: i, ks: j, len: L };
      }
    }
    if (!best) break;
    chunks.push(best);
    for (let x = 0; x < best.len; x++) { qa[best.qs + x] = BLANK; ka[best.ks + x] = '■'; }
  }
  return chunks.sort((a, b) => a.qs - b.qs);
}

function scoreKey(q, fixed, k, soft) {
  const ch = commonChunks(q, k);
  if (!ch.length) return null;
  const regions = [];
  for (const c of ch) {
    const last = regions[regions.length - 1];
    const gap = last ? fixed.slice(last.e, c.qs) : '';
    if (last && c.qs - last.e <= 1 && !RE_SEP.test(gap)) { last.e = c.qs + c.len; last.chunks.push(c); }
    else regions.push({ s: c.qs, e: c.qs + c.len, chunks: [c] });
  }
  const kept = regions.filter(r => !soft.some(sp => r.s >= sp.s && r.e <= sp.e));
  const chunks = kept.flatMap(r => r.chunks);
  const matched = chunks.reduce((n, c) => n + c.len, 0);
  if (matched < 2) return null;
  const exact = chunks.length === 1 && matched === k.length;
  if (!exact && matched < 3) return null;
  return { matched, cov: matched / k.length, exact, chunks, s: kept[0].s, e: kept[kept.length - 1].e, keyLen: k.length, key: k };
}

function rankCandidates(q, fixed, soft) {
  const best = new Map();
  for (const { k, base } of DRINK_KEYS) {
    if (!base) continue;
    const r = scoreKey(q, fixed, k, soft);
    if (!r) continue;
    const prev = best.get(base);
    if (!prev || r.matched > prev.matched || (r.matched === prev.matched && r.cov > prev.cov)) best.set(base, { ...r, base });
  }
  return [...best.values()].sort((a, b) =>
    b.matched - a.matched || b.cov - a.cov || (b.exact - a.exact) || a.keyLen - b.keyLen || a.s - b.s);
}

export function findDrinks(fixed) {
  const spans = addonSpans(fixed);
  const soft = spans.filter(sp => !sp.hard);
  let q = [...fixed].map((c, i) => (spans.some(sp => sp.hard && i >= sp.s && i < sp.e) ? BLANK : c)).join('');
  const found = [];
  for (let round = 0; round < 4; round++) {
    const cands = rankCandidates(q, fixed, soft);
    if (!cands.length) break;
    const top = cands[0];
    if (round > 0 && !(top.exact || top.cov >= 0.6)) break;
    const overlap = cands.slice(1).filter(c => c.s < top.e && c.e > top.s);
    const ties = top.exact ? [] : overlap.filter(c => c.matched === top.matched);
    const official = top.exact && OFFICIAL.has(top.key);
    found.push({ ...top, idx: top.s, ties, alts: overlap, official });
    const qa = [...q];
    for (const c of top.chunks) for (let x = 0; x < c.len; x++) qa[c.qs + x] = BLANK;
    q = qa.join('');
  }
  return found.sort((a, b) => a.s - b.s);
}

// 官方品名（去掉冰／熱）：打完整品名就不再提供其他候選
const OFFICIAL = new Set([...BASES.keys()].map(normalize));

// 只打了部分名稱（例如「可可」「蛋白雲朵」）：列出所有名稱含這段字的飲品
const RE_FEE_Q = /(加錢|要錢|收費|費用|多少錢|價錢|價格|漲價|多少|貴|免費|可以加|能加|加幾|怎麼算|規則|是什麼|什麼意思)/;
export function searchDrinks(fixed) {
  if (RE_FEE_Q.test(fixed)) return [];
  const core = fixed.replace(/[\p{P}\s]/gu, '').replace(/^(我要|請問|給我|幫我|有沒有|有)/, '')
    .replace(/(的飲料|飲料|系列|有哪些|哪些|呢|嗎|啊)$/g, '').replace(/^[冰熱溫]/, '');
  if (core.length < 2 || core.length > 6) return [];
  if (SOFT_NAMES.includes(core)) return [];
  const hits = [];
  for (const base of BASES.keys()) {
    const keys = [base, ...(DRINK_ALIASES[base] || [])].map(normalize);
    if (keys.some(k => k.includes(core))) hits.push(base);
  }
  return hits.map(base => ({ base, core, start: fixed.indexOf(core) }));
}

// 用某一杯取代模糊比對到的那段字，例如「巧克力可可碎片加…」→「經典巧克力，可可碎片加…」
function rewriteWith(fixed, c) {
  const used = new Set(c.chunks.flatMap(ch => Array.from({ length: ch.len }, (_, x) => ch.qs + x)));
  const mid = [...fixed.slice(c.s, c.e)].filter((_, i) => !used.has(c.s + i)).join('');
  const rest = (mid + fixed.slice(c.e)).replace(/^[,，、\s]+/, '');
  return fixed.slice(0, c.s) + c.base + (rest ? '，' + rest : '');
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

// 卡片上的附註：店內菜單的標示優先
export function drinkInfo(d) {
  return [
    d.offMenu ? '店內菜單（2026/10/12–11/2）未列，供應以門市為準' : '',
    d.nocustom ? '不提供客製化服務' : d.noicecustom ? '不提供冰塊客製化服務' : '',
    d.limited || '',
    d.upgrade || '',
    d.caffeine || '',
    d.decaf ? '無咖啡因飲品（器具共用，可能有些許咖啡因殘留）' : '',
    d.allergen || '',
    d.m === 'unknown' ? '菜單沒有寫是否含奶，請洽門市夥伴' : '',
    d.note || '',
    d.season ? '季節限定，依門市供應為準' : '',
  ].filter(Boolean).join('；');
}

function drinkSummary(pk) {
  const d = pk.drink;
  const sizes = d.sz ? d.sz.map(([l, p]) => `${l} $${p}`) : d.p.map((p, i) => (p == null ? null : `${SIZE_LABEL[i]} $${p}`)).filter(Boolean);
  const altPrice = pk.alt && pk.alt.p.join() !== d.p.join();
  return {
    name: pk.tempKnown ? d.n : `${baseName(d.n)}（${pk.alt ? '冰／熱' : d.n}）`.replace(/（(.+)）$/, (m, x) => (x === d.n ? '' : `（${x}）`)),
    milk: MILK_LABEL[d.m],
    hasMilk: hasMilk(d),
    comp: d.c,
    prices: sizes.join('／') || '價格請洽門市',
    altNote: altPrice ? `${pk.alt.n}：${pk.alt.p.map((p, i) => (p == null ? null : `${SIZE_LABEL[i]} $${p}`)).filter(Boolean).join('／')}` : '',
    info: drinkInfo(d),
  };
}

// 把認得的部分（加料、杯型、甜度、環保杯、口語）拿掉後，剩下的就是看不懂的詞
const RE_FILLER = new RegExp([
  RE_SIZE.source,
  '(?:\\d+|[一二兩三四五六七八九十半]+)(?:份|個|次|種|匙|下|杯|shot)',
  '(?:糖漿|糖)?(?:\\d|[一二兩三四五六七八九十半])下(?:糖漿|糖)?|半糖|微糖|少糖|減糖|無糖|去糖|不要糖|不加糖|少甜|微甜|無甜',
  '環保杯|自備杯|自帶杯|隨行杯|自備容器|保溫杯|自己的杯|帶杯|環保|買一送一|買1送1|一送一|1送1|好友分享|好友券|好友|bogo|baf|券|卷',
  '使用|都|用|各|自備|自帶|帶',
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
  // 「冰搖茶」「冰搖檸檬茶」：店內菜單一列有紅茶、果茶兩種 → 讓人選
  for (const [alias, bases] of Object.entries(DRINK_CHOICES)) {
    const at = fixed.indexOf(alias);
    if (at === -1 || bases.some(b => fixed.includes(b))) continue;
    return {
      kind: 'choose',
      said: alias,
      options: bases.map(b => ({ ...drinkSummary(pickVariant(b, fixed, at)), text: fixed.slice(0, at) + b + fixed.slice(at + alias.length) })),
    };
  }
  const hits = findDrinks(fixed);
  if (!hits.length) {
    const found = searchDrinks(fixed);
    if (!found.length) return null;
    if (found.length === 1) return buildOrder(fixed.replace(found[0].core, found[0].base));
    const at = found[0].start;
    return {
      kind: 'choose',
      said: found[0].core,
      options: found.slice(0, 8).map(f => ({
        ...drinkSummary(pickVariant(f.base, fixed, at)),
        text: fixed.slice(0, at) + f.base + fixed.slice(at + f.core.length),
      })),
    };
  }
  const picks = hits.map(h => ({ ...pickVariant(h.base, fixed, h.idx), hit: h }));
  if (picks.length > 1) {
    return { kind: 'multi', drinks: picks.slice(0, 4).map(drinkSummary) };
  }

  const h0 = hits[0];
  const said = fixed.slice(h0.s, h0.e);
  // 幾杯一樣像 → 列出來讓人選
  if (h0.ties.length) {
    return {
      kind: 'choose',
      said,
      options: [h0, ...h0.ties].slice(0, 8).map(c => ({
        ...drinkSummary(pickVariant(c.base, fixed, c.s)),
        text: rewriteWith(fixed, c),
      })),
    };
  }

  const pk = picks[0];
  const d = pk.drink;
  const dn = pk.tempKnown ? d.n : baseName(d.n);
  const itemsArr = [...fixed];
  for (const h of hits) for (const c of h.chunks) for (let x = 0; x < c.len; x++) itemsArr[c.qs + x] = BLANK;
  let itemsText = itemsArr.join('');
  const alts = [];
  // 「冰美式」「熱美式」：常用簡稱加上冷熱，就是那一杯，不再列其他候選（減少畫面資訊）
  const plainAlias = h0.exact && pk.tempKnown && (DRINK_ALIASES[h0.base] || []).map(normalize).includes(said);
  if (!h0.official && !plainAlias) {
    const seen = new Set([h0.base]);
    for (const c of h0.alts) {
      if (seen.has(c.base)) continue;
      seen.add(c.base);
      alts.push({ base: c.base, text: rewriteWith(fixed, c), s: c.s });
    }
    // 名稱裡也有這段字的其他飲品（例如「美式」→ 雲朵泡泡美式咖啡）
    for (const base of BASES.keys()) {
      if (seen.has(base)) continue;
      const keys = [base, ...(DRINK_ALIASES[base] || [])].map(normalize);
      if (said.length >= 2 && keys.some(k => k.includes(said))) {
        seen.add(base);
        alts.push({ base, text: fixed.slice(0, h0.s) + base + fixed.slice(h0.e), s: h0.s });
      }
    }
  }
  const match = {
    said,
    fuzzy: !h0.exact || alts.length > 0,
    alts: alts.slice(0, 4).map(a => ({
      name: drinkSummary(pickVariant(a.base, fixed, a.s)).name.replace(/（.*$/, ''),
      text: a.text,
    })),
  };

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
  // 店內菜單：確保最佳風味，不提供客製化服務 → 加料、換奶、冰量、甜度都不行（環保杯、杯型照常）
  if (d.nocustom && (items.length || sweet)) {
    notes.push(`店內菜單註明：${dn}確保最佳風味，不提供客製化服務。`);
    const lines0 = items.map(f => ({ id: f.item.id, label: f.item.label, amount: null, blocked: true, status: '不提供' }));
    if (sweet) lines0.push({ id: 'sweet', label: `調整甜度（${sweet}）`, amount: null, blocked: true, status: '不提供' });
    lines.push(...lines0);
  }

  // ---- 濃縮咖啡：先看這杯本身有沒有濃縮 ----
  const up = d.nocustom ? null : items.find(f => f.item.id === 'esp_upgrade');
  const ex = d.nocustom ? null : items.find(f => f.item.id === 'esp_extra');
  const decaf = d.nocustom ? null : items.find(f => f.item.id === 'esp_decaf');
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

  for (const f of (d.nocustom ? [] : items)) {
    const it = f.item;
    if (it.group === 'esp') continue;
    let label = it.label;
    let amount = it.price;
    const qty = f.qty || 1;

    if (it.id === 'ice_less') {
      if (d.t === 'hot') { notes.push('熱飲沒有冰塊，不需要調整冰量。'); continue; }
      if (d.noicecustom) {
        notes.push(`店內菜單註明：${dn}確保最佳風味，不提供冰塊客製化服務。`);
        lines.push({ id: 'ice_less', label: (itemsText.match(/少冰|去冰|微冰|不要冰|無冰/) || ['少冰／去冰'])[0], amount: null, blocked: true, status: '不提供' });
        continue;
      }
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
      } else if (d.noicecustom) {
        amount = null; label = asMilk ? '補牛奶' : '補飲料';
        notes.push(`店內菜單註明：${dn}不提供冰塊客製化服務，所以也沒有少冰／去冰後補滿。`);
        lines.push({ id: lineId, label, amount, blocked: true, status: '不提供' });
        continue;
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

  if (sweet && !d.nocustom) {
    const sauceNote = d.sauce ? `這杯的甜味來自${d.sauce.split('為維持')[0]}，官網註明為維持風味最少 1 匙。` : '';
    if (d.sweetAdj) {
      lines.push({ id: 'sweet', label: `調整甜度（${sweet}）`, amount: null, status: '可減量' });
      notes.push(`店內菜單標示這杯「● 可調整甜度」：原飲品甜度可依個人喜好提供減量服務；要額外加糖漿或配料，才依額外添加 +$15 計價。${sauceNote}`);
    } else {
      lines.push({ id: 'sweet', label: `調整甜度（${sweet}）`, amount: null });
      notes.push(`店內菜單沒有在這杯標示「● 可調整甜度」，能不能調整請以門市為準。${sauceNote}`);
    }
    extraRegions.push('sweet_btn');
  }

  // 只說少冰／去冰、沒說要補：不算錢，但立刻反問要不要補
  let ask = null;
  if (iceLess && !refill && !d.nocustom && !d.noicecustom) {
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
      tips.push(`這杯${milky || d.m === 'unknown' ? '' : '不含奶，'}只${iceWord}不加價；能不能補飲料請以門市為準（補飲料 +$15）。`);
    }
  }

  if (eco) lines.push({ id: 'eco', label: '自備環保杯', amount: -ECO_CUP_DISCOUNT });

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
  const sizeTotals = d.sz
    ? d.sz.map(([label, p]) => ({ label, total: p + addTotal }))
    : d.p.map((p, i) => (p == null ? null : { label: SIZE_LABEL[i], total: p + addTotal })).filter(Boolean);

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
    basePrice, lines, addTotal, sizeTotals, notes, tips, ask, iceWord, match,
    eco, baf: bogo, // 點單裡提到買一送一／BAF → 卡片直接打開 BAF 試算
    // 冰飲、可補、還沒指定冰量 → 卡片上給「正常冰／少冰／去冰」按鈕
    iceSelectable: d.t === 'iced' && !iceLess && !refill && !d.nocustom && !d.noicecustom && (rt === 'milk' || rt === 'tea'),
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
  if (o.kind === 'choose') {
    return [`「${o.said}」有幾杯很像，你是指哪一杯？`, ...o.options.map(s => `- ${s.name}：${s.milk}｜${s.prices}`)].join('\n');
  }
  if (o.kind === 'multi') {
    return o.drinks.map(s => `${s.name}：${s.milk}｜${s.comp}｜${s.prices}`).join('\n');
  }
  const s = o.summary;
  const out = [`${s.name}：${s.milk}｜${s.comp}`, `價格：${s.prices}`];
  if (o.match?.fuzzy) out.push(`（依「${o.match.said}」判斷是這杯${o.match.alts.length ? `；也可能是：${o.match.alts.map(a => a.name).join('、')}` : ''}）`);
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
// 顧客在澄清上一題（「我意思是…」「我是問…」）：前一個回答沒答到，不是看不懂
const RE_CLARIFY = /我的?意思是|我是說|我是問|我要問的是|我問的是|我想問的是|不是問這個|不是這個意思|不是我要問的|你誤會|答非所問|我不是問/;
export function isClarify(text) {
  return RE_CLARIFY.test(normalize(text));
}
export function isConfused(norm) {
  if (RE_CLARIFY.test(norm)) return false;
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

  // 「用BAF券」「買一送一呢」：沿用上一杯，打開買一送一試算
  if (state.lastOrder && detectBogo(norm)
    && !norm.replace(RE_BAF_CMD, '').replace(/[呢嗎吧啊的了喔?？!！。,，、\s]|多少錢?|算一下|幫我算|這杯|那杯|一樣/g, '')) {
    const o = buildOrder(state.lastOrder);
    if (o?.kind === 'drink') {
      o.baf = true;
      return {
        source: 'local', text: orderToText(o), order: o, orderText: state.lastOrder,
        topics: ['bogo'], itemRegions: o.regions, chips: ['買一送一可以用環保杯嗎？'], pending: null,
      };
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
    if (order.kind === 'choose') {
      return {
        source: 'local',
        text: orderToText(order),
        order,
        topics: [],
        chips: ['哪些飲料有牛奶？', '有哪些新收費？'],
      };
    }
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
      faq: specific.map(t => t.id), // 關鍵字找到的預寫答案：有 AI 時會先做語意確認
      itemRegions: quote.regions,
      chips: [...(hasRegions ? ['看不懂，標給我看'] : []), ...followChips(specific)].slice(0, 3),
      markable: !!hasRegions,
    };
  }

  if (topics.length) {
    const t = topics[0];
    return { source: 'local', text: t.answer, topics: [], faq: [t.id], chips: t.follow };
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
// AI 提到的飲品 → 依官網資料產生卡片（價格不採用 AI 寫的數字）
export function drinkRefs(names, aiText) {
  const out = [];
  const seen = new Set();
  const add = d => { if (d && !seen.has(d.n)) { seen.add(d.n); out.push(d); } };
  for (const raw of names) {
    const n = normalize(fixNames(raw));
    add(DRINKS.find(d => normalize(d.n) === n) || (BASES.get(baseName(n)) || [])[0]);
  }
  if (!out.length) {
    let work = normalize(fixNames(aiText));
    const keys = [
      ...DRINKS.map(d => [normalize(d.n), d]),
      ...[...BASES.entries()].map(([b, vs]) => [normalize(b), vs.find(v => v.t === 'iced') || vs[0]]),
    ].filter(([k]) => k.length >= 3).sort((a, b) => b[0].length - a[0].length);
    for (const [k, d] of keys) {
      if (!work.includes(k)) continue;
      add(d);
      work = work.split(k).join(BLANK.repeat(k.length));
    }
  }
  return out.slice(0, 4).map(refCard);
}
function refCard(d) {
  const s = drinkSummary({ drink: d, alt: null, tempKnown: true });
  return { name: s.name, milk: s.milk, hasMilk: s.hasMilk, comp: s.comp, prices: s.prices, text: d.n, dairyFree: isDairyFree(d) };
}

// 已知 AI 容易講錯的飲品知識：整句拿掉，再補上正確說法
const FACT_FIXES = [
  {
    wrong: x => /冷萃|氮氣/.test(x) && /濃縮/.test(x)
      && !/不是|不用|不經|並非|而是|不同|沒有|不含|加(一|兩|二|1|2)?份?濃縮|加濃縮|升級|特選|\+\s?\$|＋\s?\$|\$\s?15/.test(x),
    fact: '冷萃咖啡是用冷水長時間浸泡咖啡粉萃取的，不是用濃縮咖啡做的；美式咖啡才是濃縮咖啡加水。',
  },
  {
    // 同一個子句裡「冰美式」配「熱水」才算錯（「熱美式加熱水，冰美式加冷水」是對的）
    wrong: x => x.split(/[,，、;；()（）]/).some(c => /冰美式/.test(c) && /熱水/.test(c) && !/冷水/.test(c)),
    fact: '冰美式咖啡是濃縮咖啡加冷水和冰塊。',
  },
];
export function fixFacts(text) {
  const facts = [];
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const kept = line
      .split(/(?<=[。！？!?；;])/)
      .filter(sent => {
        const f = FACT_FIXES.find(ff => ff.wrong(normalize(sent)));
        if (f && !facts.includes(f.fact)) facts.push(f.fact);
        return !f;
      })
      .join('');
    // 整行都被拿掉就不留空行（只剩「- 」也算）
    if (line.trim() && !kept.replace(/^\s*([-•*]|\d+[.、])\s*/, '').trim()) continue;
    out.push(kept);
  }
  let res = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (facts.length) res += (res ? '\n' : '') + facts.join('\n');
  return res;
}

// 拿掉 AI 自己寫的飲品價格（加價金額 +$15、−$10 保留）
function stripDrinkPrices(text) {
  return text
    .split('\n')
    .filter(line => !/(價格|售價|原價)\s*[:：]/.test(line))
    .join('\n')
    .replace(/(短杯|中杯|大杯|特大杯)?\s*(?<![+＋−\-])\$\s?(\d{2,3})/g, (m, size, n) => (Number(n) >= 80 ? '' : m))
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function parseAiReply(raw) {
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '');
  const drinkNames = [];
  text = text.replace(/\[\[\s*DRINKS\s*[:：]\s*([^\]]*)\]\]/gi, (_, s) => {
    drinkNames.push(...s.split(/[,，、]+/).map(x => x.trim()).filter(Boolean));
    return '';
  });
  const ids = [];
  text = text.replace(/\[\[\s*HL\s*[:：]\s*([^\]]*)\]\]/gi, (_, s) => {
    ids.push(...s.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean));
    return '';
  });
  text = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
  const topicIds = ids.filter(id => TOPIC_BY_ID[id]);
  const regions = uniq(ids.flatMap(id => TOPIC_BY_ID[id]?.regions || (REGIONS[id] ? [id] : [])));
  const mentioned = matchTopics(normalize(text)).filter(t => !t.low).map(t => t.id);
  text = fixFacts(text);
  const drinks = drinkRefs(drinkNames, text);
  if (drinks.length) text = stripDrinkPrices(text).trim();
  return { text, regions, topics: uniq([...topicIds, ...mentioned]).slice(0, 3), drinks };
}

// ---------------------------------------------------------------
// 不含奶／牛奶過敏：檢查 AI 的推薦，含奶的一律不能出現
// ---------------------------------------------------------------
export { dietFor };
const RE_NEGATED = /(不|無|沒|免|零|非)(能|可|用)?(有|含|加|放|要|喝)?(加)?(牛|鮮)?(奶|乳)(製品)?(?![油泡])/g;
const RE_WARN = /(含|有)(牛|鮮|椰|燕麥|豆)?(奶|乳)|乳製品|避開|避免|不建議|不適合|不要選|不能喝|別選|要小心|不推薦|請注意/;
const RE_MILK_WORD = /那堤|摩卡|瑪奇朵|歐蕾|卡布奇諾|巧克力|奶茶|馥列白|密斯朵|馥洛特|阿法奇朵|星冰樂|鮮奶|牛奶|奶泡|奶油|冰淇淋|燕麥奶|椰奶|豆奶|雲朵冰搖/;
const RE_VARIANT_PAREN = /\((無|不加|去|不含|沒有|去掉|免)(牛|鮮)?奶\)/;
const RE_VARIANT = /(要求|請夥伴|跟夥伴|告訴夥伴|可以|改成|改為|換成|選擇|點)[^,，。；;\n]{0,8}(不加|不要|去掉|拿掉|去|無|免)(牛|鮮)?奶(?![油泡])/g;
const SAFE_KEYS = DRINKS.filter(isDairyFree).flatMap(d => [normalize(d.n), normalize(baseName(d.n))])
  .filter(k => k.length >= 3).sort((a, b) => b.length - a.length);
const MILK_KEYS = DRINKS.filter(d => !isDairyFree(d)).flatMap(d => [normalize(d.n), normalize(baseName(d.n))])
  .filter(k => k.length >= 3).sort((a, b) => b.length - a.length);

// 「對牛奶過敏」「乳糖不耐」是在說需求，不算提到含奶飲品
const RE_NEED = /(對)?(牛|鮮)?奶(類|製品)?(過敏|不耐)|乳糖不耐|乳製品過敏/g;
function dietLineBad(raw) {
  const line = normalize(fixNames(raw)).replace(RE_NEED, BLANK);
  if (!line) return false;
  if (RE_VARIANT_PAREN.test(line)) return true;
  for (const m of line.matchAll(RE_VARIANT)) {
    const before = line.slice(Math.max(0, m.index - 12), m.index);
    if (!/不要|別|不建議|避免|不可|不能|勿/.test(before)) return true;
  }
  let rest = line;
  for (const k of SAFE_KEYS) rest = rest.split(k).join(BLANK);
  rest = rest.replace(RE_NEGATED, BLANK);
  if (RE_WARN.test(rest)) return false;
  return RE_MILK_WORD.test(rest) || MILK_KEYS.some(k => rest.includes(k));
}
export function dietProblems(text) {
  return String(text || '').split('\n').filter(dietLineBad);
}

// 拿掉有問題的行；編號項目（1. 2. 3.）被拿掉時，底下的說明行一起拿掉
const RE_NUM_ITEM = /^\s*(\*\*)?\d+[.、)）]/;
function repairDietText(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text || '').split('\n')) {
    if (RE_NUM_ITEM.test(line) || !line.trim()) skipping = false;
    if (skipping) continue;
    if (dietLineBad(line)) { skipping = RE_NUM_ITEM.test(line); continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const DIET_GROUPS = [
  ['咖啡', d => (d.g === 'esp' || d.g === 'brew')],
  ['冷萃（不能補）', d => d.g === 'cb'],
  ['茶', d => d.g === 'tea'],
  ['星沁爽、果汁', d => d.g === 'ref' || d.g === 'juice'],
];
const DIET_PICKS = ['冰美式咖啡', '冷萃咖啡', '冰搖檸檬紅茶', '芒果火龍果檸檬星沁爽'];

// AI 不可用或推薦了含奶飲品時，改用官網成分整理的固定答案
export function dietFallback(diet) {
  const ok = DRINKS.filter(dietSafe);
  const lines = DIET_GROUPS.map(([label, f]) => {
    const names = uniq(ok.filter(f).map(d => baseName(d.n)));
    return names.length ? `- ${label}：${names.join('、')}` : '';
  }).filter(Boolean);
  const reminder = diet === 'allergy'
    ? '含奶的飲品請不要用「不加奶」的方式點，醬料、奶泡也可能有乳製品，請直接選不含奶的品項。'
      + (DRINKS.some(dairyUnsure) ? '「雲朵泡泡美式」官網沒有列出奶類，過敏的話請先向夥伴確認。' : '')
    : '名字有「那堤、歐蕾、瑪奇朵、摩卡、巧克力、卡布奇諾」和大部分星冰樂都含奶，想喝不含奶的請直接選不含奶的品項。';
  const text = [
    diet === 'allergy' ? '對牛奶過敏、乳糖不耐的話，可以從這些**不含奶**的飲品挑（依官網成分）：' : '這些飲品**不含奶**（依官網成分）：',
    ...lines,
    diet === 'allergy' ? '名字有「那堤、歐蕾、瑪奇朵、摩卡、巧克力、卡布奇諾」和大部分星冰樂都含奶；椰奶款星沁爽有椰奶。' : '椰奶款星沁爽有椰奶。',
    reminder,
  ].join('\n');
  return { text, reminder, refs: DIET_PICKS.map(n => DRINKS.find(d => d.n === n)).filter(Boolean).map(refCard) };
}

// 檢查 AI 對「不含奶／過敏」推薦題的回答：
//   沒問題 → 照用；少數幾行有問題 → 拿掉那幾行並補提醒；救不回來 → 換成固定答案
export function guardDietReply(diet, p, { inherited = false } = {}) {
  const fb = dietFallback(diet);
  const safeRefs = (p.drinks || []).filter(r => r.dairyFree && dietSafe(DRINKS.find(d => d.n === r.text) || {}));
  // 沿用上一句需求的短追問可能根本不是在問飲品，就不硬塞預設飲品
  const refs = safeRefs.length || inherited ? safeRefs : fb.refs;
  const problems = dietProblems(p.text);
  if (!problems.length && p.text.trim()) return { text: p.text, refs, status: 'ok', problems };
  const fixed = repairDietText(p.text);
  const norm = normalize(fixNames(fixed));
  // 拿掉後至少還有兩杯不含奶的推薦才保留 AI 的回答
  const kept = uniq(DRINKS.filter(dietSafe)
    .filter(d => norm.includes(normalize(d.n)) || norm.includes(normalize(baseName(d.n))))
    .map(d => baseName(d.n)));
  if (kept.length >= 2) {
    return { text: `${fixed}\n${fb.reminder}`, refs, status: 'repaired', problems };
  }
  const more = fb.refs.filter(r => !safeRefs.some(x => x.text === r.text));
  return { text: fb.text, refs: [...safeRefs, ...more].slice(0, 4), status: 'replaced', problems };
}

// ---------------------------------------------------------------
// 試算（卡片用）：單杯、買一送一券（BAF，bring a friend）
//   環保杯鐵律：每一杯用環保杯就折 $10（單杯、多杯、買一送一都一樣）；一杯最多折到 $0
//   買一送一（券面＋店長 2026/10/13 說明）：
//   - 兩杯冷熱一致、大小一致；現場點、現場一次領取
//   - 一杯付飲品原價，另一杯飲品免費；兩杯的客製化都照規則收費（換燕麥奶／杏仁奶兩杯各 +$20）
//   - 送的那杯沒有加價時是 $0，不會再折（店長：沒付錢就不會再扣 10 元）
//   - 兩杯不同時，以價格較低的那杯為贈送杯（券面沒寫，待店長確認）
//   環保杯數量先算在付費那杯，再算送的那杯
// ---------------------------------------------------------------
const tempOf = d => (d.t === 'hot' ? 'hot' : (d.t === 'iced' || d.t === 'blended') ? 'cold' : null);
export const sizesOf = d => (d.sz ? d.sz.map(([label, p]) => ({ label, p }))
  : d.p.map((p, i) => ({ label: SIZE_LABEL[i], p })).filter(x => x.p != null));
export const cupAdd = o => o.lines.filter(l => l.id !== 'eco' && typeof l.amount === 'number').reduce((s, l) => s + l.amount, 0);
const cupName = o => {
  const extras = o.lines.filter(l => l.id !== 'eco' && typeof l.amount === 'number' && l.amount !== 0).map(l => l.label.replace(/（.*）$/, ''));
  return `${o.summary.name.replace(/（.*）$/, '')}${extras.length ? `＋${extras.join('、')}` : ''}`;
};
const ecoOff = (sub, eco) => (eco ? Math.min(ECO_CUP_DISCOUNT, Math.max(0, sub)) : 0);

// 文字裡提到幾個環保杯（「環保杯」→1；「兩杯都用環保杯」「2個環保杯」→2）
export function ecoCountFrom(text) {
  const t = normalize(text);
  if (!detectEco(t)) return 0;
  const m = t.match(/(\d|[一二兩三四五])(個|杯|只)?(都)?(用|帶|是)?環保杯|環保杯(\d|[一二兩三四五])(個|杯)/);
  if (m) return parseNum(m[1] || m[5]) || 1;
  return /都(用|帶|是)?環保杯/.test(t) ? 2 : 1;
}

// 單杯：每個杯型的合計
export function singleQuote(o, { eco = 0 } = {}) {
  const add = cupAdd(o);
  return sizesOf(o.drink).map(({ label, p }) => {
    const off = ecoOff(p + add, eco >= 1);
    return { label, base: p, add, ecoOff: off, total: p + add - off };
  });
}

export function bafQuote(o1, o2, { eco = 0 } = {}) {
  if (!o1 || o1.kind !== 'drink' || !o2 || o2.kind !== 'drink') return { ok: false, error: '兩杯都要是菜單上的飲品。' };
  const d1 = o1.drink, d2 = o2.drink;
  const t1 = tempOf(d1), t2 = tempOf(d2);
  if (t1 && t2 && t1 !== t2) return { ok: false, error: '買一送一的兩杯要冷熱一致。' };
  if (o1.sizeIdx != null && o2.sizeIdx != null && o1.sizeIdx !== o2.sizeIdx) return { ok: false, error: '買一送一的兩杯大小要一致。' };
  const want = o1.sizeLabel || o2.sizeLabel;
  const s2 = new Map(sizesOf(d2).map(x => [x.label, x.p]));
  const sizes = sizesOf(d1).filter(x => s2.has(x.label) && (!want || x.label === want));
  if (!sizes.length) return { ok: false, error: want ? `這兩杯沒有共同的${want}。` : '這兩杯沒有相同的杯型。' };
  const add1 = cupAdd(o1), add2 = cupAdd(o2);
  const rows = sizes.map(({ label, p: b1 }) => {
    const b2 = s2.get(label);
    const freeIs2 = b2 <= b1;
    const mk = (o, base, add, free) => ({ name: cupName(o), role: free ? '送' : '付費', base: free ? 0 : base, listBase: base, add });
    const paid = freeIs2 ? mk(o1, b1, add1, false) : mk(o2, b2, add2, false);
    const gift = freeIs2 ? mk(o2, b2, add2, true) : mk(o1, b1, add1, true);
    // 環保杯：先算付費那杯，再算送的那杯；一杯最多折到 $0
    paid.ecoOff = ecoOff(paid.base + paid.add, eco >= 1);
    gift.ecoOff = ecoOff(gift.add, eco >= 2);
    paid.pay = paid.base + paid.add - paid.ecoOff;
    gift.pay = gift.add - gift.ecoOff;
    const cups = freeIs2 ? [paid, gift] : [gift, paid];
    const total = paid.pay + gift.pay;
    const original = b1 + add1 + b2 + add2 - Math.min(eco, 2) * ECO_CUP_DISCOUNT;
    return { label, cups, total, original, saved: original - total };
  });
  const notes = [];
  const gift = rows[0].cups.find(c => c.role === '送');
  if (eco >= 2 && gift.add === 0) notes.push('送的那杯 $0，第 2 個環保杯沒有可以折的金額。');
  if (d1.n !== d2.n || add1 !== add2) notes.push('兩杯不同時，以價格較低的那杯為贈送杯，實際以門市結帳為準。');
  if (o1.lines.concat(o2.lines).some(l => /^milk_(oat|almond)$/.test(l.id) && l.amount > 0)) {
    notes.push('券面規定：換燕麥奶或杏仁奶，兩杯皆需分別加價。');
  }
  return { ok: true, rows, notes, sizeKnown: !!want };
}

// 「用BAF券」：上一杯的點單沿用到兩杯
export const RE_BAF_CMD = /(用|使用|有)?(baf|買一送一|買1送1|好友分享|好友)(券|卷|卡)?/;
