// =============================================================
// Cloudflare Pages Function：POST /api/chat
// 依序嘗試：Cloudflare Workers AI（免金鑰）→ Gemini → OpenRouter，前一個失敗才換下一個。
// 金鑰只存在 Cloudflare，前端看不到。
//
// 設定（大多已寫在 wrangler.toml）：
//   AI                    Workers AI 綁定（wrangler.toml 的 [ai]），有綁定就會優先使用
//   WORKERS_AI_MODEL      選填，預設 @cf/qwen/qwen3-30b-a3b-fp8
//   GEMINI_API_KEY        選填（祕密），Google AI Studio 的金鑰，作為備援
//   GEMINI_MODEL          選填，預設 gemini-3.5-flash-lite
//   OPENROUTER_API_KEY    選填（祕密），作為最後備援
//   OPENROUTER_MODEL      選填，預設 openrouter/free
//   ALLOWED_ORIGINS       選填，允許呼叫的其他網域，逗號分隔
//   EMBED_MODEL           選填，語意分流用的向量模型，預設 @cf/baai/bge-m3
//   ROUTE_SOFT / ROUTE_MARGIN  選填，語意分流門檻（見 semantic.js）
//   ROUTE_DEBUG           "1" 時開放 GET /api/route 校正工具
//
// 請求可帶 route：
//   { topics: [...] }   前端關鍵字找到預寫答案 → 先做語意比對，夠像回 { route: 'local' }，不夠像才叫 AI
//   { clarify: true }   顧客在澄清上一題（「我意思是…」）→ 直接叫 AI，並提醒不要重複前一個回答
// =============================================================
import { buildSystemPrompt, TOPICS } from '../../public/kb.js';
import { dietFor } from '../../public/drinks.js';
import { semanticRoute, brief, thresholds } from './semantic.js';
import { CALIBRATION } from './calibration.js';

const MAX_TURNS = 8;
const MAX_CHARS = 400;
const TIMEOUT_MS = 25000;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === new URL(request.url).origin) return true;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes('*') || list.includes(origin);
}

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_CHARS) }))
    .filter(m => m.content)
    .slice(-MAX_TURNS);
}

export function cleanReply(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim()
    .slice(0, 2000);
}

const TOPIC_IDS = new Set(TOPICS.map(t => t.id));
function sanitizeRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const topics = Array.isArray(r.topics) ? r.topics.filter(t => typeof t === 'string' && TOPIC_IDS.has(t)).slice(0, 5) : [];
  const clarify = r.clarify === true;
  return topics.length || clarify ? { topics, clarify } : null;
}

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

class ProviderError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

// ---------- 各家 AI ----------
async function callWorkersAI(env, system, messages) {
  const model = env.WORKERS_AI_MODEL || '@cf/qwen/qwen3-30b-a3b-fp8';
  const isQwen3 = /qwen3/i.test(model);
  const res = await withTimeout(env.AI.run(model, {
    messages: [{ role: 'system', content: system + (isQwen3 ? '\n/no_think' : '') }, ...messages],
    max_tokens: 700,
    temperature: 0.2,
  }));
  const text = typeof res?.response === 'string' ? res.response
    : res?.choices?.[0]?.message?.content ?? (res?.response ? JSON.stringify(res.response) : '');
  return { text, model };
}

async function callGemini(env, system, messages) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const r = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
    }),
  }));
  if (r.status === 429) throw new ProviderError('rate_limited');
  if (!r.ok) throw new ProviderError('upstream', `gemini ${r.status}`);
  const data = await r.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return { text, model };
}

async function callOpenRouter(env, system, messages, origin) {
  const model = env.OPENROUTER_MODEL || 'openrouter/free';
  const r = await withTimeout(fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': origin,
      'X-Title': 'Custom Fee Assistant',
    },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.2, max_tokens: 700 }),
  }));
  if (r.status === 429) throw new ProviderError('rate_limited');
  if (!r.ok) throw new ProviderError('upstream', `openrouter ${r.status}`);
  const data = await r.json();
  if (data?.error) throw new ProviderError(data.error.code === 429 ? 'rate_limited' : 'upstream', data.error.message);
  return { text: data?.choices?.[0]?.message?.content || '', model: data.model || model };
}

