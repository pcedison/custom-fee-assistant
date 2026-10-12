// =============================================================
// 在收費圖表上畫橘色螢光筆，回傳標示後的圖片（整張 + 標示處放大）
// =============================================================
import { REGIONS, IMAGE } from './kb.js?v=202610122213';

let imgPromise = null;
export function loadMenuImage(src) {
  if (!imgPromise) {
    imgPromise = new Promise((resolve, reject) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => resolve(im);
      im.onerror = () => { imgPromise = null; reject(new Error('圖表載入失敗')); };
      im.src = src;
    });
  }
  return imgPromise;
}

function hash(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// 一筆螢光筆：兩道略有偏移的斜切筆畫，重疊處顏色較深，像真的手畫
function marker(ctx, x, y, w, h, seed) {
  const r = rng(seed);
  // 大字只畫下半部，跟實際用螢光筆畫標題一樣
  if (h > 50) { y += h * 0.34; h *= 0.66; }
  const padX = Math.max(5, h * 0.28);
  const padY = Math.max(2, h * 0.14);
  const x0 = x - padX, x1 = x + w + padX;
  const y0 = y - padY, y1 = y + h + padY;
  const tilt = (r() - 0.5) * Math.min(7, h * 0.3);
  const slant = Math.min(8, h * 0.35);
  for (let pass = 0; pass < 2; pass++) {
    const j = () => (r() - 0.5) * Math.max(1.6, h * 0.1);
    ctx.beginPath();
    ctx.moveTo(x0 + slant + j(), y0 + tilt / 2 + j());
    ctx.lineTo(x1 + slant + j(), y0 - tilt / 2 + j());
    ctx.lineTo(x1 + j(), y1 - tilt / 2 + j());
    ctx.lineTo(x0 + j(), y1 + tilt / 2 + j());
    ctx.closePath();
    ctx.fill();
  }
}

export async function renderHighlight(src, regionIds) {
  const img = await loadMenuImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const sx = W / IMAGE.width, sy = H / IMAGE.height;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const boxes = regionIds
    .filter(id => REGIONS[id])
    .map(id => {
      const [x, y, w, h] = REGIONS[id];
      return { id, x: x * sx, y: y * sy, w: w * sx, h: h * sy };
    });

  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(255, 150, 20, 0.5)';
  for (const b of boxes) marker(ctx, b.x, b.y, b.w, b.h, hash(b.id));
  ctx.globalCompositeOperation = 'source-over';

  const full = canvas.toDataURL('image/jpeg', 0.9);

  // 標示處放大：把所有標示框起來，留一點邊
  let crop = null;
  if (boxes.length) {
    const pad = 40 * sx;
    let x0 = Math.min(...boxes.map(b => b.x)) - pad;
    let y0 = Math.min(...boxes.map(b => b.y)) - pad;
    let x1 = Math.max(...boxes.map(b => b.x + b.w)) + pad;
    let y1 = Math.max(...boxes.map(b => b.y + b.h)) + pad;
    const minW = 460 * sx;
    if (x1 - x0 < minW) { const cx = (x0 + x1) / 2; x0 = cx - minW / 2; x1 = cx + minW / 2; }
    const minH = 220 * sy;
    if (y1 - y0 < minH) { const cy = (y0 + y1) / 2; y0 = cy - minH / 2; y1 = cy + minH / 2; }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw * ch < W * H * 0.6) {
      const scale = Math.min(2, 1100 / cw);
      const c2 = document.createElement('canvas');
      c2.width = Math.round(cw * scale); c2.height = Math.round(ch * scale);
      const g = c2.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(canvas, x0, y0, cw, ch, 0, 0, c2.width, c2.height);
      crop = c2.toDataURL('image/jpeg', 0.9);
    }
  }
  return { full, crop };
}
