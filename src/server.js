import "dotenv/config";
import express from "express";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = Number(process.env.PORT || 3000);
const debugMode = process.env.DEBUG_MODE === "1";
const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
const logDir = process.env.LOG_DIR || path.resolve(process.cwd(), "logs");
const publicDir = path.resolve(process.cwd(), "public");

const threadsDsUserId = process.env.TH_DS_USER_ID || "";
const threadsSessionId = process.env.TH_SESSION_ID || "";

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";

const settings = {
  publish: process.env.DEFAULT_PUBLISH === "true",
  do_like: process.env.DEFAULT_DO_LIKE !== "false"
};
const dashboardTimezone = process.env.DASHBOARD_TIMEZONE || "Asia/Hong_Kong";

const runHistory = [];
const maxHistory = 200;

const telegramState = {
  enabled: Boolean(telegramBotToken),
  connected: false,
  listening: false,
  lastCheckedAt: "",
  lastError: "",
  lastUpdateId: null,
  pollCount: 0,
  processedCount: 0
};

let telegramOffset = 0;
let telegramPollBusy = false;
let telegramPollingTimer = null;

app.use(express.static(publicDir));

function log(...args) {
  if (debugMode) console.log(new Date().toISOString(), ...args);
}

function nowIso() {
  return new Date().toISOString();
}

function dateKeyInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value || "0000";
  const m = parts.find((p) => p.type === "month")?.value || "00";
  const d = parts.find((p) => p.type === "day")?.value || "00";
  return `${y}-${m}-${d}`;
}

function getTodayRepliedRuns() {
  const todayKey = dateKeyInTimezone(new Date(), dashboardTimezone);
  return runHistory.filter((item) => {
    if (item.status !== "success") return false;
    if (!item.reply) return false;
    return dateKeyInTimezone(item.createdAt, dashboardTimezone) === todayKey;
  });
}

function recordRun(entry) {
  runHistory.unshift(entry);
  if (runHistory.length > maxHistory) runHistory.length = maxHistory;
}

