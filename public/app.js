const refreshBtn = document.getElementById("refresh-btn");
const langBtn = document.getElementById("lang-btn");
const enabledEl = document.getElementById("enabled");
const connectedEl = document.getElementById("connected");
const listeningEl = document.getElementById("listening");
const lastCheckedEl = document.getElementById("lastChecked");
const lastUpdateIdEl = document.getElementById("lastUpdateId");
const processedCountEl = document.getElementById("processedCount");
const lastErrorEl = document.getElementById("lastError");
const todayMetaEl = document.getElementById("today-meta");
const todayListEl = document.getElementById("today-list");
const todayEmptyEl = document.getElementById("today-empty");
const taskItemTemplate = document.getElementById("task-item-template");
const recentListEl = document.getElementById("recent-list");

// --- i18n Support ---
const translations = {
  zh: {
    header_eyebrow: "即時監控 Operations",
    header_lede: "Telegram 監聽中，收到 Threads 連結後自動讀取最新 session 並產生回覆。",
    refresh_btn: "重新整理",
    stat_bot: "Bot",
    stat_connection: "連線",
    stat_listening: "監聽",
    stat_processed: "今日處理",
    stat_update_id: "Update ID",
    detail_last_checked: "最後檢查",
    detail_last_error: "最近錯誤",
    today_eyebrow: "今日任務",
    today_title: "今天已回覆任務",
    today_empty: "今天尚未有成功回覆紀錄",
    task_post: "貼文",
    task_reply: "回覆",
    recent_eyebrow: "最近紀錄",
    recent_title: "最近紀錄",
    recent_meta: "最多 200 筆",
    status_ok: "正常",
    status_error: "異常",
    status_success: "成功",
    status_failed: "失敗",
    no_recent: "暫無紀錄",
    error_none: "無"
  },
  en: {
    header_eyebrow: "Realtime Operations",
    header_lede: "Listening to Telegram. Automatically fetches sessions and replies to Threads links.",
    refresh_btn: "Refresh",
    stat_bot: "Bot",
    stat_connection: "Connection",
    stat_listening: "Listening",
    stat_processed: "Processed Today",
    stat_update_id: "Update ID",
    detail_last_checked: "Last Checked",
    detail_last_error: "Last Error",
    today_eyebrow: "Today",
    today_title: "Replies Sent Today",
    today_empty: "No replies sent yet today.",
    task_post: "Post",
    task_reply: "Reply",
    recent_eyebrow: "Recent",
    recent_title: "Recent History",
    recent_meta: "Up to 200 items",
    status_ok: "OK",
    status_error: "Error",
    status_success: "Success",
    status_failed: "Failed",
    no_recent: "No recent history",
    error_none: "None"
  }
};

let currentLang = localStorage.getItem("post-booster-lang") || "zh";

function applyTranslations() {
  const t = translations[currentLang];
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (t[key]) el.textContent = t[key];
  });
  langBtn.textContent = currentLang === "zh" ? "EN / 繁中" : "繁中 / EN";
}

function t(key) {
  return translations[currentLang][key] || key;
}

// --- Logic ---
function setBoolPill(el, value) {
  const ok = Boolean(value);
  el.textContent = ok ? t("status_ok") : t("status_error");
  el.className = `pill ${ok ? "ok" : "error"}`;
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(currentLang === "zh" ? "zh-HK" : "en-US", { hour12: false });
}

function shortText(text, max = 220) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function renderToday(items) {
  const list = Array.isArray(items) ? items : [];
  todayListEl.innerHTML = "";
  todayEmptyEl.hidden = list.length > 0;

  for (const item of list) {
    const node = taskItemTemplate.content.cloneNode(true);
    const timeEl = node.querySelector(".task-time");
    const linkEl = node.querySelector(".task-link");

    timeEl.textContent = formatTime(item.createdAt);
    timeEl.dateTime = item.createdAt || "";
    linkEl.href = item.link || "#";
    linkEl.textContent = shortText(item.link || "-", 74);
    node.querySelector(".task-post").textContent = shortText(item.postText || "-", 320);
    node.querySelector(".task-reply").textContent = shortText(item.reply || "-", 320);

    todayListEl.appendChild(node);
  }
}

function renderRecent(items) {
  const list = Array.isArray(items) ? items.slice(0, 8) : [];
  if (!list.length) {
    recentListEl.innerHTML = `<p class="empty-state compact">${t("no_recent")}</p>`;
    return;
  }

  recentListEl.innerHTML = list
    .map((item) => {
      const ok = item.status === "success";
      return `
        <article class="recent-row">
          <span class="pill ${ok ? "ok" : "error"}">${ok ? t("status_success") : t("status_failed")}</span>
          <a href="${item.link || "#"}" target="_blank" rel="noreferrer">${shortText(item.link || "-", 88)}</a>
          <time>${formatTime(item.createdAt)}</time>
        </article>
      `;
    })
    .join("");
}

async function loadStatus() {
  const response = await fetch("/api/telegram-status");
  const data = await response.json();
  const telegram = data?.telegram || {};

  setBoolPill(enabledEl, telegram.enabled);
  setBoolPill(connectedEl, telegram.connected);
  setBoolPill(listeningEl, telegram.listening);
  lastCheckedEl.textContent = formatTime(telegram.lastCheckedAt);
  lastUpdateIdEl.textContent = telegram.lastUpdateId ?? "-";
  processedCountEl.textContent = telegram.processedCount ?? "-";
  lastErrorEl.textContent = telegram.lastError || t("error_none");
}

async function loadToday() {
  const response = await fetch("/api/history/today");
  const data = await response.json();
  const dateStr = data?.date || "-";
  const total = data?.total ?? 0;
  const itemLabel = currentLang === "zh" ? "項" : "items";
  todayMetaEl.textContent = `${dateStr} · ${total} ${itemLabel}`;
  renderToday(data?.items || []);
}

async function loadRecent() {
  const response = await fetch("/api/history");
  const data = await response.json();
  renderRecent(data?.items || []);
}

async function refreshDashboard() {
  await Promise.all([loadStatus(), loadToday(), loadRecent()]);
}

// --- Events ---
refreshBtn.addEventListener("click", () => {
  refreshDashboard().catch((error) => {
    lastErrorEl.textContent = error instanceof Error ? error.message : String(error);
  });
});

langBtn.addEventListener("click", () => {
  currentLang = currentLang === "zh" ? "en" : "zh";
  localStorage.setItem("post-booster-lang", currentLang);
  applyTranslations();
  refreshDashboard().catch(() => {});
});

// Initial load
applyTranslations();
setInterval(() => {
  refreshDashboard().catch(() => {});
}, 5000);

refreshDashboard().catch((error) => {
  lastErrorEl.textContent = error instanceof Error ? error.message : String(error);
});
