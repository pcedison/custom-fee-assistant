// =============================================================
// Cloudflare Access：驗證 Cf-Access-Jwt-Assertion（RS256，金鑰取自 <TEAM_DOMAIN>/cdn-cgi/access/certs）
//   TEAM_DOMAIN、POLICY_AUD 沒設定 → why: 'setup'（回傳 token 裡的 iss、aud 給設定頁顯示，不給資料）
// =============================================================
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64json = s => JSON.parse(new TextDecoder().decode(b64url(s)));
let certCache = { url: null, at: 0, keys: [] };
async function accessKeys(team) {
  const url = `${team}/cdn-cgi/access/certs`;
  if (certCache.url === url && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys = [] } = await res.json();
  certCache = { url, at: Date.now(), keys };
  return keys;
}
function tokenOf(request) {
  const h = request.headers.get('Cf-Access-Jwt-Assertion');
  if (h) return h;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}
export async function checkAccess(request, env) {
  const url = new URL(request.url);
  // 只在本機開發（wrangler dev）時可略過
  if (env.DEV_NO_ACCESS === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) return { ok: true, email: 'local' };
  const token = tokenOf(request);
  if (!token) return { ok: false, why: 'no_access' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, why: 'bad_token' };
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { return { ok: false, why: 'bad_token' }; }
  const team = String(env.TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  const aud = String(env.POLICY_AUD || '').trim();
  if (!team || !aud) {
    return { ok: false, why: 'setup', iss: payload.iss, aud: Array.isArray(payload.aud) ? payload.aud[0] : payload.aud };
  }
  const now = Date.now() / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== team || !auds.includes(aud) || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) {
    return { ok: false, why: 'denied' };
  }
  try {
    const jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return { ok: false, why: 'denied' };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!good) return { ok: false, why: 'denied' };
  } catch {
    return { ok: false, why: 'denied' };
  }
  const allow = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (allow && String(payload.email || '').toLowerCase() !== allow) return { ok: false, why: 'denied' };
  return { ok: true, email: payload.email };
}
