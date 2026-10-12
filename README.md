# 客製化加價小幫手

2026/10/12 起客製化服務收費的問答機器人。顧客用聊天的方式提問，常見問題直接依收費規則回答，比對不到的才交給 OpenRouter 免費模型；顧客看不懂時，會在收費圖表上用橘色螢光筆標出重點並回傳圖片。

## 運作方式

1. **關鍵字優先**：問題先在瀏覽器裡比對 `public/kb.js` 的規則，命中就立刻回答，不耗用 AI 額度。
2. **加價試算**：一次提到兩項以上（例如「燕麥奶＋抹茶液＋環保杯」）會列出每項加價與合計。
   - 自備環保杯一律折 $10，**買一送一時不折**。
   - 風味糖漿、其他配料、高蛋白雲朵每杯每項限一份（例如「8 份抹茶」會以 1 份計並提醒）。
   - 濃縮咖啡按份計價（加兩份 = +$30）。
3. **AI 補位**：關鍵字比對不到時，呼叫 `/api/chat`（Cloudflare Pages Function），由 OpenRouter 免費模型依同一份規則回答。
4. **螢光筆標圖**：顧客說「看不懂」「什麼意思」「標給我看」，或點「看不懂，標給我看」，就把上一題相關的項目畫上橘色螢光筆，回傳標示後的圖片（泡泡裡顯示標示處放大，點開可切換整張圖、下載）。環保杯、買一送一不在圖表上，就只用文字說明。

## 檔案結構

```
public/              ← 網站本體（Cloudflare Pages 的輸出目錄）
  index.html         聊天介面
  style.css
  app.js             介面邏輯
  engine.js          關鍵字比對、試算、看不懂偵測
  kb.js              ★ 收費規則、回答內容、圖上標示位置、AI 規則說明（改規則只要改這裡）
  highlight.js       在圖上畫螢光筆
  menu.jpg           收費圖表
  _headers           安全性與快取標頭
functions/api/chat.js  ← 串接 OpenRouter 的後端（API 金鑰只在這裡讀取）
tests/engine.test.mjs  ← 規則測試（npm test）
```

## 部署到 Cloudflare Pages

> Cloudflare 後台的「拖曳上傳」不會編譯 `functions/` 資料夾，AI 功能會失效。請用下面兩種方式之一。

### 方式 A：連動 GitHub（推薦）

1. 把整個資料夾推到 GitHub。
2. Cloudflare 後台 → Workers & Pages → 建立 → Pages → 連接 Git，選這個 repo。
3. 建置設定：
   - 框架預設：無
   - 建置指令：留空
   - 建置輸出目錄：`public`
4. 設定 → 變數和祕密 → 新增 `OPENROUTER_API_KEY`，類型選「祕密」（Production 與 Preview 都要設）。
5. 重新部署一次，讓環境變數生效。

### 方式 B：Wrangler 指令

```bash
npx wrangler login
npx wrangler pages project create custom-fee-assistant
npx wrangler pages secret put OPENROUTER_API_KEY --project-name custom-fee-assistant
npx wrangler pages deploy public --project-name custom-fee-assistant
```

在專案根目錄執行，Wrangler 會自動把 `functions/` 一起部署。

### 部署後檢查

打開 `https://你的網址/api/chat`，看到 `"ai": true` 就代表金鑰已設定。

## 環境變數

| 名稱 | 必填 | 說明 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 是 | OpenRouter API 金鑰（https://openrouter.ai/keys），請設為祕密 |
| `OPENROUTER_MODEL` | 否 | 預設 `openrouter/free`，會自動挑一個可用的免費模型；也可指定如 `xxx/yyy:free` |
| `OPENROUTER_FALLBACKS` | 否 | 備援模型，逗號分隔，主模型失敗時依序嘗試 |
| `ALLOWED_ORIGINS` | 否 | 允許呼叫 `/api/chat` 的其他網域，逗號分隔；預設只允許自己的網域 |

### OpenRouter 免費額度

免費模型的額度是以整個 OpenRouter 帳號計算：每分鐘 20 次；從未儲值的帳號每天 50 次，累計儲值滿 10 美元後提高到每天 1000 次（儲值金額不會被免費模型扣掉）。門市使用建議先儲值 10 美元。額度用完時，聊天室會提示顧客改點常見問題，關鍵字回答不受影響。

## 修改內容

- **收費或回答文字**：改 `public/kb.js` 的 `TOPICS`（問答）與 `ITEMS`（試算價格、辨識用詞），以及最下方 `buildSystemPrompt()`（AI 依據的規則）。
- **環保杯折抵金額**：`ECO_CUP_DISCOUNT`。
- **更換圖表**：替換 `public/menu.jpg`，並更新 `IMAGE` 的寬高與 `REGIONS` 裡每個項目的位置 `[x, y, 寬, 高]`（原圖像素）。
- 改完執行 `npm test` 確認試算與標示沒有壞掉。

## 本機測試

```bash
cp .dev.vars.example .dev.vars   # 填入金鑰
npm run dev                      # http://localhost:8788
npm test                         # 規則測試
```

## 建議

- 綁定自訂網域後，可在 Cloudflare WAF 為 `/api/chat` 加一條速率限制（例如每個 IP 每分鐘 10 次），避免免費額度被少數人用光。
- 頁面底部已註明「實際金額以門市結帳為準」；收費規則若有更新，記得同步修改 `kb.js` 與圖表。
