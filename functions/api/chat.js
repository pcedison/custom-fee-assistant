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
// =============================================================
import { buildSystemPrompt } from '../../public/kb.js';

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
  if (!list.length) return json({ error: 'missing_key' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const messages = sanitize(body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_request' }, 400);

  const system = buildSystemPrompt();
  const origin = new URL(request.url).origin;
  let lastCode = 'upstream';
  for (const [name, call] of list) {
    try {
      const { text, model } = await call(env, system, messages, origin);
      const reply = cleanReply(text);
      if (reply) return json({ reply, provider: name, model });
      lastCode = 'empty';
    } catch (e) {
      lastCode = e.code || (e.message === 'timeout' ? 'timeout' : 'upstream');
      console.log(`[chat] ${name} failed:`, e.message);
    }
  }
  return json({ error: lastCode }, lastCode === 'rate_limited' ? 429 : 502);
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
