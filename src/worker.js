// =============================================================
// Cloudflare Workers 入口：/api/chat 交給 AI 處理，其餘交給靜態檔（public/）
// =============================================================
import { onRequestPost, onRequestGet, onRouteGet } from '../functions/api/chat.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/chat') {
      if (request.method === 'POST') return onRequestPost({ request, env, ctx });
      if (request.method === 'GET') return onRequestGet({ request, env, ctx });
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    if (url.pathname === '/api/route' && request.method === 'GET') return onRouteGet({ request, env, ctx });
    return env.ASSETS.fetch(request);
  },
};
