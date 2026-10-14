// =============================================================
// 聊天介面
// =============================================================
import { IMAGE, WELCOME_CHIPS, EFFECTIVE_DATE, BAF_RULES } from './kb.js?v=202610140602';
import { localReply, parseAiReply, money, matchTopics, normalize, buildOrder, fixHomophones, TOPIC_BY_ID, orderToText, dietFor, guardDietReply, dietFallback, isClarify, bafQuote, singleQuote, sizesOf, ecoCountFrom } from './engine.js?v=202610140602';
import { renderHighlight, loadMenuImage } from './highlight.js?v=202610140602';

const MENU_SRC = window.__MENU_SRC || IMAGE.src;
// AI 後端位置：可在頁面上用 window.APP_CONFIG = { apiUrl: '...' } 指定。
// GitHub Pages 沒有後端，預設關閉 AI；部署到 Cloudflare Pages 時使用 /api/chat。
const API_URL = (window.APP_CONFIG && 'apiUrl' in window.APP_CONFIG)
  ? window.APP_CONFIG.apiUrl
  : (location.hostname.endsWith('github.io') ? null : '/api/chat');
const MARK_CHIP = '看不懂，標給我看';
// 網址加 ?debug=1：訊息下方顯示語意比對分數（調整例句、門檻用）
const DEBUG = new URLSearchParams(location.search).has('debug');

// ---------- 匿名使用統計：只送到自己的 Worker（/api/e），GitHub Pages 不送 ----------
// 網址加 #nostats：這台裝置以後不列入統計（自己測試用）；#stats 恢復
const STATS_URL = API_URL === '/api/chat' ? '/api/e' : null;
const NO_STATS = 'cfa-nostats';
if (location.hash === '#nostats' || location.hash === '#stats') {
  try { location.hash === '#nostats' ? localStorage.setItem(NO_STATS, '1') : localStorage.removeItem(NO_STATS); } catch { /* 無痕模式 */ }
  history.replaceState(null, '', location.pathname + location.search);
}
function track(payload) {
  if (!STATS_URL) return;
  try { if (localStorage.getItem(NO_STATS) === '1') return; } catch { /* 無痕模式照常統計 */ }
  try {
    const body = JSON.stringify(payload);
    const sent = navigator.sendBeacon && navigator.sendBeacon(STATS_URL, new Blob([body], { type: 'application/json' }));
    if (!sent) fetch(STATS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch { /* 統計失敗不影響使用 */ }
}
const baseDrink = n => String(n || '').replace(/（.*$/, '');
function trackAsk(r, userText, from) {
  const o = r?.order;
  // 追問沿用上一杯：不重複計入飲品排行
  const drinks = r?.followup ? []
    : o?.kind === 'drink' ? [o.drink?.n || o.summary?.name]
      : o?.kind === 'multi' ? o.drinks.map(d => d.name)
        : (r?.refs || []).map(d => d.name);
  // 單杯試算的問題類型只算實際點到的加價項目（預設的「哪些飲品有奶」不算）
  const topics = o?.kind === 'drink' ? (o.topics || []) : o ? [] : (r?.topics || []);
  track({
    t: 'q',
    q: userText,
    from,
    via: !r ? 'error' : o?.aiSaid ? 'ai_order' : r.source === 'ai' ? 'ai' : 'local',
    kind: !r ? 'none' : r.followup ? 'followup' : o?.kind || (r.quote ? 'quote' : r.faq?.length ? 'faq' : r.refs?.length ? 'refs' : 'text'),
    drinks: drinks.map(baseDrink).filter(Boolean),
    topics: topics.map(id => TOPIC_BY_ID[id]?.title || id),
    typos: (r?.typos || []).map(f => `${f.from}→${f.to}`),
    fuzzy: o?.kind === 'choose' ? o.said : (o?.match?.fuzzy ? o.match.said : null),
  });
}

const $ = sel => document.querySelector(sel);
const log = $('#log');
const chipsEl = $('#chips');
const form = $('#form');
const input = $('#input');
const sendBtn = $('#send');
const viewer = $('#viewer');
const viewerImg = $('#viewerImg');
const viewerTabs = $('#viewerTabs');
const viewerDl = $('#viewerDl');
const panelImg = $('#panelImg');
const panelCaption = $('#panelCaption');
const root = document.documentElement;
const chartBtn = $('#chartBtn');
const panelHide = $('#panelHide');
const wide = matchMedia('(min-width: 1000px)');

const state = {
  history: [],
  lastTopics: [],
  lastItemRegions: [],
  lastWasQuote: false,
  lastOrder: null,
  pending: null,
  busy: false,
  latestShot: null,
};

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- 文字呈現（只支援 **粗體**、- 條列，並把金額畫上螢光筆） ----------
function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/([+＋−-]?\$\d+(?:\s*[／/]\s*份)?)/g, '<mark class="price">$1</mark>');
}
function renderText(text, { fold = true } = {}) {
  // 一行一個單位：段落或條列項目
  const units = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^[-•・*]\s+(.*)$/);
    if (m && !units.length && /[：:]\s*$/.test(m[1])) { units.push({ p: m[1] }); continue; } // 「- 這邊有幾款…：」引導句不當項目
    units.push(m ? { li: m[1] } : { p: line });
  }
  const html = list => {
    let out = '', ul = null;
    for (const u of list) {
      if (u.li != null) { ul = ul || []; ul.push(u.li); continue; }
      if (ul) { out += `<ul>${ul.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`; ul = null; }
      out += `<p${/^⚠️/.test(u.p) ? ' class="note"' : ''}>${inline(u.p)}</p>`;
    }
    if (ul) out += `<ul>${ul.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`;
    return out;
  };
  // 忙碌時只掃重點：超過 5 行，先顯示前 3 行，其餘收在「看完整說明」
  if (!fold || units.length <= 5) return html(units);
  return `${html(units.slice(0, 3))}<details class="more"><summary>看完整說明</summary>${html(units.slice(3))}</details>`;
}
function milkTag(s) {
  const cls = s.hasMilk ? 'milk-yes' : (/有奶油|冰淇淋/.test(s.milk) ? 'milk-part' : 'milk-no');
  return `<span class="milk-tag ${cls}">${esc(s.milk)}</span>`;
}
function renderOrder(o, opts = {}) {
  if (o.kind === 'choose') {
    return `
      <p class="choose-q">你是指哪一杯？</p>
      <p class="note">名稱有「${esc(o.said)}」的飲品有 ${o.options.length} 杯，點一下就幫你算。</p>
      <ul class="choose-list">${o.options.map(s => `
        <li><button type="button" class="choose-btn" data-send="${esc(s.text)}">
          <span class="drink-row"><span class="drink-name">${esc(s.name)}</span>${milkTag(s)}</span>
          <span class="drink-prices">${esc(s.prices)}</span>
        </button></li>`).join('')}</ul>`;
  }
  if (o.kind === 'multi') {
    // 好幾杯：只列品名、含奶、價格；點一杯就算那一杯
    return `
      <p class="note">點一杯看合計</p>
      <ul class="choose-list">${o.drinks.map(s => `
        <li><button type="button" class="choose-btn" data-send="${esc(s.text)}">
          <span class="drink-row"><span class="drink-name">${esc(s.name)}</span>${milkTag(s)}</span>
          <span class="drink-prices">${esc(s.prices)}</span>
        </button></li>`).join('')}</ul>`;
  }
  return renderDrinkCard(o, defaultCardState(o, ''), null);
}

