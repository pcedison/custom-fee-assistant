// =============================================================
// 關鍵字比對、加價試算、看不懂偵測（純函式，不碰 DOM，可在 Node 測試）
// =============================================================
import { TOPICS, ITEMS, REGIONS, ECO_CUP_DISCOUNT } from './kb.js';

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
    : { n: normalize(n.n), add: !!n.add, it })))
  .sort((a, b) => b.n.length - a.n.length);
const ALL_NAMES = ITEM_NAMES.map(x => x.n).filter(n => n.length >= 2);

const VERB = '(?:多加|再加|另加|加|多|要|換成|換|升級|來|點)';
const UNIT = '(?:份|個|次|種|shot)';
const RE_QTY_BEFORE = new RegExp(NUM + UNIT + '(?:的)?$');
const RE_VERB_BEFORE = new RegExp(VERB + '(?:' + NUM + UNIT + ')?$');
const RE_NEG_BEFORE = /(不|沒|沒有|免|別|勿|不用|不要)(加|要|用|補)?$/;
const RE_QTY_AFTER = new RegExp('^(?:多加|再加|加|要|來)?' + NUM + UNIT);
const RE_X_AFTER = /^[x×*](\d{1,2})/;

function startsWithItem(rest) {
  return ALL_NAMES.some(n => rest.startsWith(n));
}

export function extractItems(norm) {
  let work = stripDrinks(norm);
  const found = new Map();
  for (const { n, add, it } of ITEM_NAMES) {
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
      const hasVerb = RE_VERB_BEFORE.test(before);
      if (!negated && (!add || hasVerb || qty != null)) {
        const prev = found.get(it.id);
        found.set(it.id, { item: it, qty: Math.max(prev?.qty || 0, qty || 1), askedQty: qty });
      }
      work = work.slice(0, idx) + blank(n) + work.slice(idx + n.length);
      idx = work.indexOf(n, idx + n.length);
    }
  }
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
  const norm = normalize(input);
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
