// 產生 public/homophones.js：同音字表（不分聲調），給「同音錯字」自動更正用
//
// 用法（只有換季、新品出現新字時才需要重跑）：
//   npm i --no-save pinyin-pro
//   node scripts/build-homophones.mjs
//
// 收錄範圍：Big5 常用字（第一字面，約 5,400 字）＋所有品名、別稱、加料用字。
// 讀音：pinyin-pro（含多音字），再補上台灣讀音和大陸不同的字（TW_EXTRA）。
import { writeFileSync } from 'node:fs';
import { pinyin } from 'pinyin-pro';
import { DRINKS, DRINK_ALIASES } from '../public/drinks.js';
import { ITEMS } from '../public/kb.js';

// 台灣讀音（教育部）和 pinyin-pro 預設不同的字：保留兩種讀音
const TW_EXTRA = {
  堤: ['ti'], // 那堤：台灣讀ㄊㄧˊ
  液: ['yi'], // 抹茶液、咖啡液：台灣讀ㄧˋ
};

const chars = new Set();
const dec = new TextDecoder('big5');
for (let hi = 0xA4; hi <= 0xC6; hi++) {
  for (let lo = 0x40; lo <= 0xFE; lo++) {
    if ((lo > 0x7E && lo < 0xA1) || (hi === 0xC6 && lo > 0x7E)) continue;
    const ch = dec.decode(new Uint8Array([hi, lo]));
    if (ch && ch !== '�' && /\p{Script=Han}/u.test(ch)) chars.add(ch);
  }
}
const lexicon = [
  ...DRINKS.map(d => d.n),
  ...Object.entries(DRINK_ALIASES).flat(2),
  ...ITEMS.flatMap(it => (it.names || []).map(n => (typeof n === 'string' ? n : n.n))),
];
for (const ch of lexicon.join('')) if (/\p{Script=Han}/u.test(ch)) chars.add(ch);

const bySyl = new Map();
for (const ch of chars) {
  const rs = new Set(pinyin(ch, { toneType: 'none', multiple: true, type: 'array' }).map(s => s.replace('ü', 'v')));
  for (const r of TW_EXTRA[ch] || []) rs.add(r);
  for (const r of rs) {
    if (!/^[a-z]+$/.test(r)) continue;
    if (!bySyl.has(r)) bySyl.set(r, '');
    bySyl.set(r, bySyl.get(r) + ch);
  }
}
const sorted = [...bySyl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const body = sorted.map(([s, cs]) => `  ${s}: '${cs}',`).join('\n');
writeFileSync(new URL('../public/homophones.js', import.meta.url), `// 自動產生，請勿手改：node scripts/build-homophones.mjs
// 同音字表（不分聲調）：讀音 → 這個讀音的常用字。${chars.size} 字、${sorted.length} 個讀音。
export const HOMOPHONES = {
${body}
};
`);
console.log(`homophones.js：${chars.size} 字、${sorted.length} 個讀音`);
