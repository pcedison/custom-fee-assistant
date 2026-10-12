// =============================================================
// Cloudflare Pages Function：POST /api/chat
// 代理 OpenRouter 免費模型；API 金鑰只存在 Cloudflare 環境變數，前端看不到
//
// 環境變數（Cloudflare Pages → 設定 → 變數和祕密）：
//   OPENROUTER_API_KEY   必填，OpenRouter 的 API 金鑰（請設為「祕密」）
//   OPENROUTER_MODEL     選填，預設 openrouter/free（自動挑選可用的免費模型）
//   OPENROUTER_FALLBACKS 選填，備援模型，逗號分隔，例如 "qwen/qwen3-8b:free,meta-llama/llama-3.3-8b-instruct:free"
//   ALLOWED_ORIGINS      選填，允許呼叫的網域，逗號分隔（預設只允許自己的網域）
// =============================================================
import { buildSystemPrompt } from '../../public/kb.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TURNS = 10;
const MAX_CHARS = 500;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // 同站的一般請求有時不帶 Origin
  const self = new URL(request.url).origin;
  if (origin === self) return true;
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

function cleanReply(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim()
    .slice(0, 2000);
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request, env)) return json({ error: 'forbidden' }, 403);
  if (!env.OPENROUTER_API_KEY) return json({ error: 'missing_key' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const messages = sanitize(body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json({ error: 'bad_request' }, 400);
  }

  const payload = {
    model: env.OPENROUTER_MODEL || 'openrouter/free',
    messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
    temperature: 0.3,
    max_tokens: 1200,
  };
  const fallbacks = (env.OPENROUTER_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fallbacks.length) {
    payload.models = [payload.model, ...fallbacks];
    delete payload.model;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35000);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': new URL(request.url).origin,
        'X-Title': 'Custom Fee Assistant',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    return json({ error: e.name === 'AbortError' ? 'timeout' : 'upstream' }, 504);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    return json({ error: 'rate_limited' }, 429, retry ? { 'Retry-After': retry } : {});
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* 忽略 */ }
    console.log('OpenRouter error', res.status, detail);
    return json({ error: res.status === 401 ? 'bad_key' : 'upstream' }, 502);
  }

  let data;
  try { data = await res.json(); } catch { return json({ error: 'upstream' }, 502); }
  if (data?.error) {
    console.log('OpenRouter error', data.error?.code, data.error?.message);
    return json({ error: data.error?.code === 429 ? 'rate_limited' : 'upstream' }, 502);
  }
  const reply = cleanReply(data?.choices?.[0]?.message?.content);
  if (!reply) return json({ error: 'empty' }, 502);
  return json({ reply, model: data.model || payload.model || payload.models[0] });
}

// 健康檢查：GET /api/chat 可確認金鑰是否已設定（不會顯示金鑰）
export async function onRequestGet({ env }) {
  return json({ ok: true, ai: !!env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'openrouter/free' });
}