function normalizeThreadsUrl(link) {
  if (!link || typeof link !== "string") return null;
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (!["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(host)) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0].startsWith("@") && parts[1].toLowerCase() === "post") {
      const rawPostId = parts[2] || "";
      const cleanedPostId = (rawPostId.match(/[A-Za-z0-9_-]+/) || [])[0] || "";
      if (!cleanedPostId) return null;
      const cleanedPath = `/${parts[0]}/post/${cleanedPostId}`;
      return `${url.origin}${cleanedPath}${url.search || ""}`;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function extractThreadsLinksFromText(text) {
  const raw = String(text || "");
  const regex = /https?:\/\/\S+/gi;
  const matches = raw.match(regex) || [];
  const unique = new Set();
  for (const item of matches) {
    const trimmed = item.replace(/[)\],.!?\u3002\uFF01\uFF1F\uFF0C\u3001\uFF1B\uFF1A]+$/u, "");
    const normalized = normalizeThreadsUrl(trimmed);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function extractThreadsLinksFromTelegramMessage(message) {
  const unique = new Set();
  const previewUrl = normalizeThreadsUrl(message?.link_preview_options?.url || "");
  if (previewUrl) unique.add(previewUrl);

  const text = String(message?.text || "");
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  for (const entity of entities) {
    if (entity?.type !== "url") continue;
    const offset = Number(entity.offset || 0);
    const length = Number(entity.length || 0);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) continue;
    const chunk = text.slice(offset, offset + length);
    const normalized = normalizeThreadsUrl(chunk);
    if (normalized) unique.add(normalized);
  }

  for (const link of extractThreadsLinksFromText(text)) {
    unique.add(link);
  }

  return [...unique];
}

function buildUrlCandidates(rawUrl) {
  const urls = [rawUrl];
  try {
    const u = new URL(rawUrl);
    u.search = "";
    u.hash = "";
    const clean = u.toString();
    if (!urls.includes(clean)) urls.push(clean);
  } catch {}
  return urls;
}

function buildCookies({ th_ds_user_id, th_session_id }) {
  let normalizedSessionId = String(th_session_id);
  try {
    normalizedSessionId = decodeURIComponent(normalizedSessionId);
  } catch {}

  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
  const domains = [".threads.com", ".threads.net"];

  return domains.flatMap((domain) => [
    {
      name: "ds_user_id",
      value: String(th_ds_user_id),
      domain,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
      expires
    },
    {
      name: "sessionid",
      value: normalizedSessionId,
      domain,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
      expires
    }
  ]);
}

function fetchThreadsSessionFromEnv() {
  const th_ds_user_id = String(threadsDsUserId || "").trim();
  const th_session_id = String(threadsSessionId || "").trim();
  if (!th_ds_user_id || !th_session_id) {
    throw new Error("Missing TH_DS_USER_ID or TH_SESSION_ID in environment.");
  }
  return { th_ds_user_id, th_session_id };
}

async function sendTelegramMessage(text, chatIdOverride = "") {
  if (!telegramBotToken) return;
  const chatId = chatIdOverride || telegramChatId;
  if (!chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    log("Telegram send failed", err instanceof Error ? err.message : String(err));
  }
}

async function extractPostText(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1800);

  return page.evaluate(() => {
    const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
    const article = clean(document.querySelector("article")?.textContent || "");
    const main = clean(document.querySelector("main")?.textContent || "");
    const ogTitle = clean(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "");
    const ogDesc = clean(document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "");
    const title = clean(document.title || "");

    const candidates = [article, main, ogDesc, ogTitle].filter(Boolean);
    const best = candidates.sort((a, b) => b.length - a.length)[0] || "";

    return {
      best,
      debug: {
        title,
        ogTitle,
        ogDesc,
        articleLength: article.length,
        mainLength: main.length
      }
    };
  });
}

async function saveDebugArtifacts(page) {
  await mkdir(logDir, { recursive: true });
  const ts = nowIso().replace(/[:.]/g, "-");
  const screenshotPath = path.join(logDir, `threads-fail-${ts}.png`);
  const htmlPath = path.join(logDir, `threads-fail-${ts}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(htmlPath, await page.content(), "utf-8");
  return { screenshotPath, htmlPath };
}

async function generateReplyWithOpenRouter(postText) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY in environment.");

  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const siteName = process.env.OPENROUTER_SITE_NAME || "post-booster";

  const callOpenRouter = async (messages) => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": siteName
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenRouter request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  };

  const reply = await callOpenRouter([
    {
      role: "system",
      content:
        "You are a social media assistant representing a person from Taiwan. Always output natural, conversational Traditional Chinese (Taiwan style). Never output Simplified Chinese. Never use emoji. Avoid formal or robotic summaries."
    },
    {
      role: "user",
      content: [
        "Write exactly one short, natural reply for this Threads post as if you are a real user from Taiwan.",
        "Rules:",
        "- Traditional Chinese (Taiwan) only",
        "- Use Taiwan terminology exclusively (e.g., '品質' instead of '質量', '貼文' instead of '帖子')",
        "- 2 to 15 Chinese characters (keep it snappy)",
        "- Tone: Conversational, friendly, supportive, or humorous",
        "- DO NOT summarize the post. Instead, react to it like a human would.",
        "- DO NOT ask any questions. Avoid question marks.",
        "- No fake claims, no attacks",
        "- No emoji",
        "- Output only the final reply text",
        "",
        "Post content:",
        postText
      ].join("\n")
    }
  ]);

  if (!reply) throw new Error("OpenRouter returned empty reply.");

  const stripEmoji = (text) => text.replace(/\p{Extended_Pictographic}/gu, "").trim();
  const hasLikelySimplified = (text) => /[这们后发台网为于与个来会点里国说实应开关见没质采务继术级确议适]/.test(text);

  let finalReply = stripEmoji(reply);
  if (hasLikelySimplified(finalReply)) {
    const converted = await callOpenRouter([
      {
        role: "system",
        content:
          "Convert input to Traditional Chinese only (Taiwan/HK style), remove all emoji, keep it concise, output only final text."
      },
      { role: "user", content: finalReply }
    ]);
    finalReply = stripEmoji(converted || finalReply);
  }

  if (!finalReply) {
    const fallback = await callOpenRouter([
      {
        role: "system",
        content: "Output Traditional Chinese (Taiwan/HK) only, 2-15 Chinese characters, no emoji."
      },
      { role: "user", content: `Post content:\n${postText}` }
    ]);
    finalReply = stripEmoji(fallback || "");
  }

  if (!finalReply) throw new Error("OpenRouter returned empty reply.");
  return finalReply;
}

async function clickActionButton(page, action) {
  return page.evaluate((act) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getLabel = (el) =>
      `${(el.getAttribute("aria-label") || "").toLowerCase()} ${(el.textContent || "").toLowerCase()}`.trim();

    const getScopeButtons = () => {
      if (act === "like") {
        const article = document.querySelector("article");
        if (article) return Array.from(article.querySelectorAll('[role="button"], button')).filter(isVisible);
      }
      return Array.from(document.querySelectorAll('[role="button"], button')).filter(isVisible);
    };

    const clickFromSvg = () => {
      const article = document.querySelector("article") || document;
      const svgs = Array.from(article.querySelectorAll("svg[aria-label], svg title"));
      const matchLabel = (raw) => {
        const label = (raw || "").toLowerCase();
        if (act === "like") return /like|\u8b9a|\u8d5e/.test(label);
        if (act === "reply") return /reply|\u56de\u8986|\u56de\u590d|comment/.test(label);
        if (act === "submit") return /post|reply|\u767c\u4f48|\u53d1\u5e03|\u56de\u8986|\u56de\u590d/.test(label);
        return false;
      };

      for (const svg of svgs) {
        const own = svg.getAttribute?.("aria-label") || "";
        const title = svg.querySelector?.("title")?.textContent || "";
        const label = `${own} ${title}`;
        if (!matchLabel(label)) continue;

        const clickable = svg.closest('[role="button"], button');
        if (!clickable || !isVisible(clickable)) continue;
        const pressed = (clickable.getAttribute("aria-pressed") || "").toLowerCase();
        const disabled = clickable.hasAttribute("disabled") || clickable.getAttribute("aria-disabled") === "true";
        if (act === "like" && pressed === "true") continue;
        if (disabled) continue;
        clickable.click();
        return true;
      }
      return false;
    };

    if (clickFromSvg()) return true;

    const candidates = getScopeButtons();
    for (const btn of candidates) {
      const svgLabel = (btn.querySelector("svg")?.getAttribute("aria-label") || "").toLowerCase();
      const titleLabel = (btn.querySelector("title")?.textContent || "").toLowerCase();
      const label = `${getLabel(btn)} ${svgLabel} ${titleLabel}`.trim();
      const pressed = (btn.getAttribute("aria-pressed") || "").toLowerCase();
      const disabled = btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true";

      if (act === "like" && /like|\u8b9a|\u8d5e/.test(label) && pressed !== "true" && !disabled) {
        btn.click();
        return true;
      }
      if (act === "reply" && /reply|\u56de\u8986|\u56de\u590d/.test(label) && !disabled) {
        btn.click();
        return true;
      }
      if (
        act === "submit" &&
        /(^|\s)(reply|post|\u56de\u8986|\u56de\u590d|\u767c\u4f48|\u53d1\u5e03)(\s|$)/.test(label) &&
        !/cancel|close|\u53d6\u6d88|\u95dc\u9589|\u5173\u95ed/.test(label) &&
        !disabled
      ) {
        btn.click();
        return true;
      }
    }

    return false;
  }, action);
}

async function fillReplyEditor(page, text) {
  const success = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const all = Array.from(
      document.querySelectorAll('[data-lexical-editor="true"], [contenteditable="true"], textarea')
    ).filter(isVisible);
    if (!all.length) return false;

    const inDialog = all.find((el) => el.closest('[role="dialog"]'));
    const target = inDialog || all[0];
    target.focus();

    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      target.value = "";
    } else {
      const paragraph = target.querySelector("p");
      if (paragraph) {
        paragraph.textContent = "";
      } else {
        target.textContent = "";
      }
    }
    return true;
  });

  if (!success) return false;

  // Real human-like typing simulation
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150) + 50 });
  }
  return true;
}

async function clickSubmitNearEditor(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const editors = Array.from(
      document.querySelectorAll('[data-lexical-editor="true"], [contenteditable="true"], textarea')
    ).filter(isVisible);
    if (!editors.length) return false;

    const target = editors.find((el) => el.closest('[role="dialog"]')) || editors[0];
    let scope = target;
    for (let i = 0; i < 8 && scope?.parentElement; i++) {
      scope = scope.parentElement;
      const buttons = Array.from(scope.querySelectorAll('[role="button"], button')).filter(isVisible);
      for (const btn of buttons) {
        const label = `${(btn.getAttribute("aria-label") || "").toLowerCase()} ${(btn.textContent || "").toLowerCase()} ${(btn.querySelector("svg")?.getAttribute("aria-label") || "").toLowerCase()}`.trim();
        const disabled = btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true";
        if (
          !disabled &&
          /(^|\s)(reply|post|\u56de\u8986|\u56de\u590d|\u767c\u4f48|\u53d1\u5e03)(\s|$)/.test(label) &&
          !/cancel|close|\u53d6\u6d88|\u95dc\u9589|\u5173\u95ed/.test(label)
        ) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  });
}

async function publishAndLike(page, replyText, doLike) {
  const result = { replyOpened: false, replyFilled: false, replySent: false, liked: false, likeSkipped: false };

  if (doLike) {
    result.liked = await clickActionButton(page, "like");
    log("Like result", result.liked);
    await page.waitForTimeout(Math.floor(Math.random() * 1000) + 500);
  } else {
    result.likeSkipped = true;
  }

  await page.waitForTimeout(Math.floor(Math.random() * 2000) + 1000); // Random delay before reply
  result.replyOpened = await clickActionButton(page, "reply");
  log("Reply open result", result.replyOpened);
  if (result.replyOpened) await page.waitForTimeout(Math.floor(Math.random() * 1000) + 800);

  result.replyFilled = await fillReplyEditor(page, replyText);
  log("Reply fill result", result.replyFilled);
  if (result.replyFilled) await page.waitForTimeout(Math.floor(Math.random() * 1500) + 1000); // Random delay after typing

  result.replySent = await clickSubmitNearEditor(page);
  if (!result.replySent) result.replySent = await clickActionButton(page, "submit");
  if (!result.replySent && result.replyFilled) {
    try {
      await page.keyboard.press(process.platform === "win32" ? "Control+Enter" : "Meta+Enter");
      await page.waitForTimeout(220);
      result.replySent = true;
    } catch {}
  }
  if (!result.replySent && result.replyFilled) {
    try {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(220);
      result.replySent = true;
    } catch {}
  }
  log("Reply submit result", result.replySent);
  return result;
}

async function runReplyWorkflow(link, override = {}) {
  const normalizedUrl = normalizeThreadsUrl(link);
  const publish = typeof override.publish === "boolean" ? override.publish : settings.publish;
  const do_like = typeof override.do_like === "boolean" ? override.do_like : settings.do_like;

  if (!normalizedUrl) throw new Error("Invalid input. Require a valid Threads link.");

  let browser;
  let page;
  const run = {
    id: Date.now().toString(36),
    createdAt: nowIso(),
    link: normalizedUrl,
    publish,
    do_like,
    status: "failed",
    postText: "",
    reply: "",
    actions: null,
    error: ""
  };

  try {
    const session = fetchThreadsSessionFromEnv();

    log("Start workflow", { link: normalizedUrl, headless, publish, do_like });
    browser = await chromium.launch({ headless, slowMo: headless ? 0 : 400 });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "zh-HK",
      viewport: { width: 1280, height: 960 }
    });
    await context.addCookies(buildCookies(session));

    page = await context.newPage();
    if (debugMode) {
      page.on("console", (m) => log("browser-console:", m.type(), m.text()));
      page.on("requestfailed", (r) => log("request-failed:", r.url(), r.failure()?.errorText));
      page.on("response", (r) => {
        if (r.status() >= 400) log("response-error:", r.status(), r.url());
      });
    }

    const urlCandidates = buildUrlCandidates(normalizedUrl);
    const gotoErrors = [];
    let postText = "";
    let extractDebug = null;
    let gotoDebug = null;

    for (const url of urlCandidates) {
      let response = null;
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (err) {
        gotoErrors.push({ url, message: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const extracted = await extractPostText(page);
      postText = extracted.best;
      extractDebug = extracted.debug;
      gotoDebug = { requestedUrl: url, finalUrl: page.url(), status: response?.status?.() ?? null };
      if (postText && postText.length >= 10) break;
    }

    if (!postText || postText.length < 10) {
      const artifacts = await saveDebugArtifacts(page);
      throw new Error(
        `Unable to extract post content. nav=${JSON.stringify(gotoDebug)}, extract=${JSON.stringify(
          extractDebug
        )}, gotoErrors=${JSON.stringify(gotoErrors)}, screenshot=${artifacts.screenshotPath}, html=${artifacts.htmlPath}`
      );
    }

    const reply = await generateReplyWithOpenRouter(postText);
    let actions = null;
    if (publish) {
      actions = await publishAndLike(page, reply, do_like !== false);
      if (!actions.replySent || ((do_like !== false) && !actions.liked)) {
        actions.debugArtifacts = await saveDebugArtifacts(page);
      }
      await page.waitForTimeout(900);
    }

    run.status = "success";
    run.postText = postText;
    run.reply = reply;
    run.actions = actions;
    recordRun(run);
    return run;
  } catch (error) {
    run.error = error instanceof Error ? error.message : "Unexpected error.";
    recordRun(run);
    if (page) {
      try {
        await saveDebugArtifacts(page);
      } catch {}
    }
    throw new Error(run.error);
  } finally {
    if (browser) await browser.close();
  }
}

async function checkTelegramConnection() {
  if (!telegramBotToken) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/getMe`);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data?.description || `HTTP ${response.status}`);
    }
    telegramState.connected = true;
    telegramState.lastError = "";
    telegramState.lastCheckedAt = nowIso();
  } catch (err) {
    telegramState.connected = false;
    telegramState.lastError = err instanceof Error ? err.message : String(err);
    telegramState.lastCheckedAt = nowIso();
  }
}

