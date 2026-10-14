// =============================================================
// 後台：客製化加價小幫手的使用統計（只有自己看得到）
//   門禁：Cloudflare Access（workers.dev 一鍵開啟）＋ 這裡再驗證一次 Access 的 JWT
//   - TEAM_DOMAIN、POLICY_AUD 沒設定 → 只顯示設定頁，不給任何資料（fail closed）
//   - 沒有 Access 的 JWT → 拒絕
// 資料：和主站同一個 D1（binding DB），只讀取；原句只在這裡顯示
// =============================================================
import PAGE from './dashboard.html';
import { checkAccess } from './access.js';
import { ensureSchema } from './schema.js';
import {
  regionLabel, DEVICE_LABEL, VIA_LABEL, KIND_LABEL, FROM_LABEL, mergeDrinks, rangeStart, RANGES,
  toCSV, parseList, fmtTaipei, netLabel, questionRegion,
} from './lib.js';

const SEC = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

// ---------- 頁面 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function infoPage(title, body, status = 403) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font:16px/1.7 "PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif;background:#F2F0EB;color:#1F1F1F}
main{max-width:640px;margin:48px auto;padding:0 16px}h1{font-size:22px;color:#1E3932}code{background:#fff;border:1px solid #E1DDD3;border-radius:6px;padding:2px 6px;word-break:break-all}
li{margin:6px 0}@media (prefers-color-scheme:dark){body{background:#0F1B17;color:#F2F0EB}h1{color:#D4E9E2}code{background:#1A2D26;border-color:#2B443A}}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { ...SEC, 'Content-Type': 'text/html; charset=utf-8' } });
}
function denyPage(a) {
  if (a.why === 'setup') {
    return infoPage('後台設定還差一步', `<p>Cloudflare Access 已經開啟。請把下面兩個值傳給 Claude，或填進 <code>admin/wrangler.toml</code> 的 <code>[vars]</code>：</p>
<ul><li>TEAM_DOMAIN：<code>${esc(a.iss || '（讀不到）')}</code></li><li>POLICY_AUD：<code>${esc(a.aud || '（讀不到）')}</code></li></ul>
<p>設定完成前，這裡不會顯示任何資料。</p>`);
  }
  if (a.why === 'no_access') {
    return infoPage('後台尚未開啟門禁', '<p>請先在 Cloudflare 主控台開啟 Cloudflare Access：Workers &amp; Pages → custom-fee-admin → Settings → Domains &amp; Routes → workers.dev → Enable Cloudflare Access。</p><p>開啟前，這裡不會顯示任何資料。</p>');
  }
  return infoPage('沒有權限', '<p>這個後台只開放給管理者。</p>');
}

// ---------- 統計 ----------
const count = rows => rows.map(r => ({ label: r.label, n: r.n }));
function groupBy(rows, labelOf) {
  const m = new Map();
  for (const r of rows) {
    const k = labelOf(r);
    m.set(k, (m.get(k) || 0) + r.n);
  }
  return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

async function stats(db, range) {
  const since = rangeStart(range);
  const q = sql => db.prepare(sql).bind(since);
  const res = await db.batch([
    q('SELECT COUNT(*) AS visits, COUNT(DISTINCT day || vid) AS users FROM visits WHERE day >= ?1'),
    q(`SELECT COUNT(*) AS questions, SUM(via IN ('ai', 'ai_order')) AS ai, SUM(typos IS NOT NULL) AS typos,
        SUM(kind = 'choose') AS chooses, SUM(kind IN ('text', 'none') AND via = 'local') AS unclear,
        COUNT(DISTINCT day || vid) AS askers FROM questions WHERE day >= ?1`),
    q('SELECT country, region_code, region, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1, 2, 3'),
    q('SELECT country, region_code, region, city, COUNT(*) AS n FROM visits WHERE day >= ?1 AND city IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 40'),
    q('SELECT device AS label, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC'),
    q('SELECT os AS label, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC'),
    q('SELECT browser AS label, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC'),
    q('SELECT source AS label, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC LIMIT 15'),
    q('SELECT net AS label, COUNT(*) AS n FROM visits WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC LIMIT 30'),
    q('SELECT hour, COUNT(*) AS n FROM questions WHERE day >= ?1 GROUP BY hour'),
    q(`SELECT day, SUM(v) AS visits, SUM(qn) AS questions FROM (
        SELECT day, 1 AS v, 0 AS qn FROM visits WHERE day >= ?1
        UNION ALL SELECT day, 0, 1 FROM questions WHERE day >= ?1) GROUP BY day ORDER BY day`),
    q(`SELECT j.value AS name, COUNT(*) AS n FROM questions, json_each(questions.drinks) AS j
        WHERE questions.day >= ?1 AND questions.drinks IS NOT NULL GROUP BY j.value ORDER BY n DESC LIMIT 80`),
    q(`SELECT j.value AS label, COUNT(*) AS n FROM questions, json_each(questions.topics) AS j
        WHERE questions.day >= ?1 AND questions.topics IS NOT NULL GROUP BY j.value ORDER BY n DESC LIMIT 10`),
    q(`SELECT j.value AS label, COUNT(*) AS n FROM questions, json_each(questions.typos) AS j
        WHERE questions.day >= ?1 AND questions.typos IS NOT NULL GROUP BY j.value ORDER BY n DESC LIMIT 10`),
    q(`SELECT fuzzy AS label, COUNT(*) AS n FROM questions WHERE day >= ?1 AND fuzzy IS NOT NULL
        GROUP BY fuzzy ORDER BY n DESC LIMIT 10`),
    q('SELECT origin AS label, COUNT(*) AS n FROM questions WHERE day >= ?1 GROUP BY 1 ORDER BY n DESC'),
  ]);
  const r = i => res[i].results || [];
  const k1 = r(0)[0] || {}, k2 = r(1)[0] || {};
  const hours = Array(24).fill(0);
  for (const h of r(9)) if (h.hour >= 0 && h.hour < 24) hours[h.hour] = h.n;
  const cityRegion = new Map(r(3).map(x => [x.city, regionLabel(x)]));
  const cities = groupBy(r(3), x => x.city).slice(0, 10).map(x => ({ ...x, sub: cityRegion.get(x.label) }));
  return {
    range, since, days: RANGES[range] || 7,
    kpi: {
      visits: k1.visits || 0, users: k1.users || 0, questions: k2.questions || 0, askers: k2.askers || 0,
      ai: k2.ai || 0, typos: k2.typos || 0, chooses: k2.chooses || 0, unclear: k2.unclear || 0,
    },
    regions: groupBy(r(2), regionLabel),
    cities,
    devices: groupBy(r(4), x => DEVICE_LABEL[x.label] || '其他'),
    os: count(r(5)).map(x => ({ ...x, label: x.label || '其他' })),
    browsers: count(r(6)).map(x => ({ ...x, label: x.label || '其他' })),
    sources: count(r(7)).map(x => ({ ...x, label: x.label || '直接開啟' })),
    nets: groupBy(r(8), x => netLabel(x.label)).slice(0, 10),
    hours,
    daily: r(10),
    drinks: mergeDrinks(r(11), 10),
    topics: count(r(12)),
    typos: count(r(13)),
    fuzzy: count(r(14)),
    origins: groupBy(r(15), x => FROM_LABEL[x.label] || '輸入'),
  };
}

const FILTERS = {
  all: '',
  ai: "AND via IN ('ai', 'ai_order')",
  typo: 'AND typos IS NOT NULL',
  choose: "AND kind = 'choose'",
  fuzzy: 'AND fuzzy IS NOT NULL',
  unclear: "AND kind IN ('text', 'none')",
};
async function questions(db, range, filter, limit, before) {
  const since = rangeStart(range);
  const where = FILTERS[filter] ?? '';
  const sql = `SELECT ts, text, via, kind, drinks, topics, typos, fuzzy, origin, region_code, device FROM questions
    WHERE day >= ?1 ${where} ${before ? 'AND ts < ?3' : ''} ORDER BY ts DESC LIMIT ?2`;
  const stmt = before ? db.prepare(sql).bind(since, limit, before) : db.prepare(sql).bind(since, limit);
  const { results = [] } = await stmt.all();
  return results.map(x => ({
    ts: x.ts, time: fmtTaipei(x.ts), text: x.text, via: VIA_LABEL[x.via] || x.via, viaKey: x.via,
    kind: KIND_LABEL[x.kind] || x.kind, drinks: parseList(x.drinks), topics: parseList(x.topics),
    typos: parseList(x.typos), fuzzy: x.fuzzy, from: FROM_LABEL[x.origin] || '輸入',
    region: questionRegion(x.region_code),
    device: DEVICE_LABEL[x.device] || '',
  }));
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: SEC });
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const a = await checkAccess(request, env);
    if (!a.ok) return url.pathname.startsWith('/api/') ? json({ error: a.why }, 403) : denyPage(a);

    if (url.pathname === '/') {
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      const body = PAGE.replaceAll('{{NONCE}}', nonce).replace('{{DB}}', env.DB ? '1' : '0');
      return new Response(body, { headers: { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp } });
    }
    if (!env.DB) return json({ error: 'no_db' }, 503);
    await ensureSchema(env.DB);
    const range = RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '7';

    if (url.pathname === '/api/stats') return json(await stats(env.DB, range));
    if (url.pathname === '/api/questions') {
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit')) || 50));
      const before = Number(url.searchParams.get('before')) || 0;
      return json(await questions(env.DB, range, url.searchParams.get('filter') || 'all', limit, before));
    }
    if (url.pathname === '/api/questions.csv') {
      const rows = await questions(env.DB, range, url.searchParams.get('filter') || 'all', 5000, 0);
      const csv = toCSV(
        ['時間（台北）', '原句', '回答方式', '回答類型', '判讀飲品', '問題類型', '自動更正', '模糊比對的字', '提問方式', '縣市', '裝置'],
        rows.map(x => [x.time, x.text ?? '（已過保留期限）', x.via, x.kind, x.drinks.join('、'), x.topics.join('、'), x.typos.join('、'), x.fuzzy, x.from, x.region, x.device]),
      );
      return new Response(csv, {
        headers: { ...SEC, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="questions-${rangeStart(range)}.csv"` },
      });
    }
    return json({ error: 'not_found' }, 404);
  },
};
