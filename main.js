// main.js
import { appendFileSync } from "fs";
import dns from "dns";
import { setGlobalDispatcher, Agent } from "undici";

// ---------------------- 配置 ----------------------
const host = process.env.HOST || "ikuuu.nl";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

// 连接超时：TCP/握手阶段（你遇到的就是这里）
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 12000);
// headers 超时：已连上但迟迟不给响应头
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || 15000);

const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 4);
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS || 800);

// 让请求更“分散”，减少固定时刻的同时连接
const ACCOUNT_JITTER_MS = Number(process.env.ACCOUNT_JITTER_MS || 1200);

// ---------------------- undici 全局 Agent（性能 + 稳定） ----------------------
// DNS lookup：优先 IPv4（配合 NODE_OPTIONS=--dns-result-order=ipv4first）
function lookupPreferV4(hostname, options, cb) {
  // 先试 IPv4，再试系统默认
  dns.lookup(hostname, { ...options, family: 4 }, (err, address, family) => {
    if (!err) return cb(null, address, family);
    dns.lookup(hostname, options, cb);
  });
}

setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      lookup: lookupPreferV4,
    },
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: 0, // 不限制 body 超时（签到接口一般 body 很小）
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  })
);

// ---------------------- 工具函数 ----------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  const factor = 0.85 + Math.random() * 0.3;
  return Math.floor(ms * factor);
}

function isRetryableError(kind) {
  // 这些属于“网络瞬态问题”，重试有意义
  return new Set([
    "CONNECT_TIMEOUT",
    "HEADERS_TIMEOUT",
    "DNS",
    "SOCKET",
    "FETCH_FAILED",
    "TLS",
  ]).has(kind);
}

function classifyFetchError(err) {
  const name = err?.name || "";
  const msg = (err?.message || "").toLowerCase();
  const causeMsg = (err?.cause?.message || "").toLowerCase();

  const combined = `${name} ${msg} ${causeMsg}`;

  // undici 常见：
  // - Connect Timeout Error
  // - Headers Timeout Error
  if (combined.includes("connect timeout")) return "CONNECT_TIMEOUT";
  if (combined.includes("headers timeout")) return "HEADERS_TIMEOUT";

  if (combined.includes("getaddrinfo") || combined.includes("enotfound"))
    return "DNS";
  if (combined.includes("certificate") || combined.includes("tls"))
    return "TLS";
  if (combined.includes("econnreset") || combined.includes("socket"))
    return "SOCKET";
  if (combined.includes("fetch failed")) return "FETCH_FAILED";

  return "UNKNOWN";
}

async function fetchWithRetry(url, options = {}, cfg = {}) {
  const retries = cfg.retries ?? FETCH_RETRIES;

  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastErr = err;
      const kind = classifyFetchError(err);

      const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";
      console.error(`❌ fetch error [${kind}] (${attempt}/${retries}) ${url}${cause}`);

      if (attempt < retries && isRetryableError(kind)) {
        const backoff = jitter(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
        await sleep(backoff);
        continue;
      }
      break;
    }
  }

  throw lastErr;
}

async function readJsonSafely(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`响应不是有效 JSON（可能被 WAF/返回 HTML/空响应）：${snippet}`);
  }
}

// 格式化 Cookie（Set-Cookie -> Cookie header）
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// 并发限流
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

// GitHub Output（防止输出注入）
function setGitHubOutput(name, value) {
  const safe = String(value ?? "").replace(/\r/g, "");
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${safe}\nEOF\n`);
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
    // 429/5xx 可以提示更明确
    throw new Error(`登录接口 HTTP 错误 - ${response.status}`);
  }

  const responseJson = await readJsonSafely(response);

  if (responseJson?.ret !== 1) {
    throw new Error(`登录失败: ${responseJson?.msg ?? "未知错误"}`);
  }

  console.log(`${account.name}: ${responseJson.msg}`);

  // Node 20+ undici: headers.getSetCookie() 可用；否则退化
  const rawCookieArray =
    (typeof response.headers.getSetCookie === "function" && response.headers.getSetCookie()) ||
    [];

  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error("获取 Cookie 失败（响应头无 Set-Cookie）");
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const response = await fetchWithRetry(checkInUrl, {
    method: "POST",
    headers: { Cookie: account.cookie },
  });

  if (!response.ok) {
    throw new Error(`签到接口 HTTP 错误 - ${response.status}`);
  }

  const data = await readJsonSafely(response);
  const msg = data?.msg ?? "（无返回消息）";
  console.log(`${account.name}: ${msg}`);
  return msg;
}

async function processSingleAccount(account) {
  // 给每个账号一点随机延迟，降低同一时刻并发打点
  await sleep(jitter(ACCOUNT_JITTER_MS));

  const cooked = await logIn(account);
  const msg = await checkIn(cooked);
  return msg;
}

// ---------------------- 入口 ----------------------
async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) throw new Error("未配置账户信息（ACCOUNTS）。");
    accounts = JSON.parse(process.env.ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("账户信息为空或不是数组。");
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

  console.log(`共 ${accounts.length} 个账号，并发数：${CONCURRENCY}`);
  console.log(`HOST=${host}`);
  console.log(`CONNECT_TIMEOUT_MS=${CONNECT_TIMEOUT_MS}, HEADERS_TIMEOUT_MS=${HEADERS_TIMEOUT_MS}, FETCH_RETRIES=${FETCH_RETRIES}\n`);

  const results = await mapLimit(accounts, CONCURRENCY, async (account) => {
    try {
      const msg = await processSingleAccount(account);
      return { status: "fulfilled", value: msg };
    } catch (err) {
      const kind = classifyFetchError(err);
      const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";
      return {
        status: "rejected",
        reason: new Error(`[${kind}] ${err.message}${cause}`),
      };
    }
  });

  console.log("\n======== 签到结果 ========\n");

  let hasError = false;
  const resultLines = results.map((r, i) => {
    const accountName = accounts[i]?.name ?? `Account#${i + 1}`;
    const ok = r.status === "fulfilled";
    if (!ok) hasError = true;

    const icon = ok ? "✅" : "❌";
    const message = ok ? r.value : (r.reason?.message || String(r.reason));
    const line = `${accountName}: ${icon} ${message}`;

    ok ? console.log(line) : console.error(line);
    return line;
  });

  setGitHubOutput("result", resultLines.join("\n"));
  if (hasError) process.exit(1);
}

main();
