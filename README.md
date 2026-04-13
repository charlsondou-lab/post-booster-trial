# post-booster

這個服務會自動監聽 Telegram 訊息，抓出 Threads 連結後執行：

1. 從 `.env` 讀取固定的 `TH_DS_USER_ID` / `TH_SESSION_ID`
2. 用 Playwright 開 Threads 貼文並擷取內容
3. 用 OpenRouter 產生回覆文案
4. 依設定嘗試發佈回覆與按讚

## Quick Start

```bash
npm install
npx playwright install
```

複製 `.env.example` 為 `.env` 並設定：

- `OPENROUTER_API_KEY`
- `TH_DS_USER_ID`
- `TH_SESSION_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`（可選，做回報訊息用途）

啟動：

```bash
npm start
```

## Dashboard

打開 `http://localhost:3000`，介面只顯示 Telegram 狀態：

- Enabled
- Connected
- Listening
- Last Checked
- Last Update ID
- Poll Count
- Processed Count
- Last Error

## API

- `GET /health`
- `GET /api/telegram-status`
- `GET /api/history`
- `POST /reply`（手動觸發，通常不需要）

`POST /reply` 範例：

```json
{
  "link": "https://www.threads.com/@user/post/xxx"
}
```

## Debug

```env
DEBUG_MODE=1
PLAYWRIGHT_HEADLESS=false
LOG_DIR=./logs
```

失敗快照會寫在 `logs/threads-fail-*.png` 與 `logs/threads-fail-*.html`。
