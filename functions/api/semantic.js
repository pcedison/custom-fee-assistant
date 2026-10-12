// =============================================================
// 語意分流：用 Cloudflare Workers AI 的多語向量模型（bge-m3）判斷
// 「關鍵字找到的預寫答案，是否真的回答到顧客問的」。
//   夠像預寫答案能回答的問法 → 直接用預寫答案（快、免費）
//   比較像「提到關鍵字但沒回答到」的問法，或都不夠像 → 交給 AI
// 例句在 public/kb.js 的 ROUTE_EXAMPLES、ROUTE_NEAR_MISS。
// =============================================================
import { ROUTE_EXAMPLES, ROUTE_NEAR_MISS } from '../../public/kb.js';

export const EMBED_MODEL = '@cf/baai/bge-m3';
const NEAR = '_near';
const BATCH = 50;

// 門檻可用環境變數調整（wrangler.toml 的 [vars]）
export function thresholds(env = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  return {
    hard: num(env.ROUTE_ACCEPT, 0.82), // 這麼像就直接用預寫答案
    soft: num(env.ROUTE_SOFT, 0.7), //    在這之上，還要比「沒回答到」的例句明顯更像
    margin: num(env.ROUTE_MARGIN, 0.05),
  };
}

export const BANK = [
  ...Object.entries(ROUTE_EXAMPLES).flatMap(([topic, list]) => list.map(text => ({ topic, text }))),
  ...ROUTE_NEAR_MISS.map(text => ({ topic: NEAR, text })),
];

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

async function embed(env, texts) {
  const model = env.EMBED_MODEL || EMBED_MODEL;
  const chunks = [];
  for (let i = 0; i < texts.length; i += BATCH) chunks.push(texts.slice(i, i + BATCH));
  const parts = await Promise.all(chunks.map(async chunk => {
    const res = await env.AI.run(model, { text: chunk });
    const vecs = Array.isArray(res?.data) ? res.data : Array.isArray(res?.response) ? res.response : null;
    if (!vecs || vecs.length !== chunk.length || !Array.isArray(vecs[0])) throw new Error('embedding: unexpected response');
    return vecs.map(unit);
  }));
  return parts.flat();
}

// 例句向量每個 Worker 執行個體只算一次
let bankPromise = null;
function bankVectors(env) {
  if (!bankPromise) {
    bankPromise = embed(env, BANK.map(b => b.text))
      .then(vecs => BANK.map((b, i) => ({ ...b, v: vecs[i] })))
      .catch(e => { bankPromise = null; throw e; });
  }
  return bankPromise;
}
export function resetBank() { bankPromise = null; }

// 純函式：依分數決定用預寫答案還是交給 AI（方便測試）
export function decideRoute(scored, hintTopics, th) {
  const hint = new Set(hintTopics);
  let best = { topic: null, score: -1, text: '' };
  let hinted = { topic: null, score: -1, text: '' };
  let near = { score: -1, text: '' };
  for (const s of scored) {
    if (s.topic === NEAR) { if (s.score > near.score) near = s; continue; }
    if (s.score > best.score) best = s;
    if (hint.has(s.topic) && s.score > hinted.score) hinted = s;
  }
  const local = hinted.score >= th.hard
    || (hinted.score >= th.soft && hinted.score >= near.score + th.margin && hinted.score >= best.score - 0.02);
  return { local, hinted, best, near };
}

export async function semanticRoute(env, query, hintTopics) {
  const [bank, [q]] = await Promise.all([bankVectors(env), embed(env, [query])]);
  const scored = bank.map(b => ({ topic: b.topic, text: b.text, score: dot(q, b.v) }));
  return decideRoute(scored, hintTopics, thresholds(env));
}

// 回給前端（除錯畫面用）的精簡資訊
export function brief(r) {
  const r2 = x => Math.round(x * 100) / 100;
  return {
    local: r.local,
    topic: r.hinted.topic, score: r2(r.hinted.score), example: r.hinted.text,
    best: r.best.topic, bestScore: r2(r.best.score),
    near: r2(r.near.score), nearExample: r.near.text,
  };
}