async function pollTelegramOnce() {
  if (!telegramBotToken) return;
  if (telegramPollBusy) return;
  telegramPollBusy = true;
  telegramState.listening = true;
  telegramState.pollCount += 1;

  try {
    const url = `https://api.telegram.org/bot${telegramBotToken}/getUpdates?timeout=25${
      telegramOffset ? `&offset=${telegramOffset}` : ""
    }`;
    const response = await fetch(url, { method: "GET" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data?.description || `HTTP ${response.status}`);

    telegramState.connected = true;
    telegramState.lastCheckedAt = nowIso();
    telegramState.lastError = "";

    const updates = Array.isArray(data.result) ? data.result : [];
    for (const update of updates) {
      telegramOffset = update.update_id + 1;
      telegramState.lastUpdateId = update.update_id;

      const message = update.message || update.edited_message;
      if (!message) continue;
      if (message.from?.is_bot) continue;

      const sourceChatId = message.chat?.id ? String(message.chat.id) : "";
      const links = extractThreadsLinksFromTelegramMessage(message);
      if (!links.length) continue;

      for (const link of links) {
        try {
          const run = await runReplyWorkflow(link);
          telegramState.processedCount += 1;
          await sendTelegramMessage(
            `✅ 任務處理完成\n${run.link}\nstatus: ${run.status}\nreply: ${run.reply || "-"}`,
            sourceChatId || telegramChatId
          );
        } catch (err) {
          await sendTelegramMessage(
            `❌ 處理出錯\n${link}\nerror: ${err instanceof Error ? err.message : String(err)}`,
            sourceChatId || telegramChatId
          );
        }
      }
    }
  } catch (err) {
    telegramState.connected = false;
    telegramState.lastError = err instanceof Error ? err.message : String(err);
    telegramState.lastCheckedAt = nowIso();
  } finally {
    telegramPollBusy = false;
  }
}

function startTelegramPolling() {
  if (!telegramBotToken) {
    telegramState.enabled = false;
    telegramState.listening = false;
    return;
  }

  telegramState.enabled = true;
  telegramState.listening = true;
  checkTelegramConnection().catch(() => {});
  pollTelegramOnce().catch(() => {});
  telegramPollingTimer = setInterval(() => {
    pollTelegramOnce().catch(() => {});
  }, 5000);
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/telegram-status", (_req, res) => {
  res.json({ ok: true, telegram: telegramState });
});

app.get("/api/history", (_req, res) => {
  res.json({ ok: true, items: runHistory });
});

app.get("/api/history/today", (_req, res) => {
  const items = getTodayRepliedRuns();
  res.json({
    ok: true,
    timezone: dashboardTimezone,
    date: dateKeyInTimezone(new Date(), dashboardTimezone),
    total: items.length,
    items
  });
});

app.post("/reply", async (req, res) => {
  try {
    const run = await runReplyWorkflow(req.body?.link, {
      publish: req.body?.publish,
      do_like: req.body?.do_like
    });
    return res.json({ ok: true, ...run });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
});

const server = app.listen(port, () => {
  console.log(`post-booster listening on http://localhost:${port} (headless=${headless}, debug=${debugMode})`);
  startTelegramPolling();
});

process.on("SIGINT", () => {
  if (telegramPollingTimer) clearInterval(telegramPollingTimer);
  server.close(() => process.exit(0));
});
