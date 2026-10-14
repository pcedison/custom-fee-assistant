// =============================================================
// Cloudflare Workers 入口：/api/chat 交給 AI 處理，/api/e 記錄匿名使用統計，其餘交給靜態檔（public/）
// =============================================================
import { onRequestPost, onRequestGet, onRouteGet } from '../functions/api/chat.js';
import { onEventPost, onStatsCron } from '../functions/api/stats.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/chat') {
      if (request.method === 'POST') return onRequestPost({ request, env, ctx });
      if (request.method === 'GET') return onRequestGet({ request, env, ctx });
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    if (url.pathname === '/api/route' && request.method === 'GET') return onRouteGet({ request, env, ctx });
    if (url.pathname === '/api/e') {
      if (request.method === 'POST') return onEventPost({ request, env, ctx });
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    return env.ASSETS.fetch(request);
  },
  // 每天台北時間 03:00：清掉過期的原句與鹽值
  async scheduled(event, env, ctx) {
    ctx.waitUntil(onStatsCron(env));
  },
};