// ---------- 飲品卡片：單杯／買一送一，一張卡片看完 ----------
// 忙碌時 0.4～1.3 秒掃讀：畫面上只留「杯型合計、冰量、加價、環保杯、合計」，其餘收進「詳細」
const IMPORTANT = /沒看懂|不提供|沒有(短杯|中杯|大杯|特大杯)|(?<!能)不能補|不適用/;
const SHORT_SIZE = { 短杯: '短', 中杯: '中', 大杯: '大', 特大杯: '特大' };

function defaultCardState(o, text) {
  const baf = !!o.baf;
  return {
    ice: o.iceSelectable ? '正常冰' : null, choice: null,
    size: o.sizeLabel || null,
    eco: Math.min(ecoCountFrom(text), baf ? 2 : 1),
    mode: baf ? 'baf' : 'one', second: null, editing: false,
  };
}

function cardView(o, st, o2) {
  const sizes = sizesOf(o.drink);
  let size = st.size || o.sizeLabel || (sizes.length === 1 ? sizes[0].label : null);
  let rows = [], baf = null, error = '';
  if (st.mode === 'baf') {
    if (o2 && o2.kind !== 'drink') {
      error = o2?.kind === 'choose'
        ? `名稱有「${o2.said}」的有好幾杯，請輸入完整品名，例如：${o2.options.slice(0, 3).map(x => x.name).join('、')}。`
        : '看不懂第 2 杯，請輸入菜單上的品名。';
    } else {
      const free = x => ({ ...x, sizeIdx: null, sizeLabel: null });
      const q = bafQuote(free(o), free(o2 || o), { eco: st.eco });
      if (!q.ok) error = q.error;
      else { baf = q; rows = q.rows.map(r => ({ label: r.label, total: r.total })); }
      if (!error && o2?.sizeLabel && size && o2.sizeLabel !== size) error = '買一送一的兩杯大小要一致。';
    }
  } else {
    rows = singleQuote(o, { eco: st.eco }).map(r => ({ label: r.label, total: r.total }));
  }
  if (size && !rows.some(r => r.label === size)) size = null;
  return { size, rows, sel: rows.find(r => r.label === size) || null, baf, bafRow: baf && size ? baf.rows.find(r => r.label === size) : null, error };
}

