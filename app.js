// =============================================================
// 聊天介面
// =============================================================
import { IMAGE, WELCOME_CHIPS, EFFECTIVE_DATE } from './kb.js?v=202610121515';
import { localReply, parseAiReply, money, matchTopics, normalize, buildOrder, orderToText } from './engine.js?v=202610121515';
import { renderHighlight, loadMenuImage } from './highlight.js?v=202610121515';

const MENU_SRC = window.__MENU_SRC || IMAGE.src;
// AI 後端位置：可在頁面上用 window.APP_CONFIG = { apiUrl: '...' } 指定。
// GitHub Pages 沒有後端，預設關閉 AI；部署到 Cloudflare Pages 時使用 /api/chat。
const API_URL = (window.APP_CONFIG && 'apiUrl' in window.APP_CONFIG)
  ? window.APP_CONFIG.apiUrl
  : (location.hostname.endsWith('github.io') ? null : '/api/chat');
const MARK_CHIP = '看不懂，標給我看';

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
function renderText(text) {
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^[-•・*]\s+(.*)$/);
    if (m) {
      if (!list) { list = []; out.push(list); }
      list.push(m[1]);
      continue;
    }
    list = null;
    if (!line) continue;
    out.push(line);
  }
  return out.map(part => Array.isArray(part)
    ? `<ul>${part.map(li => `<li>${inline(li)}</li>`).join('')}</ul>`
    : `<p${/^⚠️/.test(part) ? ' class="note"' : ''}>${inline(part)}</p>`).join('');
}
function milkTag(s) {
  const cls = s.hasMilk ? 'milk-yes' : (/有奶油|冰淇淋/.test(s.milk) ? 'milk-part' : 'milk-no');
  return `<span class="milk-tag ${cls}">${esc(s.milk)}</span>`;
}
function amountCell(a, status) {
  if (status) return `<span class="amt unlisted">${esc(status)}</span>`;
  if (a == null) return '<span class="amt unlisted">未列價</span>';
  if (a === 0) return '<span class="amt">不加價</span>';
  return `<span class="amt"><mark class="price">${money(a)}</mark></span>`;
}
function renderOrder(o, opts = {}) {
  if (o.kind === 'multi') {
    return `<ul class="drink-list">${o.drinks.map(s => `
      <li class="drink-card">
        <div class="drink-row"><p class="drink-name">${esc(s.name)}</p>${milkTag(s)}</div>
        <p class="drink-comp">${esc(s.comp)}</p>
        <p class="drink-prices">${esc(s.prices)}</p>
      </li>`).join('')}</ul>
      <p class="note">加價試算請一杯一杯問，例如「${esc(o.drinks[0].name.replace(/（.*$/, ''))}去冰補滿大杯」。</p>`;
  }
  const s = o.summary;
  let html = `
    <div class="drink-card">
      <div class="drink-row"><p class="drink-name">${esc(s.name)}</p>${milkTag(s)}</div>
      <p class="drink-comp">${esc(s.comp)}</p>
      <p class="drink-prices">${esc(s.prices)}</p>
      ${s.altNote ? `<p class="drink-info">${esc(s.altNote)}</p>` : ''}
      ${s.info ? `<p class="drink-info">${esc(s.info)}</p>` : ''}
    </div>`;
  if (opts.iceSel) {
    html += `
      <div class="ice-sel" role="group" aria-label="冰量">
        <span class="ice-label">冰量</span>
        ${['正常冰', '少冰', '去冰'].map(v => `<button type="button" class="ice-btn" data-ice="${v}" aria-pressed="${opts.iceSel === v}">${v}</button>`).join('')}
      </div>`;
  }
  if (o.lines.length) {
    const rows = o.lines.map(l => `<li><span>${esc(l.label)}</span>${amountCell(l.amount, l.status)}</li>`).join('');
    const total = o.basePrice != null
      ? `<p class="receipt-total"><span>合計（${esc(o.sizeLabel)}）</span><mark class="price">$${o.basePrice + o.addTotal}</mark></p>
         <p class="receipt-foot">飲品 $${o.basePrice}，加價 ${money(o.addTotal)}</p>`
      : `<p class="receipt-total"><span>加價</span><mark class="price">${money(o.addTotal)}</mark></p>
         <p class="receipt-sizes">${o.sizeTotals.map(t => `<span>${esc(t.label)} <b>$${t.total}</b></span>`).join('')}</p>
         <p class="receipt-foot">上面是含飲品的總價，實際以門市結帳為準。</p>`;
    html += `
      <div class="receipt">
        <p class="receipt-title">加價明細</p>
        <ul class="receipt-lines">${rows}</ul>
        ${total}
      </div>`;
  } else if (o.basePrice != null) {
    html += `<p class="receipt-total solo"><span>${esc(o.sizeLabel)}</span><mark class="price">$${o.basePrice}</mark></p>`;
  }
  html += o.tips.map(t => `<p class="tip">${inline(t)}</p>`).join('');
  const ask = opts.ask || o.ask;
  if (ask) {
    const choice = opts.choice || null;
    const sub = choice === 'yes' ? `已加上${ask.add} +$15，上面的價格已更新。`
      : choice === 'no' ? '不補，維持原本菜單價格。' : ask.sub;
    html += `
      <div class="ask">
        <p class="ask-q">${esc(ask.q)}</p>
        <p class="ask-sub">${inline(sub)}</p>
        <div class="ask-actions" role="group" aria-label="${esc(ask.q)}">
          <button type="button" class="ask-btn" data-choice="yes" aria-pressed="${choice === 'yes'}">要補（+$15）</button>
          <button type="button" class="ask-btn" data-choice="no" aria-pressed="${choice === 'no'}">不補</button>
        </div>
      </div>`;
  }
  html += o.notes.map(n => `<p class="note">⚠️ ${esc(n)}</p>`).join('');
  return html;
}

