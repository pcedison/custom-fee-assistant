// 在所有 JS／CSS 引用後面加上版本號（?v=...），避免手機快取到新舊混雜的檔案
// 用法：node scripts/stamp-version.mjs（每次部署前執行）
import fs from 'node:fs';
const dir = new URL('../public/', import.meta.url);
const v = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
for (const f of ['index.html', 'app.js', 'engine.js', 'kb.js', 'drinks.js', 'highlight.js']) {
  const p = new URL(f, dir);
  const s = fs.readFileSync(p, 'utf8')
    .replace(/(from\s+'\.\/[\w-]+\.js)(\?v=\w+)?'/g, `$1?v=${v}'`)
    .replace(/(src="app\.js)(\?v=\w+)?"/g, `$1?v=${v}"`)
    .replace(/(href="style\.css)(\?v=\w+)?"/g, `$1?v=${v}"`);
  fs.writeFileSync(p, s);
}
console.log('version', v);