export function providers(env) {
  const list = [];
  if (env.AI && typeof env.AI.run === 'function') list.push(['workers-ai', callWorkersAI]);
  if (env.GEMINI_API_KEY) list.push(['gemini', callGemini]);
  if (env.OPENROUTER_API_KEY) list.push(['openrouter', callOpenRouter]);
  return list;
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'forbidden' }, 403);
  const list = providers(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const messages = sanitize(body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_request' }, 400);
  const route = sanitizeRoute(body?.route);
  const question = messages[messages.length - 1].content;

  // 語意分流：關鍵字找到預寫答案時，先確認它真的回答到顧客問的
  let sem = null;
  if (route && !route.clarify && route.topics.length) {
    if (!env.AI) return json({ route: 'local', sem: null }); // 沒有向量模型就維持原本做法
    try {
      sem = await withTimeout(semanticRoute(env, question, route.topics), 8000);
      console.log(JSON.stringify({ evt: 'route', q: question.slice(0, 80), hint: route.topics, ...brief(sem) }));
      if (sem.local) return json({ route: 'local', sem: brief(sem) });
    } catch (e) {
      console.log('[route] embedding failed:', e.message);
      return json({ route: 'local', sem: null });
    }
  }

  if (!list.length) return json({ error: 'missing_key' }, 503);

  // 不含奶／牛奶過敏的推薦題：只給 AI 看不含奶的飲品，避免推薦到含奶的
  const diet = dietFor(messages);
  const system = buildSystemPrompt({
    diet: diet.recommend ? diet.diet : null,
    focus: route ? { topics: route.topics, clarify: route.clarify } : null,
    // 收費規則的問題（不是點單）不需要整份飲品資料，提示短很多、回得更快
    slim: !!(route && !route.clarify && route.topics.length),
  });
  const origin = new URL(request.url).origin;
  let lastCode = 'upstream';
  for (const [name, call] of list) {
    try {
      const { text, model } = await call(env, system, messages, origin);
      const reply = cleanReply(text);
      if (reply) return json({ reply, provider: name, model, route: route ? 'ai' : undefined, sem: sem ? brief(sem) : undefined });
      lastCode = 'empty';
    } catch (e) {
      lastCode = e.code || (e.message === 'timeout' ? 'timeout' : 'upstream');
      console.log(`[chat] ${name} failed:`, e.message);
    }
  }
  return json({ error: lastCode }, lastCode === 'rate_limited' ? 429 : 502);
}

// 校正語意分流用：GET /api/route?q=問題|主題代號&q=…（wrangler.toml 設 ROUTE_DEBUG = "1" 才開放）
// 回傳每句的相似度，方便調整例句與門檻。只算向量，不呼叫聊天模型。
export async function onRouteGet({ request, env }) {
  if (env.ROUTE_DEBUG !== '1' || !env.AI) return json({ error: 'disabled' }, 404);
  const url = new URL(request.url);
  const items = url.searchParams.get('set')
    ? CALIBRATION.map(([q, hint, expect]) => ({ q, hint, expect }))
    : url.searchParams.getAll('q').slice(0, 20).map(x => {
      const [q, hint = ''] = String(x).slice(0, 120).split('|');
      return { q: q.trim(), hint: hint.split(',').map(h => h.trim()).filter(h => TOPIC_IDS.has(h)) };
    }).filter(x => x.q);
  const r2 = x => Math.round(x * 1000) / 1000;
  const results = [];
  for (const it of items) {
    const sem = await semanticRoute(env, it.q, it.hint);
    results.push({
      q: it.q, hint: it.hint.join(','), route: sem.local ? 'local' : 'ai', expect: it.expect, ok: it.expect ? it.expect === (sem.local ? 'local' : 'ai') : undefined,
      hinted: r2(sem.hinted.score), best: `${sem.best.topic} ${r2(sem.best.score)}`,
      near: r2(sem.near.score), nearEx: sem.near.text,
      top: sem.top.map(t => `${t.topic} ${r2(t.score)} ${t.text}`),
    });
  }
  const graded = results.filter(r => r.expect);
  return json({ th: thresholds(env), correct: graded.length ? `${graded.filter(r => r.ok).length}/${graded.length}` : undefined, results });
}

// 健康檢查：GET /api/chat（不會顯示金鑰）
export async function onRequestGet({ env }) {
  return json({
    ok: true,
    ai: providers(env).length > 0,
    providers: providers(env).map(([n]) => n),
    model: env.WORKERS_AI_MODEL || '@cf/qwen/qwen3-30b-a3b-fp8',
  });
}