function renderQuote(q) {
  const rows = q.lines.map(l => `
    <li><span>${esc(l.label)}</span><span class="amt">${l.amount === 0 ? '不加價' : `<mark class="price">${money(l.amount)}</mark>`}</span></li>`).join('');
  const notes = q.notes.map(n => `<p class="note">${esc(n)}</p>`).join('');
  return `
    <div class="receipt">
      <p class="receipt-title">加價試算</p>
      <ul class="receipt-lines">${rows}</ul>
      <p class="receipt-total"><span>合計</span><mark class="price">${money(q.total)}</mark></p>
      <p class="receipt-foot">不含飲品本身價格，實際以門市結帳為準。</p>
    </div>${notes}`;
}

// ---------- 訊息 ----------
const AVATAR = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M11 12h18l-2.2 19.5a2.5 2.5 0 0 1-2.5 2.2h-8.6a2.5 2.5 0 0 1-2.5-2.2Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9.5 12h21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M13 19.5l14.5-2.2" stroke="var(--marker-solid)" stroke-width="5" stroke-linecap="round" opacity=".85"/></svg>`;

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

function setChips(list, current = '') {
  chipsEl.innerHTML = '';
  const seen = new Set();
  for (const text of list) {
    if (!text || text === current || seen.has(text)) continue;
    seen.add(text);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (text === MARK_CHIP ? ' chip-mark' : '');
    b.textContent = text;
    b.addEventListener('click', () => send(text));
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
    panelImg.src = shot.full;
    panelCaption.textContent = plain ? '完整的收費圖表。' : '橘色螢光筆是最新一題的重點。';
  } catch {
    fig.querySelector('.shot-btn').innerHTML = '<span class="shot-loading">圖表載入失敗，請重新整理頁面再試一次。</span>';
  }
}

function botReply(r, userText) {
  const body = r.order ? renderOrder(r.order) : (r.quote ? renderQuote(r.quote) : renderText(r.text));
  const meta = r.source === 'ai' ? 'AI 回覆，僅供參考' : '依收費規則回覆';
  const row = addMessage('bot', body, meta);

  if (r.regions?.length) attachImage(row, { regions: r.regions, caption: r.caption });
  else if (r.plainImage) attachImage(row, { plain: true, caption: '點圖可以放大。' });

  if (r.orderText) state.lastOrder = r.orderText;
  state.pending = r.pending || null;
  if (r.order?.kind === 'drink' && r.orderText && (r.order.ask || r.order.iceSelectable)) setupCard(row, r.order, r.orderText);
  if (r.topics?.length) state.lastTopics = r.topics;
  if (r.topics?.length || r.itemRegions?.length) {
    state.lastItemRegions = r.itemRegions || [];
    state.lastWasQuote = !!(r.quote || r.order);
  }
  state.history.push({ role: 'assistant', content: r.text });
  setChips(r.chips?.length ? r.chips : WELCOME_CHIPS.slice(0, 3), userText);
}

