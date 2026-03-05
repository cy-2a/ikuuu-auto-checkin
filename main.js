// 不直接使用 Cookie 是因为 Cookie 过期时间较短。

import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

// 你的回调 API 前缀（保持你给的路径）
const callbackPrefix = "https://api.chuckfang.com/第五个季节/";

// 并发数：避免一次跑太多账号导致网络抖动/对方风控
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

// 网络请求配置
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

// ---------------------- 工具函数 ----------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  // 0.85 ~ 1.15 的随机抖动，避免同一时刻重试“撞车”
  const factor = 0.85 + Math.random() * 0.3;
  return Math.floor(ms * factor);
}

function classifyFetchError(err) {
  const name = err?.name || "";
  const msg = err?.message || "";
  const causeMsg = err?.cause?.message || "";

  if (name === "AbortError") return "TIMEOUT";
  const combined = `${msg} ${causeMsg}`.toLowerCase();

  if (combined.includes("getaddrinfo") || combined.includes("enotfound"))
    return "DNS";
  if (combined.includes("certificate") || combined.includes("tls"))
    return "TLS";
  if (combined.includes("econnreset") || combined.includes("socket"))
    return "SOCKET";
  if (combined.includes("timed out") || combined.includes("timeout"))
    return "TIMEOUT";

  // undici 常见：TypeError: fetch failed
  if (combined.includes("fetch failed")) return "FETCH_FAILED";

  return "UNKNOWN";
}

async function fetchWithRetry(url, options = {}, cfg = {}) {
  const retries = cfg.retries ?? FETCH_RETRIES;
  const timeoutMs = cfg.timeoutMs ?? FETCH_TIMEOUT_MS;

  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;

      const kind = classifyFetchError(err);
      const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";
      console.error(
        `❌ fetch error [${kind}] (${attempt}/${retries}) ${url}${cause}`
      );

      if (attempt < retries) {
        // 退避：800ms, 1600ms, 3200ms ...
        const backoff = jitter(800 * Math.pow(2, attempt - 1));
        await sleep(backoff);
      }
    }
  }

  throw lastErr;
}

async function readJsonSafely(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 返回非 JSON 时，保留片段便于排查
    const snippet = text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`响应不是有效 JSON：${snippet}`);
  }
}

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();

  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }

  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// 并发限流 mapper
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// ---------------------- 核心逻辑 ----------------------

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  const formData = new FormData();
  formData.append("host", host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetchWithRetry(logInUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`登录接口 HTTP 错误 - ${response.status}`);
  }

  const responseJson = await readJsonSafely(response);

  if (responseJson?.ret !== 1) {
    throw new Error(`登录失败: ${responseJson?.msg ?? "未知错误"}`);
  }

  console.log(`${account.name}: ${responseJson.msg}`);

  const rawCookieArray = response.headers.getSetCookie?.() || [];
  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error("获取 Cookie 失败（响应头无 Set-Cookie）");
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const response = await fetchWithRetry(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
    },
  });

  if (!response.ok) {
    throw new Error(`签到接口 HTTP 错误 - ${response.status}`);
  }

  const data = await readJsonSafely(response);
  const msg = data?.msg ?? "（无返回消息）";

  console.log(`${account.name}: ${msg}`);

  return msg;
}

// 回调你的 API（失败不影响主流程）
async function callbackToYourApi(accountName, msg) {
  const fullMsg = `${accountName}: ${msg}`;
  const url = `${callbackPrefix}${encodeURIComponent(fullMsg)}`;

  try {
    const res = await fetchWithRetry(url, { method: "GET" }, { retries: 3, timeoutMs: 8000 });
    if (!res.ok) {
      console.error(`⚠️ 回调 API HTTP 错误 - ${res.status}`);
    }
  } catch (err) {
    const kind = classifyFetchError(err);
    console.error(`⚠️ 回调 API 失败 [${kind}]：${err.message}`);
  }
}

// 处理单个账号（把可预期错误都包一层，信息更清楚）
async function processSingleAccount(account) {
  try {
    const cooked = await logIn(account);
    const msg = await checkIn(cooked);

    // 回调不阻塞主流程：这里 await 保持顺序清晰；若你希望更快可改成不 await
    await callbackToYourApi(account.name, msg);

    return msg;
  } catch (err) {
    // 把 undici 的 cause 也打印出来，便于定位
    const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";
    throw new Error(`${err.message}${cause}`);
  }
}

// ---------------------- 入口 ----------------------

async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("❌ 未配置账户信息（ACCOUNTS）。");
    }
    accounts = JSON.parse(process.env.ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("❌ 账户信息为空或不是数组。");
    }
  } catch (error) {
    const message = `❌ ${
      String(error.message).includes("JSON")
        ? "账户信息配置格式错误（不是合法 JSON）。"
        : error.message
    }`;
    console.error(message);
    setGitHubOutput("result", message);
    process.exit(1);
  }

  console.log(`共 ${accounts.length} 个账号，并发数：${CONCURRENCY}\n`);

  const results = await mapLimit(accounts, CONCURRENCY, async (account) => {
    // 用 Promise.allSettled 风格包装，避免单个账号直接打断
    try {
      const msg = await processSingleAccount(account);
      return { status: "fulfilled", value: msg };
    } catch (err) {
      return { status: "rejected", reason: err };
    }
  });

  const msgHeader = "\n======== 签到结果 ========\n\n";
  console.log(msgHeader);

  let hasError = false;

  const resultLines = results.map((result, index) => {
    const accountName = accounts[index]?.name ?? `Account#${index + 1}`;
    const isSuccess = result.status === "fulfilled";

    if (!isSuccess) hasError = true;

    const icon = isSuccess ? "✅" : "❌";
    const message = isSuccess ? result.value : (result.reason?.message || String(result.reason));

    const line = `${accountName}: ${icon} ${message}`;
    isSuccess ? console.log(line) : console.error(line);
    return line;
  });

  const resultMsg = resultLines.join("\n");
  setGitHubOutput("result", resultMsg);

  if (hasError) process.exit(1);
}

main();
