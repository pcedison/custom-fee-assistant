// =============================================================
// Cloudflare Workers 入口：/api/chat 交給 AI 處理，其餘交給靜態檔（public/）
// =============================================================
import { onRequestPost, onRequestGet } from '../functions/api/chat.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/chat') {
      if (request.method === 'POST') return onRequestPost({ request, env, ctx });
      if (request.method === 'GET') return onRequestGet({ request, env, ctx });
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    return env.ASSETS.fetch(request);
  },
};