function renderDrinkCard(o, st, o2, ask = null) {
  const s = o.summary;
  const v = cardView(o, st, o2);
  const seg = (label, items) => `<div class="dc-row"><span class="dc-k">${label}</span><div class="seg" role="group" aria-label="${label}">${items}</div></div>`;
  const pills = o.lines.filter(l => l.id !== 'eco').map(l => {
    const off = !!l.blocked || /不提供|不能補|不適用/.test(l.status || '');
    const val = l.status || (l.amount == null ? '未列價' : l.amount === 0 ? '$0' : money(l.amount));
    return `<span class="pill${off ? ' off' : l.amount ? '' : ' zero'}">${esc(l.label.replace(/（.*）$/, ''))} <b>${esc(val)}</b></span>`;
  }).join('');
  const notes = [...o.notes, ...o.tips];
  const important = [v.error, ...notes.filter(n => IMPORTANT.test(n))].filter(Boolean).slice(0, 2);
  const rest = notes.filter(n => !important.includes(n));
  const cups = st.mode === 'baf' && !v.error ? (v.bafRow?.cups || v.baf?.rows[0]?.cups || []) : [];
  const maxEco = st.mode === 'baf' ? 2 : 1;
  const alts = o.match?.fuzzy && o.match.alts.length
    ? `<div class="dc-alts"><span class="dc-k">不是這杯？</span>${o.match.alts.slice(0, 3).map(a => `<button type="button" class="alt-btn" data-send="${esc(a.text)}">${esc(a.name)}</button>`).join('')}</div>` : '';
  return `
    ${o.aiSaid ? `<p class="ai-said">AI 判讀：${esc(o.aiSaid)}</p>` : ''}
    <div class="dc">
      <div class="dc-head"><p class="dc-name">${esc(s.name)}</p>${milkTag(s)}</div>
      ${typoNote(o.typos)}
      ${alts}
      <div class="seg dc-mode" role="group" aria-label="計算方式">
        <button type="button" data-mode="one" aria-pressed="${st.mode === 'one'}">單杯</button>
        <button type="button" data-mode="baf" aria-pressed="${st.mode === 'baf'}">買一送一 BAF</button>
      </div>
      ${v.rows.length ? seg('杯型', v.rows.map(r => `<button type="button" class="size-btn" data-size="${esc(r.label)}" aria-pressed="${r.label === v.size}"><span>${esc(SHORT_SIZE[r.label] || r.label)}</span><b>$${r.total}</b></button>`).join('')) : ''}
      ${st.ice ? seg('冰量', ['正常冰', '少冰', '去冰'].map(x => `<button type="button" data-ice="${x}" aria-pressed="${st.ice === x}">${x.replace('正常冰', '正常')}</button>`).join('')) : ''}
      ${ask ? `
        <div class="ask">
          <p class="ask-q">${esc(ask.q)}</p>
          <div class="ask-actions" role="group" aria-label="${esc(ask.q)}">
            <button type="button" class="ask-btn" data-choice="yes" aria-pressed="${st.choice === 'yes'}">要補 +$15</button>
            <button type="button" class="ask-btn" data-choice="no" aria-pressed="${st.choice === 'no'}">不補</button>
          </div>
        </div>` : ''}
      ${st.mode === 'baf' ? `
        <ul class="cups">${cups.map(c => `
          <li><span class="role ${c.role === '送' ? 'free' : 'paid'}">${c.role}</span><span class="cup-name">${esc(c.name)}</span>${v.bafRow ? `<b>$${c.pay}</b>` : ''}</li>`).join('')}
        </ul>
        <p class="cup2">第 2 杯${st.second ? `：${esc(o2?.kind === 'drink' ? o2.summary.name : st.second)}` : '一樣'}
          <button type="button" class="link-btn baf-change">換一杯</button>${st.second ? '<button type="button" class="link-btn baf-same">改回一樣</button>' : ''}</p>
        ${st.editing ? `
          <form class="baf-form">
            <input type="text" class="baf-input" maxlength="60" placeholder="第 2 杯，例如：冰美式" aria-label="第 2 杯飲品" value="${esc(st.second || '')}">
            <button type="submit" class="baf-go">算</button>
          </form>` : ''}`
      : (pills ? `<div class="pills">${pills}</div>` : '')}
      ${important.map(n => `<p class="warn">${esc(n)}</p>`).join('')}
      <div class="dc-foot">
        ${seg('環保杯', Array.from({ length: maxEco + 1 }, (_, n) => `<button type="button" data-eco="${n}" aria-pressed="${st.eco === n}">${n}</button>`).join(''))}
        <p class="dc-total">${v.sel ? `<span>${st.mode === 'baf' ? '兩杯' : '合計'}</span><mark class="price">$${v.sel.total}</mark>` : '<span class="dc-hint">點杯型看合計</span>'}</p>
      </div>
      <details class="more dc-more">
        <summary>詳細</summary>
        <p>${esc(s.comp)}</p>
        <p>菜單價格：${esc(s.prices)}</p>
        ${s.altNote ? `<p>${esc(s.altNote)}</p>` : ''}
        ${s.info ? `<p>${esc(s.info)}</p>` : ''}
        ${rest.map(n => `<p>${inline(n)}</p>`).join('')}
        ${v.bafRow && v.bafRow.saved > 0 ? `<p>用券省 $${v.bafRow.saved}。</p>` : ''}
        ${st.mode === 'baf' && v.baf ? v.baf.notes.map(n => `<p>${esc(n)}</p>`).join('') : ''}
        ${st.mode === 'baf' ? `<ul>${[...BAF_RULES.how, ...BAF_RULES.limits].map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${o.aiNote ? `<p>AI 補充：${esc(o.aiNote)}</p>` : ''}
        <p>實際金額以門市結帳為準。</p>
      </details>
    </div>`;
}

function renderRefs(list, title = '提到的飲品') {
  return `
    <div class="refs">
      <p class="refs-title">${esc(title)}（點一下可試算）</p>
      <ul class="choose-list">${list.map(s => `
        <li><button type="button" class="choose-btn" data-send="${esc(s.text)}">
          <span class="drink-row"><span class="drink-name">${esc(s.name)}</span>${milkTag(s)}</span>
          <span class="drink-prices">${esc(s.prices)}</span>
        </button></li>`).join('')}</ul>
    </div>`;
}

function renderQuote(q) {
  const pills = q.lines.map(l => `<span class="pill${l.amount ? '' : ' zero'}">${esc(l.label)} <b>${l.amount === 0 ? '$0' : money(l.amount)}</b></span>`).join('');
  return `
    <div class="dc">
      <div class="pills">${pills}</div>
      <div class="dc-foot">
        <span class="dc-k">不含飲品本身</span>
        <p class="dc-total"><span>加價</span><mark class="price">${money(q.total)}</mark></p>
      </div>
      ${q.notes.length ? `<details class="more dc-more"><summary>詳細</summary>${q.notes.map(n => `<p>${esc(n)}</p>`).join('')}<p>實際金額以門市結帳為準。</p></details>` : ''}
    </div>`;
}

// ---------- 訊息 ----------
const AVATAR = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M11 12h18l-2.2 19.5a2.5 2.5 0 0 1-2.5 2.2h-8.6a2.5 2.5 0 0 1-2.5-2.2Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9.5 12h21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M13 19.5l14.5-2.2" stroke="var(--logo-swipe)" stroke-width="5" stroke-linecap="round"/></svg>`;

function addMessage(role, html, meta = '') {
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  const time = timeFmt.format(new Date());
  row.innerHTML = `
    ${role === 'bot' ? `<div class="avatar">${AVATAR}</div>` : ''}
    <div class="stack">
      <div class="bubble">${html}</div>
      <p class="meta">${meta ? `${esc(meta)}　` : ''}<time>${time}</time></p>
    </div>`;
  log.appendChild(row);
  scrollToEnd();
  return row;
}

function scrollToEnd() {
  requestAnimationFrame(() => {
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  });
}

function showTyping() {
  const row = document.createElement('div');
  row.className = 'msg bot typing';
  row.innerHTML = `<div class="avatar">${AVATAR}</div><div class="stack"><div class="bubble" aria-label="正在輸入"><span></span><span></span><span></span></div></div>`;
  log.appendChild(row);
  scrollToEnd();
  return () => row.remove();
}

// 輸入框上方的「建議問題」：開場列常見問題；之後只放跟上一題有關的追問，沒有就不顯示
function setChips(list, current = '', title = '接著問') {
  chipsEl.innerHTML = '';
  const seen = new Set();
  const items = (list || []).filter(text => text && text !== current && !seen.has(text) && seen.add(text));
  chipsEl.hidden = !items.length;
  if (!items.length) return;
  const label = document.createElement('span');
  label.className = 'chips-label';
  label.textContent = title;
  chipsEl.appendChild(label);
  for (const text of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (text === MARK_CHIP ? ' chip-mark' : '');
    b.textContent = text;
    b.addEventListener('click', () => send(text, 'chip'));
    chipsEl.appendChild(b);
  }
  chipsEl.scrollLeft = 0;
}

async function attachImage(row, { regions, plain, caption }) {
  const bubble = row.querySelector('.bubble');
  const fig = document.createElement('figure');
  fig.className = 'shot';
  fig.innerHTML = `<button type="button" class="shot-btn" aria-label="放大圖片"><span class="shot-loading">正在畫重點…</span></button><figcaption>${esc(caption || '')}</figcaption>`;
  bubble.appendChild(fig);
  scrollToEnd();
  try {
    let shot;
    if (plain) {
      await loadMenuImage(MENU_SRC);
      shot = { full: MENU_SRC, crop: null, plain: true };
    } else {
      shot = await renderHighlight(MENU_SRC, regions);
    }
    const btn = fig.querySelector('.shot-btn');
    // 標示範圍不大時，泡泡裡先放「標示處放大」，點開可切換整張圖
    const thumb = shot.crop || shot.full;
    btn.innerHTML = `<img src="${thumb}" alt="${plain ? '客製化收費圖表' : '用橘色螢光筆標示重點的收費圖表'}">`;
    if (shot.crop) fig.querySelector('figcaption').textContent = '這是標示處的放大圖，橘色螢光筆就是重點。點圖可以切換整張圖或下載。';
    btn.addEventListener('click', () => openViewer(shot));
    btn.querySelector('img').addEventListener('load', scrollToEnd, { once: true });
    state.latestShot = shot;
    if (!plain && !chartOnScreen()) chartBtn.dataset.new = '';
    panelImg.src = shot.full;
    panelCaption.textContent = plain ? '完整的收費圖表。' : '橘色螢光筆是最新一題的重點。';
  } catch {
    fig.querySelector('.shot-btn').innerHTML = '<span class="shot-loading">圖表載入失敗，請重新整理頁面再試一次。</span>';
  }
}

const HEALTH_NOTE = '<p class="note">⚠️ 店內菜單：現場調製飲料，設備清洗後可能仍無法避免牛奶、大豆、花生、芝麻、芒果、堅果、含麩質之穀物、蛋等過敏原殘留；有疑慮建議點購罐裝飲品。</p>';
const ALLERGY_NOTE = '<p class="note">⚠️ 對牛奶過敏：點餐時請先告訴夥伴。奶油、冰淇淋也是乳製品。店內菜單註明：設備清洗後可能仍無法避免牛奶等過敏原殘留，有疑慮建議點購罐裝飲品。</p>';
const healthNote = h => (h === 'allergy' ? ALLERGY_NOTE : HEALTH_NOTE);

// 同音錯字自動更正：小字標出改了什麼，讓人一眼確認
const typoNote = list => (list?.length ? `<p class="typo-note">已自動更正：${list.map(f => `${esc(f.from)}→${esc(f.to)}`).join('、')}</p>` : '');

function botReply(r, userText) {
  trackAsk(r, userText, state.from);
  let body = r.order ? renderOrder(r.order) : (r.quote ? renderQuote(r.quote) : renderText(r.text));
  if (r.typos?.length && r.order?.kind !== 'drink') body = typoNote(r.typos) + body;
  if (r.refs?.length) body += renderRefs(r.refs, r.refsTitle);
  if (r.health) body += healthNote(r.health);
  if (r.order && r.health) r.order.health = r.health;
  const meta = r.meta || (r.source === 'ai' ? 'AI 回覆，僅供參考' : '依收費規則回覆');
  const row = addMessage('bot', body, meta);

  if (r.regions?.length) attachImage(row, { regions: r.regions, caption: r.caption });
  else if (r.plainImage) attachImage(row, { plain: true, caption: '點圖可以放大。' });

  if (r.orderText) state.lastOrder = r.orderText;
  state.pending = r.pending || null;
  if (r.order?.kind === 'drink' && r.orderText) setupCard(row, r.order, r.orderText);
  if (r.topics?.length) state.lastTopics = r.topics;
  if (r.topics?.length || r.itemRegions?.length) {
    state.lastItemRegions = r.itemRegions || [];
    state.lastWasQuote = !!(r.quote || r.order);
  }
  state.history.push({ role: 'assistant', content: r.text });
  setChips(r.chips || [], userText);
}

// 卡片上的按鈕：冰量（正常冰／少冰／去冰）＋橘框「要補／不補」，在同一張卡片即時切換價格
function setupCard(row, firstOrder, baseText) {
  const bubble = row.querySelector('.bubble');
  const st = defaultCardState(firstOrder, baseText);

  // 目前這杯：冰量、補不補都算進點單文字
  const current = () => {
    const text = baseText + (st.ice && st.ice !== '正常冰' ? st.ice : '');
    const base = buildOrder(text);
    const ask = base?.ask || null;
    const o = st.choice === 'yes' && ask ? buildOrder(text + ask.add) : base;
    if (o && firstOrder.aiSaid) o.aiSaid = firstOrder.aiSaid;
    if (o && firstOrder.aiNote) o.aiNote = firstOrder.aiNote;
    if (o && firstOrder.typos) o.typos = firstOrder.typos;
    return { text: st.choice === 'yes' && ask ? text + ask.add : text, o, ask };
  };
  const second = () => (st.second ? buildOrder(fixHomophones(normalize(st.second)).text) : null);

  const draw = () => {
    const { o, ask } = current();
    if (!o || o.kind !== 'drink') return;
    bubble.innerHTML = renderDrinkCard(o, st, second(), ask) + (firstOrder.health ? healthNote(firstOrder.health) : '');
  };

  // 讓後續對話（AI）知道卡片現在的狀態
  const remember = said => {
    const { text, o, ask } = current();
    const v = cardView(o, st, second());
    state.lastOrder = text + (v.size && !o.sizeLabel ? v.size : '');
    state.pending = ask && !st.choice ? { add: ask.add } : null;
    state.lastItemRegions = o.regions;
    state.lastTopics = o.topics.length ? o.topics : state.lastTopics;
    state.lastWasQuote = true;
    const summary = st.mode === 'baf'
      ? (v.bafRow ? `買一送一（${v.size}，環保杯 ${st.eco} 個）：${v.bafRow.cups.map(c => `${c.role}「${c.name}」$${c.pay}`).join('，')}，兩杯 $${v.bafRow.total}` : (v.error || '買一送一：請選杯型'))
      : (v.sel ? `${o.summary.name}（${v.size}，環保杯 ${st.eco} 個）合計 $${v.sel.total}` : orderToText(o));
    state.history.push({ role: 'user', content: said }, { role: 'assistant', content: summary });
  };

  bubble.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !bubble.contains(t)) return;
    if (t.dataset.mode) {
      if (st.mode === t.dataset.mode) return;
      st.mode = t.dataset.mode;
      if (st.mode === 'one') { st.eco = Math.min(st.eco, 1); st.editing = false; }
      draw(); remember(st.mode === 'baf' ? '用BAF券' : '單杯');
    } else if (t.dataset.size) {
      st.size = t.dataset.size; draw(); remember(st.size);
    } else if (t.dataset.ice) {
      if (st.ice === t.dataset.ice) return;
      st.ice = t.dataset.ice; st.choice = null; draw(); remember(st.ice);
    } else if (t.dataset.choice) {
      st.choice = t.dataset.choice; draw(); remember(st.choice === 'yes' ? `要${current().ask?.add || '補'}` : '不補');
    } else if (t.dataset.eco != null) {
      st.eco = Number(t.dataset.eco); draw(); remember(`環保杯 ${st.eco} 個`);
    } else if (t.classList.contains('baf-change')) {
      st.editing = true; draw(); bubble.querySelector('.baf-input')?.focus();
    } else if (t.classList.contains('baf-same')) {
      st.second = null; st.editing = false; draw(); remember('第 2 杯一樣');
    }
  });
  bubble.addEventListener('submit', e => {
    if (!e.target.classList.contains('baf-form')) return;
    e.preventDefault();
    const val = bubble.querySelector('.baf-input').value.trim();
    st.second = val || null; st.editing = false;
    draw();
    if (val) remember(`第 2 杯：${val}`);
  });

  draw();
}


