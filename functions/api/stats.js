// =============================================================
// 匿名使用統計：POST /api/e（頁面用 sendBeacon 送來）
//   t: 'v' 開啟頁面｜'q' 一次提問
// 記錄：縣市（Cloudflare 用 IP 推算）、網路業者、裝置、作業系統、瀏覽器、開啟來源、提問原句與判讀結果
// 不記錄：IP、cookie、手機型號；原句裡的電話、Email、身分證字號、卡號、長串數字先遮掉
// 沒有連接 D1（env.DB）時什麼都不做，主站照常運作
// =============================================================
import { ensureSchema, taipei } from '../../admin/schema.js';

const MAX_BODY = 4096;
const RATE = { windowMs: 60e3, max: 40 };
const hits = new Map(); // ip → { start, n }（只在記憶體，不寫入資料庫）

const RE_BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|curl|wget|python-requests/i;

// ---------- 裝置、作業系統、瀏覽器 ----------
export function parseUA(ua = '', touchPoints = 0) {
  const s = String(ua);
  let os = '其他', device = 'desktop';
  if (/iPhone|iPod/.test(s)) { os = 'iOS'; device = 'mobile'; }
  else if (/iPad/.test(s) || (/Macintosh/.test(s) && touchPoints > 1)) { os = 'iPadOS'; device = 'tablet'; }
  else if (/Android/.test(s)) { os = 'Android'; device = /Mobile/.test(s) ? 'mobile' : 'tablet'; }
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let browser = '其他';
  if (/\bLine\//i.test(s)) browser = 'LINE';
  else if (/FBAN|FBAV|FB_IAB|FBIOS/.test(s)) browser = 'Facebook';
  else if (/Instagram/.test(s)) browser = 'Instagram';
  else if (/Threads/.test(s)) browser = 'Threads';
  else if (/MicroMessenger/.test(s)) browser = 'WeChat';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung';
  else if (/EdgA?\/|EdgiOS/.test(s)) browser = 'Edge';
  else if (/OPR\/|OPiOS/.test(s)) browser = 'Opera';
  else if (/Firefox|FxiOS/.test(s)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari/.test(s)) browser = 'Safari';
  return { os, device, browser };
}

// ---------- 開啟來源 ----------
const REF_SOURCES = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)yahoo\./, 'Yahoo'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'],
  [/(^|\.)(line\.me|line-apps\.com|lin\.ee)$/, 'LINE'],
  [/(^|\.)(t\.co|x\.com|twitter\.com)$/, 'X'],
  [/(^|\.)dcard\.tw$/, 'Dcard'],
  [/(^|\.)ptt\.cc$/, 'PTT'],
];
export function sourceOf({ ref = '', utm = '', browser = '', host = '' } = {}) {
  if (['LINE', 'Facebook', 'Instagram', 'Threads', 'WeChat'].includes(browser)) return browser;
  const u = String(utm || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
  if (u) return `utm:${u}`;
  let h = '';
  try { h = new URL(ref).hostname.toLowerCase(); } catch { /* 沒有來源 */ }
  if (!h || h === host) return '直接開啟';
  for (const [re, name] of REF_SOURCES) if (re.test(h)) return name;
  return h.slice(0, 60);
}

// ---------- 原句：遮掉個人資料 ----------
const PII = [
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, // Email
  /\b[a-z][12489]\d{8}\b/gi, // 身分證字號、居留證號
  /(\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, // 手機
  /\(?0\d{1,2}\)?[-\s]?\d{3,4}[-\s]?\d{4}/g, // 市話
  /\d(?:[-\s]?\d){7,}/g, // 卡號、帳號、其他 8 碼以上數字
];
export function maskPII(text) {
  let s = String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  for (const re of PII) s = s.replace(re, '［已遮蔽］');
  return s;
}

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const list = (v, n = 6, len = 40) => {
  const a = Array.isArray(v) ? v.map(x => str(x, len)).filter(Boolean).slice(0, n) : [];
  return a.length ? JSON.stringify(a) : null;
};
const oneOf = (v, ok, dflt) => (ok.includes(v) ? v : dflt);

// ---------- 每天更換的鹽值 ----------
let saltCache = { day: null, salt: null };
async function dailySalt(db, day) {
  if (saltCache.day === day) return saltCache.salt;
  let row = await db.prepare('SELECT salt FROM salts WHERE day = ?1').bind(day).first();
  if (!row) {
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?1, ?2)').bind(day, salt),
      db.prepare('DELETE FROM salts WHERE day < ?1').bind(day),
    ]);
    row = await db.prepare('SELECT salt FROM salts WHERE day = ?1').bind(day).first();
  }
  saltCache = { day, salt: row.salt };
  return row.salt;
}
async function visitorId(db, day, ip, ua) {
  const salt = await dailySalt(db, day);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}|${ua}`));
  return [...new Uint8Array(buf).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > RATE.windowMs) {
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  h.n += 1;
  return h.n > RATE.max;
}

const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export async function onEventPost({ request, env, ctx }) {
  if (!env.DB) return done();
  const url = new URL(request.url);
  // 只收自己網頁送來的
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return done();
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return done();
  const ua = request.headers.get('User-Agent') || '';
  if (RE_BOT.test(ua)) return done();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (limited(ip)) return done();

  const raw = await request.text();
  if (!raw || raw.length > MAX_BODY) return done();
  let b;
  try { b = JSON.parse(raw); } catch { return done(); }
  if (!b || (b.t !== 'v' && b.t !== 'q')) return done();

  const work = (async () => {
    const db = env.DB;
    await ensureSchema(db);
    const ts = Date.now();
    const { day, hour } = taipei(ts);
    const cf = request.cf || {};
    const tp = Number.isFinite(b.tp) ? b.tp : 0;
    const { os, device, browser } = parseUA(ua, tp);
    const vid = await visitorId(db, day, ip, ua);
    const regionCode = str(cf.regionCode, 10);
    if (b.t === 'v') {
      await db.prepare(`INSERT INTO visits (ts, day, hour, vid, country, region_code, region, city, net, device, os, browser, source)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
        .bind(ts, day, hour, vid, str(cf.country, 4), regionCode, str(cf.region, 60), str(cf.city, 60),
          str(cf.asOrganization, 80), device, os, browser,
          sourceOf({ ref: str(b.ref, 300) || '', utm: b.utm, browser, host: url.hostname }))
        .run();
    } else {
      const text = maskPII(b.q);
      if (!text) return;
      await db.prepare(`INSERT INTO questions (ts, day, hour, vid, text, via, kind, drinks, topics, typos, fuzzy, origin, region_code, device)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
        .bind(ts, day, hour, vid, text,
          oneOf(b.via, ['local', 'ai', 'ai_order', 'error'], 'local'),
          oneOf(b.kind, ['drink', 'followup', 'multi', 'choose', 'quote', 'faq', 'refs', 'text', 'none'], 'text'),
          list(b.drinks), list(b.topics), list(b.typos), str(b.fuzzy, 30),
          oneOf(b.from, ['typed', 'chip', 'tap'], 'typed'),
          cf.country === 'TW' ? regionCode : (cf.country ? `@${str(cf.country, 4)}` : null), device)
        .run();
    }
  })().catch(e => console.warn('[stats]', e?.message || e));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return done();
}

// 每天清理一次（cron）：原句保留 STATS_TEXT_DAYS 天（預設 180），過期只刪原句，統計數字保留
export async function onStatsCron(env) {
  if (!env.DB) return;
  const db = env.DB;
  await ensureSchema(db);
  const days = Math.max(7, Number(env.STATS_TEXT_DAYS) || 180);
  const { day } = taipei();
  await db.batch([
    db.prepare('UPDATE questions SET text = NULL WHERE ts < ?1 AND text IS NOT NULL').bind(Date.now() - days * 86400e3),
    db.prepare('DELETE FROM salts WHERE day < ?1').bind(day),
  ]);
}
