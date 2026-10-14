// =============================================================
// 後台用的小工具（純函式，可在 Node 測試）
// =============================================================
import { taipei } from './schema.js';

// Cloudflare 的 regionCode（ISO 3166-2:TW，不含 TW-）→ 縣市
export const TW_REGIONS = {
  KEE: '基隆市', TPE: '台北市', NWT: '新北市', TPQ: '新北市', TAO: '桃園市', TYC: '桃園市',
  HSZ: '新竹市', HSQ: '新竹縣', MIA: '苗栗縣', TXG: '台中市', TXQ: '台中市', CHA: '彰化縣',
  NAN: '南投縣', YUN: '雲林縣', CYI: '嘉義市', CYQ: '嘉義縣', TNN: '台南市', TNQ: '台南市',
  KHH: '高雄市', KHQ: '高雄市', PIF: '屏東縣', ILA: '宜蘭縣', HUA: '花蓮縣', TTT: '台東縣',
  PEN: '澎湖縣', KIN: '金門縣', LIE: '連江縣',
};
// 英文名稱（regionCode 缺漏時用 region 對照）
const TW_REGION_NAMES = {
  'keelung city': '基隆市', 'taipei city': '台北市', taipei: '台北市', 'new taipei': '新北市', 'new taipei city': '新北市',
  'taoyuan city': '桃園市', taoyuan: '桃園市', 'hsinchu city': '新竹市', 'hsinchu county': '新竹縣', 'miaoli county': '苗栗縣',
  'taichung city': '台中市', taichung: '台中市', 'changhua county': '彰化縣', 'nantou county': '南投縣', 'yunlin county': '雲林縣',
  'chiayi city': '嘉義市', 'chiayi county': '嘉義縣', 'tainan city': '台南市', tainan: '台南市', 'kaohsiung city': '高雄市',
  kaohsiung: '高雄市', 'pingtung county': '屏東縣', 'yilan county': '宜蘭縣', 'hualien county': '花蓮縣',
  'taitung county': '台東縣', 'penghu county': '澎湖縣', 'kinmen county': '金門縣', 'lienchiang county': '連江縣',
};

export function regionLabel({ country, region_code: code, region }) {
  if (country === 'TW') {
    const c = String(code || '').replace(/^TW-/, '').toUpperCase();
    return TW_REGIONS[c] || TW_REGION_NAMES[String(region || '').toLowerCase()] || (region ? `台灣（${region}）` : '台灣（縣市不明）');
  }
  if (!country) return '不明';
  return `海外：${country}${region ? ` ${region}` : ''}`;
}

// 提問紀錄只存縣市代碼；海外存成「@國碼」
export function questionRegion(code) {
  if (!code) return '';
  if (code.startsWith('@')) return `海外：${code.slice(1)}`;
  return regionLabel({ country: 'TW', region_code: code });
}

// 網路業者（Cloudflare asOrganization）→ 常用名稱
const NETS = [
  [/chunghwa|hinet/i, '中華電信'], [/taiwan mobile|twm|taiwan cellular/i, '台灣大哥大'], [/far ?eastone|fetnet|new century/i, '遠傳電信'],
  [/taiwan star|vibo/i, '台灣之星'], [/asia pacific telecom|aptg/i, '亞太電信'], [/so-?net/i, 'So-net'],
  [/taiwan fixed|tfn/i, '台灣固網'], [/kbro/i, '凱擘大寬頻'], [/taiwan broadband|tbc/i, '台灣寬頻'], [/homeplus|digital united/i, '數位聯合'],
  [/google/i, 'Google'], [/amazon|aws/i, 'Amazon'], [/microsoft|azure/i, 'Microsoft'], [/cloudflare/i, 'Cloudflare'],
];
export function netLabel(org) {
  if (!org) return '不明';
  for (const [re, name] of NETS) if (re.test(org)) return name;
  return String(org).slice(0, 40);
}

export const DEVICE_LABEL = { mobile: '手機', tablet: '平板', desktop: '電腦' };
export const VIA_LABEL = { local: '規則', ai: 'AI', ai_order: 'AI 判讀＋規則計算', error: '失敗' };
export const KIND_LABEL = { followup: '追問上一杯', drink: '單杯', multi: '多杯', choose: '請選飲品', quote: '加價', faq: '常見問題', refs: '飲品清單', text: '文字', none: '沒有回答' };
export const FROM_LABEL = { typed: '輸入', chip: '點建議問題', tap: '點選飲品' };

// 「冰那堤」「熱那堤」合併成「那堤」（冰搖系列的「冰」是品名）
export const baseName = n => String(n || '').replace(/^熱/, '').replace(/^冰(?!搖)/, '');
export function mergeDrinks(rows, top = 10) {
  const m = new Map();
  for (const { name, n } of rows) {
    const k = baseName(name);
    if (!k) continue;
    const e = m.get(k) || { name: k, n: 0, parts: {} };
    e.n += n;
    e.parts[name] = (e.parts[name] || 0) + n;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh-Hant')).slice(0, top);
}

// 期間：today / 7 / 30 / 90 → 起始日期（台北時間）
export const RANGES = { today: 1, 7: 7, 30: 30, 90: 90 };
export function rangeStart(range, now = Date.now()) {
  const days = RANGES[range] || 7;
  return taipei(now - (days - 1) * 86400e3).day;
}

// CSV（Excel 開啟用 UTF-8 BOM）
const cell = v => {
  const s = v == null ? '' : String(v);
  // 避免 Excel 把開頭是 = + - @ 的內容當成公式
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function toCSV(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export const parseList = s => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
export function fmtTaipei(ts) {
  const d = new Date(ts + 8 * 3600e3).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}