// ---------- AI ----------
async function askAI(route = null) {
  if (!API_URL) return { error: 'no_backend' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.history.slice(-10), ...(route ? { route } : {}) }),
      signal: ctrl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON（例如本機預覽沒有後端） */ }
    if (res.ok && data.route === 'local') return { route: 'local', sem: data.sem };
    if (!res.ok || !data.reply) return { error: data.error || ([404, 405].includes(res.status) ? 'no_backend' : 'upstream') };
    return { reply: data.reply, route: data.route, sem: data.sem };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const AI_ERRORS = {
  rate_limited: 'AI 目前使用人數較多（免費額度有限），請稍後再試。收費相關的問題，可以先點下面的常見問題。',
  timeout: 'AI 這次回覆太久了，請再問一次，或點下面的常見問題。',
  no_backend: '這題我找不到對應的收費項目。我可以回答圖表上的加價問題，換個說法試試，例如「燕麥奶加抹茶液多少」，或點下面的常見問題。',
  missing_key: '這題不在收費規則裡，而 AI 目前沒有連線。可以換個說法，或點下面的常見問題。',
};

// 需要理解意圖的問題（推薦、比較、適不適合…）優先交給 AI；關鍵字規則只會照字面回答
const RE_AI_FIRST = /(推薦|建議|適合|好喝|比較好|哪個好|哪一杯|哪杯|喝什麼|有什麼可以|可以喝|能喝|不能喝|過敏|乳糖|吃素|素食|熱量|卡路里|咖啡因|孕婦|小孩|減肥|最便宜|便宜一點|划算|省錢|差在哪|差別|有什麼不同|怎麼選|幫我選|想喝)/;
function aiFirst(text, local) {
  if (!API_URL || !RE_AI_FIRST.test(normalize(text))) return false;
  // 已經是明確的一杯飲料試算，就不用 AI
  return !(local?.order?.kind === 'drink' && !local.order.match?.fuzzy && local.order.lines.length);
}

