# 互助社群推文助理 - Post Booster Trial

這是一個專為「互助社群」打造的推文助理系統。透過 Playwright 自動化工具與 AI (OpenRouter)，協助你自動分析群組內的貼文連結並執行自然的回覆與按讚，省下每天重複操作的時間。

> 本專案屬於「周身刀研究所」教學與體驗版本。

---

## ⚡ 核心能力

1. **訊息轉發**：自動監聽 Telegram 指定群組或機器人的訊息。
2. **提取連結**：精準解析 Telegram 訊息中的 Threads 貼文連結。
3. **分析內容**：利用 AI (GPT-4o-mini 等) 判讀貼文主題與語境。
4. **執行回覆**：模擬真人操作自動留言並按讚。
5. **任務回報**：執行成功後立即發送 Telegram 通知回報。

---

## 🚀 部署教學

### A. Zeabur 一鍵部署 (推薦方式)

1. **Fork 專案**：點擊 GitHub 上的 `Fork` 將代碼複製到你的帳號。
2. **連結 GitHub**：進入 [Zeabur](https://zeabur.com/)，點擊 `Add Service` 並選擇你的 `post-booster-trial` 專案。
3. **產生連結**：到 `Networking` 點擊 `Generate Domain` 生成一個公開的專案網址。
4. **設定環境變數**：進入 `Variable` 設定頁面，填入下方的環境變數（詳見環境變數章節）。
5. **開始運作**：部署完成後，助理即會開始監聽 Telegram 訊息。

### B. 本地環境安裝

1. **安裝依賴**：
   ```bash
   npm install
   npx playwright install
   ```
2. **設定變數**：
   將 `.env.example` 複製一份並重新命名為 `.env`，填入正確的憑證與設定。
3. **啟動服務**：
   ```bash
   npm start
   ```

---

## ⚙️ 環境變數詳解

| 變數名稱 | 說明 | 範例 |
| :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | OpenRouter 的 API Key (用於產生 AI 回覆) | `sk-or-v1-...` |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 給予的機器人 Token | `1234567:ABC...` |
| `TELEGRAM_CHAT_ID` | 你的 Telegram 個人 Chat ID (接收任務回報) | `987654321` |
| `TH_DS_USER_ID` | Threads 瀏覽器 Cookies 中的 `ds_user_id` | `123456789` |
| `TH_SESSION_ID` | Threads 瀏覽器 Cookies 中的 `sessionid` | `session_abc123...` |
| `DEFAULT_DO_LIKE` | 是否自動按讚 (`true` / `false`) | `true` |
| `DEFAULT_PUBLISH` | 是否自動發佈留言 (`true` / `false`) | `true` |
| `PLAYWRIGHT_HEADLESS`| 是否隱藏瀏覽器視窗 (`true` 為隱藏) | `true` |
| `DEBUG_MODE` | 除錯模式 (`1` 為開啟，會產出截圖與 Log) | `0` |

---

## 🔑 如何獲取憑證？

### 1. 申請 OpenRouter API
前往 [OpenRouter.ai](https://openrouter.ai/) 註冊並建立 API Key（預設使用免費模型）。

### 2. 設定 Telegram Bot
- 搜尋 [@BotFather](https://t.me/botfather) 並發送 `/newbot` 建立機器人。
- 取得 `Token`。
- 點開你的機器人隨便傳一個連結（例如 Threads 連結），然後到瀏覽器輸入：`https://api.telegram.org/bot<你的TOKEN>/getUpdates` 尋找 `"id"` 即為 `TELEGRAM_CHAT_ID`。

### 3. 取得 Threads Session (Cookie)
- 在電腦瀏覽器登入 Threads 並開啟貼文。
- 按 `F12` 開啟開發者工具 -> `Application` -> `Cookies`。
- 尋找 `ds_user_id` 與 `sessionid` 並複製其數值。

---

## 📊 可視化面板 (Dashboard)

部署成功後，你可以透過 Zeabur 的 Domain 或是本地的 `http://localhost:3000` 進入控制台：
- 檢視 Telegram 連線狀態。
- 查看歷史處理紀錄與 AI 生成的回覆內容。
- 即時監控已處理次數與錯誤訊息。

---

## 💡 常見問題 Q&A

**Q：這會被判為機器人嗎？**  
A：Playwright 是模擬真實瀏覽器操作。本系統已內建隨機等待、模擬真人打字與台灣在地化語氣，但仍建議不要短時間內推文過於頻繁（建議每日保持在合理範圍內）。

**Q：Session 會過期嗎？**  
A：Threads 的 Session 會定期失效。如果助理回報失敗，請重新獲取上面的兩個 Cookies 並更新環境變數即可恢復。

---

## 🛡️ 免責聲明

自動化工具僅為輔助用途，請遵守各平台的使用規範。

---

© 2026 [周身刀研究所](https://charlsondou.com/). 版權所有.