// 卡片上的按鈕：冰量（正常冰／少冰／去冰）＋橘框「要補／不補」，在同一張卡片即時切換價格
function setupCard(row, firstOrder, baseText) {
  const bubble = row.querySelector('.bubble');
  const showIce = !!firstOrder.iceSelectable;
  let ice = showIce ? '正常冰' : null;
  let choice = null;

  const current = () => {
    const text = baseText + (ice && ice !== '正常冰' ? ice : '');
    const base = buildOrder(text);
    const ask = base?.ask || null;
    const o = choice === 'yes' && ask ? buildOrder(text + ask.add) : base;
    return { text: choice === 'yes' && ask ? text + ask.add : text, o, ask };
  };

  const draw = () => {
    const { o, ask } = current();
    if (!o || o.kind !== 'drink') return;
    bubble.innerHTML = renderOrder(o, { ask, choice: ask ? choice : null, iceSel: showIce ? ice : null });
    bubble.querySelectorAll('.ice-btn').forEach(b => b.addEventListener('click', () => {
      if (ice === b.dataset.ice) return;
      ice = b.dataset.ice;
      choice = null;
      commit(`${ice}`);
    }));
    bubble.querySelectorAll('.ask-btn').forEach(b => b.addEventListener('click', () => {
      choice = b.dataset.choice;
      commit(choice === 'yes' ? `要${current().ask?.add || '補'}` : '不補');
    }));
  };

  const commit = said => {
    draw();
    const { text, o, ask } = current();
    state.lastOrder = text;
    state.pending = ask && !choice ? { add: ask.add } : null;
    state.lastItemRegions = o.regions;
    state.lastTopics = o.topics.length ? o.topics : state.lastTopics;
    state.lastWasQuote = true;
    state.history.push({ role: 'user', content: said }, { role: 'assistant', content: orderToText(o) });
  };

  draw();
}

// ---------- AI ----------
async function askAI() {
  if (!API_URL) return { error: 'no_backend' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.history.slice(-10) }),
      signal: ctrl.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON（例如本機預覽沒有後端） */ }
    if (!res.ok || !data.reply) return { error: data.error || ([404, 405].includes(res.status) ? 'no_backend' : 'upstream') };
    return { reply: data.reply };
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

// ---------- 送出 ----------
async function send(text) {
  text = (text || '').trim();
  if (!text || state.busy) return;
  state.busy = true;
  sendBtn.disabled = true;
  input.value = '';
  autoGrow();
  addMessage('user', `<p>${esc(text)}</p>`);
  state.history.push({ role: 'user', content: text.slice(0, 500) });
  setChips([]);
  const hideTyping = showTyping();

  try {
    const local = localReply(text, state);
    if (local) {
      await new Promise(r => setTimeout(r, reduceMotion ? 0 : 380));
      hideTyping();
      botReply(local, text);
      return;
    }
    const ai = await askAI();
    hideTyping();
    if (ai.reply) {
      const p = parseAiReply(ai.reply);
      const onTopic = matchTopics(normalize(text)).some(t => !t.low);
      botReply({
        source: 'ai',
        text: p.text || '我沒有整理出答案，請換個方式再問一次。',
        regions: p.regions,
        caption: '圖上相關的地方用橘色螢光筆標起來了，點圖可以放大。',
        topics: onTopic ? p.topics : [],
        chips: onTopic && p.topics.length ? [MARK_CHIP, ...WELCOME_CHIPS.slice(0, 2)] : WELCOME_CHIPS.slice(0, 3),
      }, text);
    } else {
      const msg = AI_ERRORS[ai.error] || 'AI 暫時無法回覆，請稍後再試，或點下面的常見問題。';
      addMessage('bot', renderText(msg), '系統訊息');
      state.history.pop();
      setChips(WELCOME_CHIPS, text);
    }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
  }
}

// ---------- 圖片檢視 ----------
function openViewer(shot) {
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
$('#chartBtn').addEventListener('click', async () => {
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
`嗨，我是客製化加價小幫手。
${EFFECTIVE_DATE} 起，補奶、加料、換特殊奶等客製化項目開始加價。
直接打飲品和想調整的地方，例如「冰蜜柚紅茶少冰大杯」，我會告訴你這杯有沒有奶、要補什麼，並算好總價。
有看不懂的地方，我會在收費圖表上用螢光筆標給你看。`), '依收費規則回覆');
setChips(WELCOME_CHIPS);