const RE_HEALTH = /(過敏|乳糖|孕婦|懷孕|咖啡因|熱量|卡路里|健康|減肥|吃素|素食|糖尿病)/;

function semNote(sem, route) {
  if (!DEBUG || !sem) return '';
  return `［語意 ${sem.topic} ${sem.score}｜最像 ${sem.best} ${sem.bestScore}｜未涵蓋 ${sem.near} → ${route === 'local' ? '預寫' : 'AI'}］`;
}

function dietReply(kind) {
  const fb = dietFallback(kind);
  return { source: 'local', meta: '依官網成分整理', text: fb.text, refs: fb.refs, refsTitle: '不含奶的飲品', health: kind === 'allergy' ? 'allergy' : false, topics: [], chips: ['哪些飲料有牛奶？'] };
}

// 規則有看不懂的詞時，先問 AI 能不能聽懂
const hasUnknown = o => !!o?.notes?.some(n => /沒看懂/.test(n));
function needsAI(local) {
  return !!(API_URL && local?.order?.kind === 'drink' && hasUnknown(local.order));
}
function cleanAiText(reply) {
  return parseAiReply(reply).text.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 160);
}
function aiOrder(reply) {
  const m = String(reply).match(/ORDER\s*[:：]\s*(.+)/i);
  if (!m) return null;
  const text = m[1].replace(/[`*「」]/g, '').trim();
  const r = localReply(text, {});
  return { text, r: r?.order?.kind === 'drink' ? r : null };
}

// ---------- 送出 ----------
async function send(text, from = 'typed') {
  text = (text || '').trim();
  if (!text || state.busy) return;
  state.busy = true;
  state.from = from;
  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  addMessage('user', `<p>${esc(text)}</p>`);
  state.history.push({ role: 'user', content: text.slice(0, 500) });
  setChips([]);
  const hideTyping = showTyping();

  try {
    const local = localReply(text, state);
    const diet = dietFor(state.history);
    // 不含奶／過敏的推薦題（不是在點某一杯）：交給 AI 並檢查；沒有 AI 時用官網成分整理的固定答案
    // 沿用上一句需求的短追問（例如「那熱的呢」）：本身是別的問題（規則認得）就照規則回答
    const dietAsk = diet.recommend && !local?.order && !(diet.inherited && local);
    // 「我意思是…」「我是問…」：上一個回答沒答到，直接交給 AI（不重複預寫答案）
    const clarify = !!API_URL && state.history.length > 1 && isClarify(text);
    const preferAI = aiFirst(text, local) || (dietAsk && !!API_URL) || clarify;
    // 關鍵字找到的預寫答案：先請後端用語意比對確認真的回答到，不夠像才由 AI 回答
    const verify = !!(API_URL && local?.faq?.length && !preferAI);
    if (dietAsk && !API_URL) {
      await new Promise(r => setTimeout(r, reduceMotion ? 0 : 380));
      hideTyping();
      botReply(dietReply(diet.diet), text);
      return;
    }
    const allergy = diet.diet === 'allergy' && !diet.inherited;
    if (local && allergy) local.health = 'allergy';
    if (local && !needsAI(local) && !preferAI && !verify) {
      await new Promise(r => setTimeout(r, reduceMotion ? 0 : 380));
      hideTyping();
      botReply(local, text);
      return;
    }
    const ai = await askAI(verify ? { topics: local.faq } : clarify ? { clarify: true, topics: state.lastTopics || [] } : null);
    hideTyping();
    if (ai.route === 'local' && local) {
      if (DEBUG) local.meta = `依收費規則回覆　${semNote(ai.sem, 'local')}`;
      botReply(local, text);
      return;
    }
    if (ai.reply) {
      // AI 把口語點單改寫成標準點單 → 交給收費規則計算，金額不由 AI 決定
      const ord = aiOrder(ai.reply);
      if (ord?.r && (!local || !hasUnknown(ord.r.order))) {
        ord.r.order.aiSaid = ord.text;
        ord.r.meta = 'AI 判讀，金額依收費規則計算';
        ord.r.health = allergy ? 'allergy' : RE_HEALTH.test(normalize(text));
        botReply(ord.r, text);
        return;
      }
      if (local && !preferAI && !verify) {
        const note = !ord ? cleanAiText(ai.reply) : '';
        if (note && local.order?.kind === 'drink') local.order.aiNote = note;
        botReply(local, text);
        return;
      }
      if (ord && !ord.r) {
        botReply({ source: 'ai', text: `我判讀成「${ord.text}」，但對不到菜單上的飲品，可以換個說法，或輸入飲品名稱的關鍵字。`, topics: [] }, text);
        return;
      }
      const p = parseAiReply(ai.reply.replace(/^.*ORDER\s*[:：].*$/gim, ''));
      const onTopic = matchTopics(normalize(text)).some(t => !t.low);
      const health = (allergy || (diet.diet === 'allergy' && dietAsk)) ? 'allergy' : RE_HEALTH.test(normalize(text));
      if (health || diet.diet) p.text = p.text.replace(/[，,]?\s*(您|你)?(都)?(可以|能)?(很)?(安心|放心)(地)?(飲用|喝|享用|選擇)?/g, '');
      // 不含奶／過敏的推薦：含奶的飲品一律不能出現，AI 答錯就換成依官網成分整理的答案
      const g = dietAsk ? guardDietReply(diet.diet, p, { inherited: diet.inherited }) : null;
      if (g && g.status !== 'ok') console.warn(`[diet] AI 回答提到含奶飲品（${g.status}）：`, g.problems);
      botReply({
        source: 'ai',
        meta: (g?.status === 'replaced' ? '依官網成分整理' : (g?.status === 'repaired' ? 'AI 回覆，已依官網成分拿掉含奶飲品' : (DEBUG && ai.sem ? 'AI 回覆，僅供參考' : '')))
          + (DEBUG && ai.sem ? `　${semNote(ai.sem, 'ai')}` : ''),
        refs: g ? g.refs : p.drinks,
        refsTitle: g ? '不含奶的飲品' : undefined,
        health,
        text: (g ? g.text : p.text) || '我沒有整理出答案，請換個方式再問一次。',
        regions: p.regions,
        caption: '圖上相關的地方用橘色螢光筆標起來了，點圖可以放大。',
        topics: onTopic ? p.topics : [],
        chips: onTopic && p.topics.length ? [MARK_CHIP] : [],
      }, text);
    } else {
      if (dietAsk) { botReply(dietReply(diet.diet), text); return; }
      if (local) { botReply(local, text); return; }
      trackAsk(null, text, from);
      const msg = AI_ERRORS[ai.error] || 'AI 暫時無法回覆，請稍後再試，或點下面的常見問題。';
      addMessage('bot', renderText(msg), '系統訊息');
      state.history.pop();
      setChips(WELCOME_CHIPS, text, '常見問題');
    }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
  }
}

// 「你是指哪一杯？」與「不是這杯？」的按鈕：直接用那杯重新試算
log.addEventListener('click', e => {
  const b = e.target.closest('[data-send]');
  if (b && !state.busy) send(b.dataset.send, 'tap');
});

// ---------- 圖片檢視 ----------
function openViewer(shot) {
  delete chartBtn.dataset.new;
  const views = [];
  if (shot.crop) views.push(['標示處', shot.crop]);
  views.push([shot.plain ? '收費圖表' : '整張圖', shot.full]);
  viewerTabs.innerHTML = '';
  views.forEach(([label, src], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    b.addEventListener('click', () => show(i));
    viewerTabs.appendChild(b);
  });
  viewerTabs.hidden = views.length < 2;
  function show(i) {
    viewerImg.src = views[i][1];
    viewerImg.classList.remove('zoomed');
    viewerDl.href = views[i][1];
    [...viewerTabs.children].forEach((b, j) => b.setAttribute('aria-pressed', j === i ? 'true' : 'false'));
  }
  show(0);
  viewer.showModal();
}
viewerImg.addEventListener('click', () => viewerImg.classList.toggle('zoomed'));
$('#viewerClose').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', e => { if (e.target === viewer) viewer.close(); });
// ---------- 收費圖表：桌機可隱藏右側圖表；手機用頂部按鈕開圖 ----------
const CHART_KEY = 'chartHidden';
const chartOnScreen = () => wide.matches && !root.classList.contains('chart-hidden');
function syncChartBtn() {
  const restore = wide.matches && root.classList.contains('chart-hidden');
  chartBtn.setAttribute('aria-label', restore ? '顯示收費圖表' : '查看收費圖表');
  if (chartOnScreen()) delete chartBtn.dataset.new;
}
function setChartHidden(hidden, save = true) {
  root.classList.toggle('chart-hidden', hidden);
  panelHide.setAttribute('aria-expanded', String(!hidden));
  if (save) { try { localStorage.setItem(CHART_KEY, hidden ? '1' : '0'); } catch { /* 無痕模式等 */ } }
  syncChartBtn();
}
// 上次的選擇已由 index.html 開頭的小程式先套用（避免畫面閃一下），這裡只同步按鈕狀態
setChartHidden(root.classList.contains('chart-hidden'), false);
wide.addEventListener('change', syncChartBtn);
panelHide.addEventListener('click', () => { setChartHidden(true); chartBtn.focus(); });

chartBtn.addEventListener('click', async () => {
  if (wide.matches && root.classList.contains('chart-hidden')) {
    setChartHidden(false);
    panelHide.focus();
    return;
  }
  if (state.latestShot) return openViewer(state.latestShot);
  try { await loadMenuImage(MENU_SRC); } catch { /* 開啟後仍會顯示 */ }
  openViewer({ full: MENU_SRC, crop: null, plain: true });
});
$('#panelBtn').addEventListener('click', () => openViewer(state.latestShot || { full: MENU_SRC, crop: null, plain: true }));

// ---------- 輸入框 ----------
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener('submit', e => { e.preventDefault(); send(input.value); });

// ---------- 開場 ----------
panelImg.src = MENU_SRC;
loadMenuImage(MENU_SRC).catch(() => {});
addMessage('bot', renderText(
`嗨！輸入飲品和調整，我幫你算好，例如「冰那堤大杯換燕麥奶」。
收費看不懂，我會在圖表上用螢光筆標出來。${wide.matches ? '' : '\n完整收費圖表在右上角。'}`, { fold: false }), '依收費規則回覆');
setChips(WELCOME_CHIPS, '', '常見問題');
{
  const q = new URLSearchParams(location.search);
  track({ t: 'v', ref: document.referrer, utm: q.get('utm_source') || '', tp: navigator.maxTouchPoints || 0 });
}
